//! The explicit decision policy.
//!
//! Every action an agent can take has a named linear utility over the agent's own private
//! state (traits, trust, affect, stress, retained memory) and observable partner behaviour
//! (the partner's last action, the shared conflict intensity). Actions are sampled from a
//! softmax over those utilities. The policy never sees the treatment arm; the type of its
//! input, `AgentView`, has no field for it.
//!
//! For a married couple in a conflict the leave action is on the menu only when the couple has
//! gone without a shared warm memory long enough, or the conflict has escalated past a hard line
//! (`AgentView::leave_available`); a divorce in the agent's own past makes leaving easier
//! by the commitment shift its legacy carries (`AgentView::legacy_shift`).
//!
//! `spec()` renders the weights and formulas so the policy can be inspected without reading
//! this file.

use crate::config::{AssociationConfig, LegacyConfig, PolicyConfig};
use crate::memory::Loads;
use crate::population::{Personality, Preferences};
use crate::rng::{self, Rng};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Context {
    /// Together and not in an open conflict: invest in the relationship or not.
    Calm,
    /// An open conflict: repair, hold, escalate, withdraw or leave.
    Conflict,
    /// Separated: reunite, hold or finalise the split.
    Separated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Affiliate,
    Neutral,
    Repair,
    Hold,
    Escalate,
    Withdraw,
    Leave,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Affiliate => "affiliate",
            Action::Neutral => "neutral",
            Action::Repair => "repair",
            Action::Hold => "hold",
            Action::Escalate => "escalate",
            Action::Withdraw => "withdraw",
            Action::Leave => "leave",
        }
    }
}

/// Everything the policy is allowed to see. Private state is the agent's own; the partner
/// contributes only observable behaviour. There is deliberately no arm, no partner trust and
/// no partner memory here.
#[derive(Clone, Copy, Debug)]
pub struct AgentView<'a> {
    pub personality: &'a Personality,
    pub prefs: &'a Preferences,
    pub trust: f64,
    pub affect: f64,
    pub stress: f64,
    pub satisfaction: f64,
    pub loads: Loads,
    pub context: Context,
    pub dating: bool,
    pub conflict_intensity: f64,
    pub conflict_days: u32,
    pub separation_days: u32,
    pub partner_last: Option<Action>,
    /// Share of network neighbours who divorced during the simulation.
    pub divorced_friend_share: f64,
    /// Compatibility surplus of an outside encounter today (0 when none).
    pub outside_option: f64,
    /// Whether leaving is on the menu today (always for dating couples).
    pub leave_available: bool,
    /// The commitment shift of the agent's own sealed divorce, 0 without one.
    pub legacy_shift: f64,
    /// Bias on the repair (or reunite) utility from active shock effects on repair propensity: the
    /// sum of the logs of their multipliers, 0 without one. The policy scales it by its temperature,
    /// so a combined multiplier m multiplies the odds of choosing repair by exactly m.
    pub repair_bias: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub action: Action,
    pub utilities: Vec<(Action, f64)>,
    pub probabilities: Vec<f64>,
}

fn flag(cond: bool) -> f64 {
    if cond {
        1.0
    } else {
        0.0
    }
}

/// Utilities for every action available in the view's context, in a fixed order.
pub fn utilities(view: &AgentView, w: &PolicyConfig) -> Vec<(Action, f64)> {
    let p = view.personality;
    let q = view.prefs;
    let neg = view.loads.negative;
    let pos = view.loads.positive;
    let partner_repaired = flag(view.partner_last == Some(Action::Repair));
    let partner_escalated = flag(view.partner_last == Some(Action::Escalate));
    let avoidant = 1.0 - q.conflict_engagement;
    match view.context {
        Context::Calm => {
            let u_aff = w.aff_base
                + w.aff_extraversion * p.extraversion
                + w.aff_trust * view.trust
                + w.aff_affect * view.affect
                - w.aff_stress * view.stress
                + w.aff_closeness * q.closeness_pref;
            vec![(Action::Affiliate, u_aff), (Action::Neutral, 0.0)]
        }
        Context::Conflict => {
            let days = (view.conflict_days as f64).min(30.0);
            let u_rep = w.rep_base
                + w.rep_agree * p.agreeableness
                + w.rep_forgive * q.forgiveness
                + w.rep_trust * view.trust
                + w.rep_posmem * pos
                - w.rep_negmem * neg
                + w.rep_partner_repaired * partner_repaired
                - w.rep_intensity * view.conflict_intensity
                + w.rep_days * days
                + w.temperature * view.repair_bias;
            let u_hold =
                w.hold_base + w.hold_avoidant * avoidant + w.hold_consc * p.conscientiousness;
            let u_esc = w.esc_base
                + w.esc_neuro * p.neuroticism
                + w.esc_engage * q.conflict_engagement
                + w.esc_negmem * neg
                + w.esc_stress * view.stress
                - w.esc_trust * view.trust
                + w.esc_partner_escalated * partner_escalated
                - w.esc_affect * view.affect;
            let u_wd = w.wd_base
                + w.wd_avoidant * avoidant
                + w.wd_neuro * p.neuroticism
                + w.wd_intensity * view.conflict_intensity
                + w.wd_partner_escalated * partner_escalated;
            let mut out = vec![
                (Action::Repair, u_rep),
                (Action::Hold, u_hold),
                (Action::Escalate, u_esc),
                (Action::Withdraw, u_wd),
            ];
            if view.leave_available {
                out.push((Action::Leave, leave_utility(view, w, days)));
            }
            out
        }
        Context::Separated => {
            let days = (view.separation_days as f64).min(60.0);
            let u_rep = w.sep_reunite_base
                + w.rep_agree * p.agreeableness
                + w.rep_forgive * q.forgiveness
                + w.rep_trust * view.trust
                + w.rep_posmem * pos
                - w.rep_negmem * neg
                + w.rep_partner_repaired * partner_repaired
                + w.temperature * view.repair_bias;
            let u_hold = w.sep_hold_base + w.hold_avoidant * avoidant;
            let mut out = vec![(Action::Repair, u_rep), (Action::Hold, u_hold)];
            if view.leave_available {
                out.push((
                    Action::Leave,
                    w.sep_leave_base + leave_utility(view, w, days) - w.leave_base,
                ));
            }
            out
        }
    }
}

fn leave_utility(view: &AgentView, w: &PolicyConfig, days: f64) -> f64 {
    let q = view.prefs;
    w.leave_base - w.leave_commit * q.commitment - w.leave_trust * view.trust
        + w.leave_negmem * view.loads.negative
        - w.leave_posmem * view.loads.positive
        + w.leave_intensity * view.conflict_intensity
        + w.leave_days * days
        - w.leave_satisfaction * view.satisfaction
        + w.leave_network * view.divorced_friend_share
        + w.leave_outside_option * view.outside_option
        + w.leave_dating_bonus * flag(view.dating)
        + view.legacy_shift
}

/// Sample an action from the softmax over the context's utilities.
pub fn decide(view: &AgentView, w: &PolicyConfig, rng: &mut Rng) -> Decision {
    let utils = utilities(view, w);
    let values: Vec<f64> = utils.iter().map(|(_, u)| *u).collect();
    let (idx, probabilities) = rng::softmax_choice(rng, &values, w.temperature);
    Decision {
        action: utils[idx].0,
        utilities: utils,
        probabilities,
    }
}

/// Human-readable policy specification: the weights, the formulas they enter, and the rule that
/// puts leaving on the menu.
pub fn spec(
    w: &PolicyConfig,
    rule: &AssociationConfig,
    legacy: &LegacyConfig,
) -> serde_json::Value {
    serde_json::json!({
        "kind": "rule_based_softmax",
        "visibility": {
            "sees": ["own personality", "own preferences", "own trust", "own affect", "own stress", "own satisfaction",
                     "own retained negative and positive memory about the partner", "shared conflict intensity and duration",
                     "partner's last observable action", "share of divorced network neighbours", "today's outside option surplus",
                     "whether leaving is on the menu today", "own sealed divorce, if any",
                     "active shock effects on own repair propensity (repair_bias, the log of their combined multiplier)"],
            "never_sees": ["treatment arm", "partner's trust", "partner's memory", "partner's utilities"]
        },
        "sampling": {"rule": "softmax over utilities", "temperature": w.temperature},
        "contexts": {
            "calm": {
                "affiliate": "aff_base + aff_extraversion*extraversion + aff_trust*trust + aff_affect*affect - aff_stress*stress + aff_closeness*closeness_pref",
                "neutral": "0"
            },
            "conflict": {
                "repair": "rep_base + rep_agree*agreeableness + rep_forgive*forgiveness + rep_trust*trust + rep_posmem*pos_load - rep_negmem*neg_load + rep_partner_repaired*[partner repaired] - rep_intensity*intensity + rep_days*min(days,30) + temperature*repair_bias",
                "hold": "hold_base + hold_avoidant*(1-conflict_engagement) + hold_consc*conscientiousness",
                "escalate": "esc_base + esc_neuro*neuroticism + esc_engage*conflict_engagement + esc_negmem*neg_load + esc_stress*stress - esc_trust*trust + esc_partner_escalated*[partner escalated] - esc_affect*affect",
                "withdraw": "wd_base + wd_avoidant*(1-conflict_engagement) + wd_neuro*neuroticism + wd_intensity*intensity + wd_partner_escalated*[partner escalated]",
                "leave (when on the menu)": "leave_base - leave_commit*commitment - leave_trust*trust + leave_negmem*neg_load - leave_posmem*pos_load + leave_intensity*intensity + leave_days*min(days,30) - leave_satisfaction*satisfaction + leave_network*divorced_friend_share + leave_outside_option*outside_option + leave_dating_bonus*[dating] + legacy_shift"
            },
            "separated": {
                "repair (reunite)": "sep_reunite_base + rep_agree*agreeableness + rep_forgive*forgiveness + rep_trust*trust + rep_posmem*pos_load - rep_negmem*neg_load + rep_partner_repaired*[partner repaired] + temperature*repair_bias",
                "hold": "sep_hold_base + hold_avoidant*(1-conflict_engagement)",
                "leave (finalise, when on the menu)": "sep_leave_base + (conflict leave formula with min(days,60) and without leave_base)"
            }
        },
        "leave_rule": {
            "applies_to": ["married couples in a conflict"],
            "association_window_days": rule.window_days,
            "orphan_days_to_leave": rule.orphan_days_to_leave,
            "unlock_intensity": rule.unlock_intensity,
            "rule": "a couple is associated when both members stored a warm memory (positive or reconciliation) about each other within the window; a married couple in a conflict is offered leave once it has been orphaned for orphan_days_to_leave consecutive days, or when the conflict's intensity reaches unlock_intensity; dating couples and separated couples are not gated; 0 days turns the gate off"
        },
        "legacy": {
            "legacy_shift": legacy.commitment_shift,
            "rule": "an agent whose marriage ended in divorce during the run adds legacy_shift to its leave utility in every later relationship"
        },
        "weights": w
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PolicyConfig;

    fn view<'a>(p: &'a Personality, q: &'a Preferences, ctx: Context) -> AgentView<'a> {
        AgentView {
            personality: p,
            prefs: q,
            trust: 0.6,
            affect: 0.1,
            stress: 0.2,
            satisfaction: 0.6,
            loads: Loads {
                negative: 0.3,
                positive: 0.4,
            },
            context: ctx,
            dating: false,
            conflict_intensity: 0.4,
            conflict_days: 2,
            separation_days: 0,
            partner_last: None,
            divorced_friend_share: 0.0,
            outside_option: 0.0,
            leave_available: true,
            legacy_shift: 0.0,
            repair_bias: 0.0,
        }
    }

    fn mid() -> (Personality, Preferences) {
        (
            Personality {
                neuroticism: 0.5,
                agreeableness: 0.5,
                conscientiousness: 0.5,
                openness: 0.5,
                extraversion: 0.5,
            },
            Preferences {
                forgiveness: 0.5,
                commitment: 0.5,
                closeness_pref: 0.5,
                conflict_engagement: 0.5,
            },
        )
    }

    #[test]
    fn contexts_offer_the_right_actions() {
        let (p, q) = mid();
        let w = PolicyConfig::default();
        let calm: Vec<Action> = utilities(&view(&p, &q, Context::Calm), &w)
            .into_iter()
            .map(|(a, _)| a)
            .collect();
        assert_eq!(calm, vec![Action::Affiliate, Action::Neutral]);
        let conf: Vec<Action> = utilities(&view(&p, &q, Context::Conflict), &w)
            .into_iter()
            .map(|(a, _)| a)
            .collect();
        assert_eq!(
            conf,
            vec![
                Action::Repair,
                Action::Hold,
                Action::Escalate,
                Action::Withdraw,
                Action::Leave
            ]
        );
        let sep: Vec<Action> = utilities(&view(&p, &q, Context::Separated), &w)
            .into_iter()
            .map(|(a, _)| a)
            .collect();
        assert_eq!(sep, vec![Action::Repair, Action::Hold, Action::Leave]);
    }

    #[test]
    fn leave_is_off_the_menu_until_available_and_a_legacy_makes_it_easier() {
        let (p, q) = mid();
        let w = PolicyConfig::default();
        for ctx in [Context::Conflict, Context::Separated] {
            let mut v = view(&p, &q, ctx);
            v.leave_available = false;
            let acts: Vec<Action> = utilities(&v, &w).into_iter().map(|(a, _)| a).collect();
            assert!(!acts.contains(&Action::Leave), "{ctx:?}");
            let mut r = rng::stream(5, "t", 3);
            for _ in 0..200 {
                assert_ne!(decide(&v, &w, &mut r).action, Action::Leave);
            }
        }
        let base = view(&p, &q, Context::Conflict);
        let mut sealed = base;
        sealed.legacy_shift = 0.3;
        let u = |v: &AgentView| {
            utilities(v, &w)
                .into_iter()
                .find(|(a, _)| *a == Action::Leave)
                .unwrap()
                .1
        };
        assert!((u(&sealed) - u(&base) - 0.3).abs() < 1e-12);
    }

    #[test]
    fn more_grudge_lowers_repair_and_raises_leave() {
        let (p, q) = mid();
        let w = PolicyConfig::default();
        let mut low = view(&p, &q, Context::Conflict);
        low.loads = Loads {
            negative: 0.1,
            positive: 0.4,
        };
        let mut high = low;
        high.loads = Loads {
            negative: 2.0,
            positive: 0.4,
        };
        let ul = utilities(&low, &w);
        let uh = utilities(&high, &w);
        assert!(uh[0].1 < ul[0].1, "repair should fall with grudge");
        assert!(uh[4].1 > ul[4].1, "leave should rise with grudge");
        assert!(uh[2].1 > ul[2].1, "escalate should rise with grudge");
    }

    #[test]
    fn decision_is_deterministic_per_stream() {
        let (p, q) = mid();
        let w = PolicyConfig::default();
        let v = view(&p, &q, Context::Conflict);
        let mut r1 = rng::stream(5, "t", 1);
        let mut r2 = rng::stream(5, "t", 1);
        for _ in 0..50 {
            assert_eq!(decide(&v, &w, &mut r1), decide(&v, &w, &mut r2));
        }
    }

    #[test]
    fn probabilities_sum_to_one() {
        let (p, q) = mid();
        let w = PolicyConfig::default();
        let mut r = rng::stream(5, "t", 2);
        let d = decide(&view(&p, &q, Context::Conflict), &w, &mut r);
        let s: f64 = d.probabilities.iter().sum();
        assert!((s - 1.0).abs() < 1e-9);
        assert_eq!(d.probabilities.len(), 5);
    }

    #[test]
    fn a_repair_multiplier_multiplies_the_odds_of_repair_exactly() {
        let (p, q) = mid();
        let w = PolicyConfig::default();
        assert!(
            (w.temperature - 1.0).abs() > 0.1,
            "the test needs a temperature other than 1"
        );
        for ctx in [Context::Conflict, Context::Separated] {
            let base = view(&p, &q, ctx);
            for m in [0.1, 0.5, 2.0, 10.0] {
                let boosted = AgentView {
                    repair_bias: f64::ln(m),
                    ..base
                };
                let d0 = decide(&base, &w, &mut rng::stream(5, "t", 4));
                let d1 = decide(&boosted, &w, &mut rng::stream(5, "t", 4));
                let odds = |d: &Decision| d.probabilities[0] / (1.0 - d.probabilities[0]);
                assert_eq!(d0.utilities[0].0, Action::Repair);
                assert!(
                    ((odds(&d1) / odds(&d0)) - m).abs() < 1e-9 * m.max(1.0),
                    "{ctx:?} m={m}"
                );
            }
        }
    }

    #[test]
    fn spec_lists_every_weight() {
        let w = PolicyConfig::default();
        let s = spec(&w, &AssociationConfig::default(), &LegacyConfig::default());
        assert_eq!(s["leave_rule"]["orphan_days_to_leave"], 21);
        assert_eq!(s["legacy"]["legacy_shift"], 0.3);
        let weights = s["weights"].as_object().unwrap();
        assert!(weights.contains_key("rep_negmem"));
        assert!(weights.contains_key("leave_network"));
        assert_eq!(s["visibility"]["never_sees"][0], "treatment arm");
    }
}

//! The explicit decision policy.
//!
//! Every action an agent can take has a named linear utility over the agent's own private
//! state (traits, trust, affect, stress, retained memory) and observable partner behaviour
//! (the partner's last action, the shared conflict intensity). Actions are sampled from a
//! softmax over those utilities. The policy never sees the treatment arm; the type of its
//! input, `AgentView`, has no field for it.
//!
//! `spec()` renders the weights and formulas so the policy can be inspected without reading
//! this file.

use crate::config::PolicyConfig;
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
                + w.rep_days * days;
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
            let u_leave = leave_utility(view, w, days);
            vec![
                (Action::Repair, u_rep),
                (Action::Hold, u_hold),
                (Action::Escalate, u_esc),
                (Action::Withdraw, u_wd),
                (Action::Leave, u_leave),
            ]
        }
        Context::Separated => {
            let days = (view.separation_days as f64).min(60.0);
            let u_rep = w.sep_reunite_base
                + w.rep_agree * p.agreeableness
                + w.rep_forgive * q.forgiveness
                + w.rep_trust * view.trust
                + w.rep_posmem * pos
                - w.rep_negmem * neg
                + w.rep_partner_repaired * partner_repaired;
            let u_hold = w.sep_hold_base + w.hold_avoidant * avoidant;
            let u_leave = w.sep_leave_base + leave_utility(view, w, days) - w.leave_base;
            vec![
                (Action::Repair, u_rep),
                (Action::Hold, u_hold),
                (Action::Leave, u_leave),
            ]
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

/// Human-readable policy specification: the weights and the formulas they enter.
pub fn spec(w: &PolicyConfig) -> serde_json::Value {
    serde_json::json!({
        "kind": "rule_based_softmax",
        "visibility": {
            "sees": ["own personality", "own preferences", "own trust", "own affect", "own stress", "own satisfaction",
                     "own retained negative and positive memory about the partner", "shared conflict intensity and duration",
                     "partner's last observable action", "share of divorced network neighbours", "today's outside option surplus"],
            "never_sees": ["treatment arm", "partner's trust", "partner's memory", "partner's utilities"]
        },
        "sampling": {"rule": "softmax over utilities", "temperature": w.temperature},
        "contexts": {
            "calm": {
                "affiliate": "aff_base + aff_extraversion*extraversion + aff_trust*trust + aff_affect*affect - aff_stress*stress + aff_closeness*closeness_pref",
                "neutral": "0"
            },
            "conflict": {
                "repair": "rep_base + rep_agree*agreeableness + rep_forgive*forgiveness + rep_trust*trust + rep_posmem*pos_load - rep_negmem*neg_load + rep_partner_repaired*[partner repaired] - rep_intensity*intensity + rep_days*min(days,30)",
                "hold": "hold_base + hold_avoidant*(1-conflict_engagement) + hold_consc*conscientiousness",
                "escalate": "esc_base + esc_neuro*neuroticism + esc_engage*conflict_engagement + esc_negmem*neg_load + esc_stress*stress - esc_trust*trust + esc_partner_escalated*[partner escalated] - esc_affect*affect",
                "withdraw": "wd_base + wd_avoidant*(1-conflict_engagement) + wd_neuro*neuroticism + wd_intensity*intensity + wd_partner_escalated*[partner escalated]",
                "leave": "leave_base - leave_commit*commitment - leave_trust*trust + leave_negmem*neg_load - leave_posmem*pos_load + leave_intensity*intensity + leave_days*min(days,30) - leave_satisfaction*satisfaction + leave_network*divorced_friend_share + leave_outside_option*outside_option + leave_dating_bonus*[dating]"
            },
            "separated": {
                "repair (reunite)": "sep_reunite_base + rep_agree*agreeableness + rep_forgive*forgiveness + rep_trust*trust + rep_posmem*pos_load - rep_negmem*neg_load + rep_partner_repaired*[partner repaired]",
                "hold": "sep_hold_base + hold_avoidant*(1-conflict_engagement)",
                "leave (finalise)": "sep_leave_base + (conflict leave formula with min(days,60) and without leave_base)"
            }
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
    fn spec_lists_every_weight() {
        let w = PolicyConfig::default();
        let s = spec(&w);
        let weights = s["weights"].as_object().unwrap();
        assert!(weights.contains_key("rep_negmem"));
        assert!(weights.contains_key("leave_network"));
        assert_eq!(s["visibility"]["never_sees"][0], "treatment arm");
    }
}

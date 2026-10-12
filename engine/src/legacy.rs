//! What a divorce leaves behind.
//!
//! When a marriage ends in divorce each member seals it into a `Seal`: how it ended, how many
//! conflicts it had and how many were reconciled, the trust and memory loads it ended with, and
//! two consequences for later relationships. Leaving is easier by `commitment_shift` (weaker
//! commitment to marriage, the channel Amato and DeBoer (2001) find for the intergenerational
//! transmission of divorce), and the next relationship starts from a trust prior pulled toward
//! the trust this marriage ended with. The match quality of the ended marriage is not copied
//! here: the marriage market's anchor (`Market::last_compat`) already holds it.
//!
//! The re-mint rule: a seal is minted from the marriage that just ended and nothing else.
//! `mint` takes no earlier seal, so a second divorce replaces the first seal instead of
//! compounding it, and a lossy summary can never be summarised again.

use crate::config::LegacyConfig;
use crate::memory::Loads;
use bevy_ecs::prelude::Component;

/// Who ended the marriage, from this member's side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndedBy {
    /// This member chose to leave.
    SelfLeft,
    /// The partner chose to leave.
    PartnerLeft,
    /// Nobody chose; the separation ran out.
    Time,
}

impl EndedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            EndedBy::SelfLeft => "self",
            EndedBy::PartnerLeft => "partner",
            EndedBy::Time => "time",
        }
    }
}

/// The sealed record of one marriage that ended in divorce.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Seal {
    pub couple_id: u64,
    pub partner_id: u64,
    pub day: i32,
    pub ended_by: EndedBy,
    pub conflicts: u32,
    pub reconciled: u32,
    pub final_trust: f64,
    pub final_loads: Loads,
    /// Added to the leave utility in every later relationship.
    pub commitment_shift: f64,
    /// Starting trust of the next relationship.
    pub trust_prior: f64,
}

/// The agent's most recent seal, if it has divorced during the run.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Legacy(pub Option<Seal>);

/// The live facts of the marriage at the moment of divorce, from one member's side.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ending {
    pub couple_id: u64,
    pub partner_id: u64,
    pub day: i32,
    pub ended_by: EndedBy,
    pub conflicts: u32,
    pub reconciled: u32,
    pub final_trust: f64,
    pub final_loads: Loads,
    pub base_trust: f64,
}

/// Mint a seal from the marriage that just ended. There is deliberately no argument for an
/// earlier seal.
pub fn mint(cfg: &LegacyConfig, e: &Ending) -> Seal {
    let w = cfg.trust_prior_weight;
    let trust_prior = ((1.0 - w) * e.base_trust + w * e.final_trust).clamp(0.05, 0.95);
    Seal {
        couple_id: e.couple_id,
        partner_id: e.partner_id,
        day: e.day,
        ended_by: e.ended_by,
        conflicts: e.conflicts,
        reconciled: e.reconciled,
        final_trust: e.final_trust,
        final_loads: e.final_loads,
        commitment_shift: cfg.commitment_shift,
        trust_prior,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ending(final_trust: f64) -> Ending {
        Ending {
            couple_id: 3,
            partner_id: 7,
            day: 200,
            ended_by: EndedBy::PartnerLeft,
            conflicts: 9,
            reconciled: 4,
            final_trust,
            final_loads: Loads {
                negative: 1.1,
                positive: 0.2,
            },
            base_trust: 0.7,
        }
    }

    #[test]
    fn trust_prior_pulls_toward_the_final_trust_and_stays_bounded() {
        let cfg = LegacyConfig {
            commitment_shift: 0.3,
            trust_prior_weight: 0.5,
        };
        let s = mint(&cfg, &ending(0.1));
        assert!((s.trust_prior - 0.4).abs() < 1e-12);
        assert_eq!(s.commitment_shift, 0.3);
        assert_eq!((s.conflicts, s.reconciled), (9, 4));
        let none = LegacyConfig {
            commitment_shift: 0.0,
            trust_prior_weight: 0.0,
        };
        assert!((mint(&none, &ending(0.1)).trust_prior - 0.7).abs() < 1e-12);
        let full = LegacyConfig {
            commitment_shift: 0.0,
            trust_prior_weight: 1.0,
        };
        assert_eq!(mint(&full, &ending(0.0)).trust_prior, 0.05);
    }

    #[test]
    fn a_second_seal_depends_only_on_its_own_marriage() {
        // The re-mint rule: whatever the agent carried before, the new seal is the same.
        let cfg = LegacyConfig::default();
        let first = mint(&cfg, &ending(0.05));
        let mut carried = Legacy(Some(first));
        let second_ending = Ending {
            couple_id: 1200,
            partner_id: 99,
            day: 330,
            ..ending(0.6)
        };
        carried.0 = Some(mint(&cfg, &second_ending));
        let fresh = Legacy(Some(mint(&cfg, &second_ending)));
        assert_eq!(carried.0, fresh.0);
        assert_eq!(carried.0.unwrap().couple_id, 1200);
    }
}

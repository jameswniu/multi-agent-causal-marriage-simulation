//! Episodic memory with configurable exponential decay.
//!
//! Each episode has a kind, an intensity (its importance) and the day it happened. Its
//! current strength is `intensity * 0.5 ^ (age / half_life)` where the half-life depends on
//! the episode's class (conflict, repair, positive). The retention intervention changes the
//! agent's half-lives and nothing else. Episodes below a threshold are forgotten, and at
//! most `capacity` episodes are kept (the strongest survive).

use crate::config::MemoryParams;
use bevy_ecs::prelude::Component;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpisodeKind {
    Conflict,
    Escalation,
    Withdrawal,
    Rejection,
    Separation,
    Divorce,
    Reconciliation,
    Positive,
    Disappointment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryClass {
    Conflict,
    Repair,
    Positive,
}

impl EpisodeKind {
    pub fn class(self) -> MemoryClass {
        match self {
            EpisodeKind::Conflict
            | EpisodeKind::Escalation
            | EpisodeKind::Withdrawal
            | EpisodeKind::Rejection
            | EpisodeKind::Separation
            | EpisodeKind::Divorce
            | EpisodeKind::Disappointment => MemoryClass::Conflict,
            EpisodeKind::Reconciliation => MemoryClass::Repair,
            EpisodeKind::Positive => MemoryClass::Positive,
        }
    }

    /// Signed weight of the episode: negative kinds pull trust down, positive kinds lift it.
    pub fn valence(self) -> f64 {
        match self {
            EpisodeKind::Conflict
            | EpisodeKind::Escalation
            | EpisodeKind::Separation
            | EpisodeKind::Divorce => -1.0,
            EpisodeKind::Withdrawal | EpisodeKind::Rejection | EpisodeKind::Disappointment => -0.6,
            EpisodeKind::Reconciliation | EpisodeKind::Positive => 1.0,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EpisodeKind::Conflict => "conflict",
            EpisodeKind::Escalation => "escalation",
            EpisodeKind::Withdrawal => "withdrawal",
            EpisodeKind::Rejection => "rejection",
            EpisodeKind::Separation => "separation",
            EpisodeKind::Divorce => "divorce",
            EpisodeKind::Reconciliation => "reconciliation",
            EpisodeKind::Positive => "positive",
            EpisodeKind::Disappointment => "disappointment",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Episode {
    pub day: i32,
    pub kind: EpisodeKind,
    pub intensity: f64,
    pub partner: u64,
}

/// Outcome of `Memory::amplify`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Amplified {
    /// No episode matched, so a new one was stored.
    Stored,
    /// The matching episode's intensity went up.
    Raised,
    /// The matching episode already had at least this intensity.
    Unchanged,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Loads {
    pub negative: f64,
    pub positive: f64,
}

#[derive(Clone, Debug, Component)]
pub struct Memory {
    pub episodes: Vec<Episode>,
    pub params: MemoryParams,
}

impl Memory {
    pub fn new(params: MemoryParams, initial: Vec<Episode>) -> Self {
        Self {
            episodes: initial,
            params,
        }
    }

    pub fn half_life(&self, class: MemoryClass) -> f64 {
        match class {
            MemoryClass::Conflict => self.params.conflict_half_life_days,
            MemoryClass::Repair => self.params.repair_half_life_days,
            MemoryClass::Positive => self.params.positive_half_life_days,
        }
    }

    pub fn record(&mut self, ep: Episode) {
        self.episodes.push(ep);
    }

    /// Current strength of one episode.
    pub fn strength(&self, ep: &Episode, today: i32) -> f64 {
        let age = (today - ep.day).max(0) as f64;
        ep.intensity * 0.5f64.powf(age / self.half_life(ep.kind.class()))
    }

    /// Raw retained negative and positive load about one partner (sums of strengths).
    pub fn raw_loads(&self, today: i32, partner: u64) -> Loads {
        let mut out = Loads::default();
        for ep in &self.episodes {
            if ep.partner != partner {
                continue;
            }
            let s = self.strength(ep, today);
            let v = ep.kind.valence();
            if v < 0.0 {
                out.negative += s * (-v);
            } else {
                out.positive += s * v;
            }
        }
        out
    }

    /// Retained loads with diminishing returns: `s * (1 - exp(-raw / s))`, bounded by the
    /// saturation `s`. This is what dynamics and the policy consume.
    pub fn loads(&self, today: i32, partner: u64) -> Loads {
        let raw = self.raw_loads(today, partner);
        let s = self.params.load_saturation;
        Loads {
            negative: s * (1.0 - (-raw.negative / s).exp()),
            positive: s * (1.0 - (-raw.positive / s).exp()),
        }
    }

    /// Raise the intensity of an existing episode (the memory of one fight gets worse as
    /// it escalates) instead of stacking a new episode per escalation day.
    pub fn amplify(
        &mut self,
        day: i32,
        kind: EpisodeKind,
        partner: u64,
        intensity: f64,
    ) -> Amplified {
        if let Some(ep) = self
            .episodes
            .iter_mut()
            .find(|e| e.day == day && e.kind == kind && e.partner == partner)
        {
            if intensity > ep.intensity {
                ep.intensity = intensity;
                Amplified::Raised
            } else {
                Amplified::Unchanged
            }
        } else {
            self.episodes.push(Episode {
                day,
                kind,
                intensity,
                partner,
            });
            Amplified::Stored
        }
    }

    /// Forget episodes below `threshold` and keep at most `capacity` of the strongest.
    pub fn prune(&mut self, today: i32, threshold: f64, capacity: usize) -> usize {
        let before = self.episodes.len();
        let mut scored: Vec<(f64, Episode)> = self
            .episodes
            .iter()
            .map(|e| (self.strength(e, today), *e))
            .filter(|(s, _)| *s >= threshold)
            .collect();
        if scored.len() > capacity {
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.1.day.cmp(&b.1.day))
            });
            scored.truncate(capacity);
        }
        let mut kept: Vec<Episode> = scored.into_iter().map(|(_, e)| e).collect();
        kept.sort_by_key(|e| e.day);
        self.episodes = kept;
        before - self.episodes.len()
    }

    pub fn len(&self) -> usize {
        self.episodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.episodes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(conflict: f64) -> MemoryParams {
        MemoryParams {
            conflict_half_life_days: conflict,
            repair_half_life_days: 30.0,
            positive_half_life_days: 20.0,
            load_saturation: 1e9,
        }
    }

    #[test]
    fn strength_halves_every_half_life() {
        let m = Memory::new(params(10.0), vec![]);
        let ep = Episode {
            day: 0,
            kind: EpisodeKind::Conflict,
            intensity: 0.8,
            partner: 1,
        };
        assert!((m.strength(&ep, 0) - 0.8).abs() < 1e-12);
        assert!((m.strength(&ep, 10) - 0.4).abs() < 1e-12);
        assert!((m.strength(&ep, 20) - 0.2).abs() < 1e-12);
    }

    #[test]
    fn longer_half_life_retains_more() {
        let ep = Episode {
            day: 0,
            kind: EpisodeKind::Conflict,
            intensity: 1.0,
            partner: 1,
        };
        let short = Memory::new(params(14.0), vec![ep]);
        let long = Memory::new(params(90.0), vec![ep]);
        assert!(long.loads(60, 1).negative > short.loads(60, 1).negative);
        // Positive memories are untouched by the conflict half-life.
        let pos = Episode {
            day: 0,
            kind: EpisodeKind::Positive,
            intensity: 1.0,
            partner: 1,
        };
        let short = Memory::new(params(14.0), vec![pos]);
        let long = Memory::new(params(90.0), vec![pos]);
        assert_eq!(long.loads(60, 1).positive, short.loads(60, 1).positive);
    }

    #[test]
    fn loads_are_partner_specific() {
        let m = Memory::new(
            params(10.0),
            vec![
                Episode {
                    day: 0,
                    kind: EpisodeKind::Conflict,
                    intensity: 1.0,
                    partner: 1,
                },
                Episode {
                    day: 0,
                    kind: EpisodeKind::Conflict,
                    intensity: 1.0,
                    partner: 2,
                },
            ],
        );
        assert!((m.raw_loads(0, 1).negative - 1.0).abs() < 1e-12);
        assert!((m.raw_loads(0, 2).negative - 1.0).abs() < 1e-12);
        assert_eq!(m.loads(0, 3).negative, 0.0);
    }

    #[test]
    fn saturation_bounds_effective_load() {
        let mut p = params(1000.0);
        p.load_saturation = 1.0;
        let eps: Vec<Episode> = (0..50)
            .map(|d| Episode {
                day: d,
                kind: EpisodeKind::Conflict,
                intensity: 1.0,
                partner: 1,
            })
            .collect();
        let m = Memory::new(p, eps);
        let raw = m.raw_loads(50, 1).negative;
        let eff = m.loads(50, 1).negative;
        assert!(raw > 40.0);
        assert!(eff <= 1.0 && eff > 0.99, "eff {eff}");
    }

    #[test]
    fn amplify_raises_existing_episode_instead_of_stacking() {
        let mut m = Memory::new(
            params(10.0),
            vec![Episode {
                day: 3,
                kind: EpisodeKind::Conflict,
                intensity: 0.4,
                partner: 1,
            }],
        );
        assert_eq!(
            m.amplify(3, EpisodeKind::Conflict, 1, 0.7),
            Amplified::Raised
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m.episodes[0].intensity, 0.7);
        assert_eq!(
            m.amplify(3, EpisodeKind::Conflict, 1, 0.5),
            Amplified::Unchanged
        );
        assert_eq!(m.episodes[0].intensity, 0.7);
        assert_eq!(
            m.amplify(4, EpisodeKind::Conflict, 1, 0.5),
            Amplified::Stored
        );
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn prune_forgets_weak_and_caps_capacity() {
        let mut m = Memory::new(params(1.0), vec![]);
        for d in 0..50 {
            m.record(Episode {
                day: d,
                kind: EpisodeKind::Conflict,
                intensity: 1.0,
                partner: 1,
            });
        }
        let removed = m.prune(50, 0.01, 1000);
        // With a 1-day half-life anything older than ~7 days is below 0.01.
        assert!(removed > 40, "removed {removed}");
        assert!(m.episodes.iter().all(|e| e.day >= 43));
        let mut m2 = Memory::new(params(1000.0), vec![]);
        for d in 0..30 {
            m2.record(Episode {
                day: d,
                kind: EpisodeKind::Positive,
                intensity: 0.1 * (d as f64 + 1.0),
                partner: 1,
            });
        }
        m2.prune(30, 0.0, 5);
        assert_eq!(m2.len(), 5);
        assert!(m2.episodes.iter().all(|e| e.day >= 25));
    }
}

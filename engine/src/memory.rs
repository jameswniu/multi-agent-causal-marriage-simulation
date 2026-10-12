//! Episodic memory with configurable exponential decay.
//!
//! Each episode has a kind, an intensity (its importance) and the day it happened. It keeps
//! its full intensity for a short plateau, then fades: its current strength is
//! `intensity * 0.5 ^ (max(0, age - plateau) / half_life)`, where the half-life depends on the
//! episode's class (conflict, repair, positive). The retention intervention changes the agent's
//! half-lives and nothing else; the plateau, consolidation and the separation freeze are rules
//! every memory follows whatever the arm. Episodes below a threshold are forgotten, and at most
//! `capacity` episodes are kept (the strongest survive).
//!
//! Two housekeeping rules shape what is kept without changing what it weighs:
//! * consolidation merges many old episodes of one class about one partner into a single
//!   standing episode whose strength equals their summed strength today, and, because they share
//!   one half-life, on every later day too;
//! * a freeze holds every episode about one partner at its strength on the freeze day (no decay,
//!   no pruning) until it is lifted, after which their clock resumes where it stopped.

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
    /// Many conflict-class episodes merged into one standing grievance.
    Grievance,
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
            | EpisodeKind::Disappointment
            | EpisodeKind::Grievance => MemoryClass::Conflict,
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
            | EpisodeKind::Divorce
            | EpisodeKind::Grievance => -1.0,
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
            EpisodeKind::Grievance => "grievance",
        }
    }

    /// The kind a merged run of this class becomes: one standing grievance, reconciliation or
    /// positive memory. Each has valence magnitude 1, so the merged intensity carries the load.
    pub fn standing(class: MemoryClass) -> EpisodeKind {
        match class {
            MemoryClass::Conflict => EpisodeKind::Grievance,
            MemoryClass::Repair => EpisodeKind::Reconciliation,
            MemoryClass::Positive => EpisodeKind::Positive,
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

/// One merge performed by `Memory::consolidate`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Consolidation {
    /// The standing episode that replaced the merged ones.
    pub episode: Episode,
    /// How many episodes it replaced.
    pub merged: usize,
}

#[derive(Clone, Debug, Component)]
pub struct Memory {
    pub episodes: Vec<Episode>,
    pub params: MemoryParams,
    /// Days of full intensity before decay starts (a rule shared by every agent).
    pub plateau_days: f64,
    /// Partner whose episodes are frozen, and the day the freeze began.
    pub frozen: Option<(u64, i32)>,
}

impl Memory {
    pub fn new(params: MemoryParams, initial: Vec<Episode>) -> Self {
        Self {
            episodes: initial,
            params,
            plateau_days: 0.0,
            frozen: None,
        }
    }

    /// The same memory with a freshness plateau.
    pub fn with_plateau(mut self, plateau_days: f64) -> Self {
        self.plateau_days = plateau_days.max(0.0);
        self
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

    /// The day an episode's clock reads: today, or for a frozen partner the freeze day (an
    /// episode stored during the freeze is held at its own day, full strength).
    fn clock(&self, ep: &Episode, today: i32) -> i32 {
        match self.frozen {
            Some((p, since)) if p == ep.partner => since.max(ep.day).min(today.max(ep.day)),
            _ => today,
        }
    }

    /// Current strength of one episode: full for the plateau, then halving every half-life.
    pub fn strength(&self, ep: &Episode, today: i32) -> f64 {
        let age = (self.clock(ep, today) - ep.day).max(0) as f64;
        let decaying = (age - self.plateau_days).max(0.0);
        ep.intensity * 0.5f64.powf(decaying / self.half_life(ep.kind.class()))
    }

    /// Hold every episode about `partner` at today's strength until `unfreeze`.
    pub fn freeze(&mut self, partner: u64, today: i32) {
        if self.frozen.is_none() {
            self.frozen = Some((partner, today));
        }
    }

    /// Lift the freeze: each frozen episode's day moves forward by the time it spent frozen, so
    /// its age resumes exactly where it stopped.
    pub fn unfreeze(&mut self, today: i32) {
        let Some((partner, since)) = self.frozen.take() else {
            return;
        };
        for ep in self.episodes.iter_mut().filter(|e| e.partner == partner) {
            let frozen_from = since.max(ep.day);
            ep.day += (today - frozen_from).max(0);
        }
        self.episodes.sort_by_key(|e| e.day);
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen.is_some()
    }

    /// Whether a warm memory (positive or reconciliation) about `partner` was stored on or after
    /// `since`. This reads when it was stored, not how strong it still is.
    pub fn warm_since(&self, partner: u64, since: i32) -> bool {
        self.episodes
            .iter()
            .any(|e| e.partner == partner && e.day >= since && e.kind.valence() > 0.0)
    }

    /// Merge old episodes about `partner`: when more than `after` episodes of one class are
    /// older than the plateau, they become one standing episode dated at the latest of them whose
    /// intensity makes its strength today equal their summed, valence-weighted strength. They
    /// share a half-life and are all past the plateau, so the merged episode also matches their
    /// sum on every later day. `keep` (a day and kind) is never merged: the episode of a conflict
    /// that is still open, which escalation may still raise. A frozen partner is left alone.
    pub fn consolidate(
        &mut self,
        today: i32,
        partner: u64,
        after: usize,
        keep: Option<(i32, EpisodeKind)>,
    ) -> Vec<Consolidation> {
        let mut out = Vec::new();
        if after == 0 || self.frozen.map(|(p, _)| p) == Some(partner) {
            return out;
        }
        for class in [
            MemoryClass::Conflict,
            MemoryClass::Repair,
            MemoryClass::Positive,
        ] {
            let eligible = |e: &Episode| {
                e.partner == partner
                    && e.kind.class() == class
                    && ((today - e.day) as f64) > self.plateau_days
                    && keep != Some((e.day, e.kind))
            };
            let n = self.episodes.iter().filter(|e| eligible(e)).count();
            if n <= after {
                continue;
            }
            let mut load = 0.0;
            let mut latest = i32::MIN;
            for e in self.episodes.iter().filter(|e| eligible(e)) {
                load += self.strength(e, today) * e.kind.valence().abs();
                latest = latest.max(e.day);
            }
            let kind = EpisodeKind::standing(class);
            let decaying = ((today - latest) as f64 - self.plateau_days).max(0.0);
            let intensity = load / 0.5f64.powf(decaying / self.half_life(class));
            let merged = Episode {
                day: latest,
                kind,
                intensity,
                partner,
            };
            self.episodes.retain(|e| !eligible(e));
            self.episodes.push(merged);
            self.episodes.sort_by_key(|e| e.day);
            out.push(Consolidation {
                episode: merged,
                merged: n,
            });
        }
        out
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

    /// Forget episodes below `threshold` and keep at most `capacity` of the strongest. Episodes
    /// about a frozen partner are kept as they are and count against the capacity.
    pub fn prune(&mut self, today: i32, threshold: f64, capacity: usize) -> usize {
        let before = self.episodes.len();
        let frozen_partner = self.frozen.map(|(p, _)| p);
        let held: Vec<Episode> = self
            .episodes
            .iter()
            .filter(|e| Some(e.partner) == frozen_partner)
            .copied()
            .collect();
        let capacity = capacity.saturating_sub(held.len());
        let mut scored: Vec<(f64, Episode)> = self
            .episodes
            .iter()
            .filter(|e| Some(e.partner) != frozen_partner)
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
        kept.extend(held);
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

    fn ep(day: i32, kind: EpisodeKind, intensity: f64, partner: u64) -> Episode {
        Episode {
            day,
            kind,
            intensity,
            partner,
        }
    }

    #[test]
    fn plateau_holds_full_intensity_then_decays_from_its_end() {
        let m = Memory::new(params(10.0), vec![]).with_plateau(7.0);
        let e = ep(0, EpisodeKind::Conflict, 0.8, 1);
        assert_eq!(m.strength(&e, 0), 0.8);
        assert_eq!(m.strength(&e, 7), 0.8);
        assert!((m.strength(&e, 17) - 0.4).abs() < 1e-12);
        // No plateau is the old rule.
        let old = Memory::new(params(10.0), vec![]);
        assert!((old.strength(&e, 10) - 0.4).abs() < 1e-12);
    }

    #[test]
    fn consolidation_keeps_the_load_today_and_on_every_later_day() {
        let mut m = Memory::new(params(30.0), vec![]).with_plateau(7.0);
        for d in 0..12 {
            let kind = if d % 3 == 0 {
                EpisodeKind::Withdrawal
            } else {
                EpisodeKind::Conflict
            };
            m.record(ep(d, kind, 0.2 + 0.05 * d as f64, 1));
        }
        m.record(ep(5, EpisodeKind::Positive, 0.3, 1));
        m.record(ep(3, EpisodeKind::Conflict, 0.9, 2));
        let today = 40;
        let before: Vec<Loads> = (today..today + 120)
            .step_by(13)
            .map(|t| m.raw_loads(t, 1))
            .collect();
        let other = m.raw_loads(today, 2);
        let done = m.consolidate(today, 1, 8, None);
        assert_eq!(done.len(), 1, "only the conflict class has more than 8");
        assert_eq!(done[0].merged, 12);
        assert_eq!(done[0].episode.kind, EpisodeKind::Grievance);
        assert_eq!(
            done[0].episode.day, 11,
            "dated at the latest merged episode"
        );
        let after: Vec<Loads> = (today..today + 120)
            .step_by(13)
            .map(|t| m.raw_loads(t, 1))
            .collect();
        for (b, a) in before.iter().zip(&after) {
            assert!((b.negative - a.negative).abs() < 1e-9, "{b:?} vs {a:?}");
            assert_eq!(b.positive, a.positive);
        }
        assert_eq!(m.raw_loads(today, 2), other, "another partner is untouched");
        assert_eq!(m.len(), 3);
        // Nothing more to merge, and 8 or fewer never merge.
        assert!(m.consolidate(today, 1, 8, None).is_empty());
    }

    #[test]
    fn consolidation_skips_young_episodes_the_open_conflict_and_a_frozen_partner() {
        let mut m = Memory::new(params(30.0), vec![]).with_plateau(7.0);
        for d in 0..10 {
            m.record(ep(d, EpisodeKind::Conflict, 0.3, 1));
        }
        // Day 1's conflict is still open; nine others remain, more than 8.
        let done = m.consolidate(20, 1, 8, Some((1, EpisodeKind::Conflict)));
        assert_eq!(done[0].merged, 9);
        assert!(m
            .episodes
            .iter()
            .any(|e| e.day == 1 && e.kind == EpisodeKind::Conflict));
        // Episodes inside the plateau are too young to merge.
        let mut young = Memory::new(params(30.0), vec![]).with_plateau(7.0);
        for d in 0..10 {
            young.record(ep(d, EpisodeKind::Conflict, 0.3, 1));
        }
        assert!(young.consolidate(9, 1, 8, None).is_empty());
        young.freeze(1, 9);
        assert!(young.consolidate(40, 1, 8, None).is_empty());
        assert_eq!(young.len(), 10);
    }

    #[test]
    fn freeze_holds_strength_and_unfreeze_resumes_the_clock() {
        let mut m = Memory::new(params(10.0), vec![]).with_plateau(0.0);
        m.record(ep(0, EpisodeKind::Conflict, 1.0, 1));
        m.record(ep(0, EpisodeKind::Conflict, 1.0, 2));
        m.freeze(1, 10);
        let held = m.raw_loads(10, 1).negative;
        assert!((held - 0.5).abs() < 1e-12);
        assert_eq!(m.raw_loads(50, 1).negative, held, "no decay while frozen");
        assert!(
            m.raw_loads(50, 2).negative < 0.1,
            "another partner still decays"
        );
        m.record(ep(30, EpisodeKind::Rejection, 0.5, 1));
        // A frozen partner's episodes survive pruning whatever their strength.
        m.prune(50, 0.9, 1000);
        assert_eq!(m.episodes.iter().filter(|e| e.partner == 1).count(), 2);
        m.unfreeze(60);
        assert!(!m.is_frozen());
        // The old episode resumes at age 10; the one stored while frozen starts at age 0.
        let resumed = m.raw_loads(70, 1).negative;
        let expected = 0.25 + 0.6 * 0.5 * 0.5;
        assert!(
            (resumed - expected).abs() < 1e-12,
            "{resumed} vs {expected}"
        );
    }

    #[test]
    fn warm_since_reads_storage_day_and_valence() {
        let m = Memory::new(
            params(10.0),
            vec![
                ep(5, EpisodeKind::Positive, 0.1, 1),
                ep(9, EpisodeKind::Conflict, 0.5, 1),
                ep(8, EpisodeKind::Reconciliation, 0.5, 2),
            ],
        );
        assert!(m.warm_since(1, 5));
        assert!(!m.warm_since(1, 6));
        assert!(m.warm_since(2, 8));
        assert!(!m.warm_since(3, 0));
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

//! Bevy ECS components and resources. Agents and couples are entities; the daily tick is a
//! schedule of systems over them.

use crate::config::{Arm, SimConfig};
use crate::log::Logs;
use crate::policy::Action;
use crate::population::{History, Personality, Preferences};
use crate::rng::Rng;
use bevy_ecs::prelude::*;

// ---------- agent components ----------

#[derive(Component, Clone, Copy, Debug)]
pub struct AgentId(pub u64);

#[derive(Component, Clone, Debug)]
pub struct Traits {
    pub personality: Personality,
    pub prefs: Preferences,
    pub history: History,
    pub base_trust: f64,
    pub relax_rate: f64,
}

#[derive(Component, Clone, Copy, Debug)]
pub struct Affect {
    pub trust: f64,
    pub affect: f64,
    pub stress: f64,
    pub satisfaction: f64,
}

#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Bond {
    pub couple: Option<Entity>,
    pub partner: Option<Entity>,
    pub partner_id: Option<u64>,
}

/// Marriage-market state: an acceptance threshold that anchors on the agent's past partners and
/// relaxes while they stay single.
#[derive(Component, Clone, Copy, Debug)]
pub struct Market {
    pub single_since: Option<i32>,
    pub threshold: f64,
    pub last_compat: Option<f64>,
    pub divorces_in_sim: u32,
    pub marriages_in_sim: u32,
}

#[derive(Component)]
pub struct AgentRng(pub Rng);

#[derive(Component, Clone, Copy, Debug, Default)]
pub struct LastAction(pub Option<Action>);

/// Per-agent effects of active shocks. Each entry carries its own expiry day (inclusive), so
/// overlapping shocks of one kind compose instead of overwriting each other.
#[derive(Component, Clone, Debug, Default)]
pub struct Modifiers {
    /// (daily extra stress, last day)
    pub extra_stress: Vec<(f64, i32)>,
    /// (outside encounter probability, compatibility bonus, last day)
    pub outside: Vec<(f64, f64, i32)>,
    /// (multiplier on the odds of choosing repair, last day)
    pub repair_mult: Vec<(f64, i32)>,
}

impl Modifiers {
    /// Sum of every active extra-stress contribution.
    pub fn extra_stress(&self, day: i32) -> f64 {
        self.extra_stress
            .iter()
            .filter(|(_, until)| day <= *until)
            .map(|(x, _)| *x)
            .sum()
    }

    /// The active outside-option override with the strongest probability, if any.
    pub fn outside(&self, day: i32) -> Option<(f64, f64)> {
        self.outside
            .iter()
            .filter(|(_, _, until)| day <= *until)
            .map(|(p, b, _)| (*p, *b))
            .fold(None, |best, cur| match best {
                Some((bp, _)) if bp >= cur.0 => best,
                _ => Some(cur),
            })
    }

    /// Additive bias on the repair utility from every active repair multiplier: the sum of their
    /// natural logs, so a multiplier m scales the odds of choosing repair by m. Exactly 0 when
    /// none is active.
    pub fn repair_bias(&self, day: i32) -> f64 {
        self.repair_mult
            .iter()
            .filter(|(_, until)| day <= *until)
            .map(|(m, _)| m.ln())
            .sum()
    }

    /// Drop entries that can no longer apply.
    pub fn expire(&mut self, day: i32) {
        self.extra_stress.retain(|(_, until)| day <= *until);
        self.outside.retain(|(_, _, until)| day <= *until);
        self.repair_mult.retain(|(_, until)| day <= *until);
    }
}

/// Per-couple effects of active shocks: multipliers on the couple's daily conflict onset hazard.
#[derive(Component, Clone, Debug, Default)]
pub struct CoupleModifiers {
    /// (multiplier, last day)
    pub onset_mult: Vec<(f64, i32)>,
}

impl CoupleModifiers {
    /// Product of every active onset multiplier, exactly 1 when none is active.
    pub fn onset_mult(&self, day: i32) -> f64 {
        self.onset_mult
            .iter()
            .filter(|(_, until)| day <= *until)
            .map(|(m, _)| *m)
            .product()
    }
}

#[derive(Component, Clone, Debug, Default)]
pub struct Social {
    pub neighbours: Vec<Entity>,
}

// ---------- couple components ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Initial,
    Remarriage,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Initial => "initial",
            Origin::Remarriage => "remarriage",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelState {
    Dating,
    Married,
    Separated,
    Divorced,
    BrokenUp,
}

impl RelState {
    pub fn as_str(self) -> &'static str {
        match self {
            RelState::Dating => "dating",
            RelState::Married => "married",
            RelState::Separated => "separated",
            RelState::Divorced => "divorced",
            RelState::BrokenUp => "broken_up",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            RelState::Dating | RelState::Married | RelState::Separated
        )
    }

    pub fn is_together(self) -> bool {
        matches!(self, RelState::Dating | RelState::Married)
    }

    /// Legal transitions of the relationship state machine.
    pub fn can_move_to(self, next: RelState) -> bool {
        matches!(
            (self, next),
            (RelState::Dating, RelState::Married)
                | (RelState::Dating, RelState::BrokenUp)
                | (RelState::Married, RelState::Separated)
                | (RelState::Separated, RelState::Married)
                | (RelState::Separated, RelState::Divorced)
        )
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Conflict {
    pub started: i32,
    pub intensity: f64,
    pub peak_intensity: f64,
    pub days: u32,
    pub escalations: u32,
    pub repair_attempts: u32,
}

#[derive(Component, Clone, Debug)]
pub struct Couple {
    pub id: u64,
    pub a: Entity,
    pub b: Entity,
    pub a_id: u64,
    pub b_id: u64,
    pub origin: Origin,
    /// Arm of an initial couple; remarriages carry none (members keep their own params).
    pub arm: Option<Arm>,
    pub formed_day: i32,
    pub married_day: Option<i32>,
    pub compatibility: f64,
}

#[derive(Component, Clone, Debug)]
pub struct Rel {
    pub state: RelState,
    pub conflict: Option<Conflict>,
    pub separated_since: Option<i32>,
    pub ended_day: Option<i32>,
    /// Compatibility surplus from an outside encounter today, per member (a, b).
    pub outside_option: [f64; 2],
    pub positive_today: bool,
    /// Consecutive days without a warm memory on both sides (0 while associated).
    pub orphan_days: u32,
    /// Conflicts closed in this relationship, and how many of them ended in reconciliation.
    pub conflicts_closed: u32,
    pub conflicts_reconciled: u32,
}

impl Rel {
    /// A relationship that starts today in `state`.
    pub fn new(state: RelState) -> Self {
        Self {
            state,
            conflict: None,
            separated_since: None,
            ended_day: None,
            outside_option: [0.0; 2],
            positive_today: false,
            orphan_days: 0,
            conflicts_closed: 0,
            conflicts_reconciled: 0,
        }
    }
}

#[derive(Component)]
pub struct CoupleRng(pub Rng);

/// Which member each shock resolved to for this couple (None until the shock first applies), and
/// per shock a bit per effect marking the once and standing effects that have already acted.
#[derive(Component, Clone, Debug, Default)]
pub struct ShockState {
    /// The member each shock landed on, once resolved.
    pub member: Vec<Option<u8>>,
    /// Per shock, one bit per effect: the once and standing effects that have already acted.
    pub fired: Vec<u64>,
    /// Per shock, one bit per effect: the effects whose start has been logged.
    pub started: Vec<u64>,
}

impl ShockState {
    pub fn new(shocks: usize) -> Self {
        ShockState {
            member: vec![None; shocks],
            fired: vec![0; shocks],
            started: vec![0; shocks],
        }
    }
}

// ---------- resources ----------

#[derive(Resource, Clone, Copy, Debug)]
pub struct Clock {
    pub day: i32,
}

#[derive(Resource, Clone, Debug)]
pub struct Config(pub SimConfig);

#[derive(Resource, Clone, Copy, Debug)]
pub struct NextCoupleId(pub u64);

#[derive(Resource)]
pub struct MarketRng(pub Rng);

/// Agent entity by agent id.
#[derive(Resource, Clone, Debug, Default)]
pub struct AgentIndex(pub Vec<Entity>);

#[derive(Resource, Default)]
pub struct LogStore(pub Logs);

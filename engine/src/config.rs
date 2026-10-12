//! Experiment configuration. Every number that shapes the simulation lives here, has a
//! default, and is echoed verbatim into the run manifest.
//!
//! Three independent seeds keep the design clean:
//! * `population` generates the agents (and the social network),
//! * `assignment` randomises couples into arms,
//! * `dynamics` drives every stochastic process during the run.
//!
//! Changing one seed must never change what another seed controls; tests pin that.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arm {
    Control,
    Treatment,
}

impl Arm {
    pub fn as_str(self) -> &'static str {
        match self {
            Arm::Control => "control",
            Arm::Treatment => "treatment",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Seeds {
    pub population: u64,
    pub assignment: u64,
    pub dynamics: u64,
}

impl Default for Seeds {
    fn default() -> Self {
        Self {
            population: 11,
            assignment: 22,
            dynamics: 33,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssignmentMode {
    /// Independent randomisation per couple (the primary design).
    Couple,
    /// Contiguous blocks of couple ids share an arm. The social network is a ring over
    /// agent ids, so blocks are network neighbourhoods: cluster randomisation for runs that
    /// switch contagion on.
    Block,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssignmentConfig {
    pub mode: AssignmentMode,
    pub treatment_fraction: f64,
    pub block_size: u32,
}

impl Default for AssignmentConfig {
    fn default() -> Self {
        Self {
            mode: AssignmentMode::Couple,
            treatment_fraction: 0.5,
            block_size: 10,
        }
    }
}

/// Half-lives (days) of each memory class. The intervention is a change to one of these.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MemoryParams {
    pub conflict_half_life_days: f64,
    pub repair_half_life_days: f64,
    pub positive_half_life_days: f64,
    /// Diminishing returns on retained load: effective = s * (1 - exp(-raw / s)).
    pub load_saturation: f64,
}

impl Default for MemoryParams {
    fn default() -> Self {
        Self {
            conflict_half_life_days: 14.0,
            repair_half_life_days: 30.0,
            positive_half_life_days: 20.0,
            load_saturation: 1.5,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MemoryConfig {
    pub control: MemoryParams,
    pub treatment: MemoryParams,
    /// Episodes whose current strength falls below this are forgotten.
    pub prune_threshold: f64,
    /// At most this many episodes are kept (the strongest survive).
    pub capacity: usize,
    pub prune_every_days: u32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            control: MemoryParams::default(),
            treatment: MemoryParams {
                conflict_half_life_days: 90.0,
                ..MemoryParams::default()
            },
            prune_threshold: 0.01,
            capacity: 200,
            prune_every_days: 7,
        }
    }
}

/// Rules every memory follows whatever the arm: they never differ between arms and the
/// intervention never writes them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MemoryRules {
    /// Days an episode keeps its full intensity before its half-life decay starts (0 = none).
    pub plateau_days: f64,
    /// When more than this many episodes of one class about the current partner are older than
    /// the plateau, they merge into one standing episode carrying the same load (0 = never).
    pub consolidate_after: usize,
    /// While a couple is separated their shared episodes neither decay nor prune; reunion or
    /// divorce restarts the clock.
    pub freeze_during_separation: bool,
}

impl Default for MemoryRules {
    fn default() -> Self {
        Self {
            plateau_days: 2.0,
            consolidate_after: 8,
            freeze_during_separation: true,
        }
    }
}

/// Leaving needs sustained distance, not one bad day. A couple is associated on a day when both
/// members stored a warm memory (positive or reconciliation) about each other within the window,
/// and orphaned otherwise. A married couple in a conflict may walk out (separate) only after
/// `orphan_days_to_leave` consecutive orphaned days, or once the conflict reaches
/// `unlock_intensity`. Dating couples are not gated, and neither is finalising a separation:
/// separating already is the sustained distance, and the separation cap still ends it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssociationConfig {
    pub window_days: u32,
    /// 0 turns the gate off: leaving is always on the menu, as before.
    pub orphan_days_to_leave: u32,
    pub unlock_intensity: f64,
}

impl Default for AssociationConfig {
    fn default() -> Self {
        Self {
            window_days: 42,
            orphan_days_to_leave: 21,
            unlock_intensity: 0.95,
        }
    }
}

/// What a divorce leaves behind. Each member seals the marriage into a legacy minted from that
/// marriage alone, never from an earlier legacy. The legacy makes leaving easier in later
/// relationships (weaker commitment to marriage, after Amato and DeBoer 2001) and pulls the next
/// relationship's starting trust toward the trust the marriage ended with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LegacyConfig {
    /// Added to the leave utility in every later relationship (0 = no commitment effect).
    pub commitment_shift: f64,
    /// Weight of the sealed final trust in the next relationship's starting trust (0 = none).
    pub trust_prior_weight: f64,
}

impl Default for LegacyConfig {
    fn default() -> Self {
        Self {
            commitment_shift: 0.3,
            trust_prior_weight: 0.5,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TraitDist {
    pub mean: f64,
    pub sd: f64,
}

impl TraitDist {
    pub const fn new(mean: f64, sd: f64) -> Self {
        Self { mean, sd }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PopulationConfig {
    pub neuroticism: TraitDist,
    pub agreeableness: TraitDist,
    pub conscientiousness: TraitDist,
    pub openness: TraitDist,
    pub extraversion: TraitDist,
    pub forgiveness: TraitDist,
    pub commitment: TraitDist,
    pub closeness_pref: TraitDist,
    /// 0 = avoidant conflict style, 1 = engaging.
    pub conflict_engagement: TraitDist,
    /// Partner B's traits = mix * A + (1 - mix) * fresh draw (assortative mating).
    pub assortative_mixing: f64,
    pub prior_relationships: TraitDist,
    pub prior_divorce_prob: f64,
    pub years_married: TraitDist,
    pub base_trust: TraitDist,
    /// Episodes per year of history pre-seeded into memory.
    pub history_positive_per_year: f64,
    pub history_conflict_per_year: f64,
    /// Watts-Strogatz ring over agent ids: each agent has `network_k` neighbours.
    pub network_k: usize,
    pub network_rewire_p: f64,
}

impl Default for PopulationConfig {
    fn default() -> Self {
        Self {
            neuroticism: TraitDist::new(0.45, 0.18),
            agreeableness: TraitDist::new(0.55, 0.16),
            conscientiousness: TraitDist::new(0.55, 0.16),
            openness: TraitDist::new(0.5, 0.18),
            extraversion: TraitDist::new(0.5, 0.18),
            forgiveness: TraitDist::new(0.55, 0.18),
            commitment: TraitDist::new(0.65, 0.15),
            closeness_pref: TraitDist::new(0.55, 0.18),
            conflict_engagement: TraitDist::new(0.5, 0.2),
            assortative_mixing: 0.35,
            prior_relationships: TraitDist::new(2.0, 1.5),
            prior_divorce_prob: 0.18,
            years_married: TraitDist::new(6.0, 4.0),
            base_trust: TraitDist::new(0.6, 0.15),
            history_positive_per_year: 6.0,
            history_conflict_per_year: 3.0,
            network_k: 6,
            network_rewire_p: 0.1,
        }
    }
}

/// The world: stress shocks, affect coupling, trust integration, conflict hazards.
/// None of these depend on the arm.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DynamicsConfig {
    // Stress
    pub stress_shock_prob: f64,
    pub stress_shock_mean: f64,
    pub stress_decay: f64,
    pub stress_neuro_weight: f64,
    // Affect (Gottman and Murray style influence equations, per day)
    pub affect_inertia_base: f64,
    pub affect_inertia_neuro: f64,
    pub influence_pos: f64,
    pub influence_neg: f64,
    pub negativity_threshold: f64,
    pub influence_neg_below_threshold: f64,
    pub affect_baseline_agree: f64,
    pub affect_grudge_weight: f64,
    pub affect_pos_weight: f64,
    pub affect_stress_weight: f64,
    pub affect_noise_sd: f64,
    // Trust (slow integrator)
    pub trust_rate: f64,
    pub trust_pos_weight: f64,
    pub trust_neg_weight: f64,
    pub trust_affect_weight: f64,
    pub trust_hit_escalate: f64,
    pub trust_hit_withdraw: f64,
    pub trust_hit_rejection: f64,
    pub trust_gain_reconcile: f64,
    pub trust_hit_separate: f64,
    // Satisfaction (logistic of trust, affect, memory balance)
    pub sat_trust: f64,
    pub sat_affect: f64,
    pub sat_memory: f64,
    // Conflict onset hazard (logit per day)
    pub onset_intercept: f64,
    pub onset_stress: f64,
    pub onset_neuro: f64,
    pub onset_grudge: f64,
    pub onset_trust: f64,
    pub onset_affect: f64,
    pub onset_agree: f64,
    pub intensity_base: f64,
    pub intensity_stress: f64,
    pub intensity_neuro: f64,
    pub intensity_sd: f64,
    pub escalation_step: f64,
    pub intensity_decay: f64,
    pub fade_threshold: f64,
    // Repair acceptance (logit, evaluated with the receiver's private state)
    pub accept_intercept: f64,
    pub accept_trust: f64,
    pub accept_forgive: f64,
    pub accept_grudge: f64,
    pub accept_intensity: f64,
    // Episode intensities for secondary events
    pub positive_episode_intensity: f64,
    pub withdraw_episode_intensity: f64,
    pub rejection_episode_intensity: f64,
    // Closeness mismatch: affect falls with the gap between the members' closeness preferences,
    // and the member who wants more closeness may store a disappointment each week.
    pub affect_closeness_gap_weight: f64,
    pub disappointment_weekly_rate: f64,
    pub disappointment_intensity: f64,
    // Separation and divorce
    pub separation_days_to_divorce: u32,
    // Outside options (MADAM style encounters while married)
    pub outside_encounter_prob: f64,
}

impl Default for DynamicsConfig {
    fn default() -> Self {
        Self {
            stress_shock_prob: 0.06,
            stress_shock_mean: 0.5,
            stress_decay: 0.7,
            stress_neuro_weight: 0.15,
            affect_inertia_base: 0.45,
            affect_inertia_neuro: 0.3,
            influence_pos: 0.25,
            influence_neg: 0.4,
            negativity_threshold: -0.35,
            influence_neg_below_threshold: 0.8,
            affect_baseline_agree: 0.25,
            affect_grudge_weight: 0.35,
            affect_pos_weight: 0.3,
            affect_stress_weight: 0.3,
            affect_noise_sd: 0.08,
            trust_rate: 0.04,
            trust_pos_weight: 0.08,
            trust_neg_weight: 0.2,
            trust_affect_weight: 0.12,
            trust_hit_escalate: 0.02,
            trust_hit_withdraw: 0.015,
            trust_hit_rejection: 0.02,
            trust_gain_reconcile: 0.05,
            trust_hit_separate: 0.12,
            sat_trust: 4.0,
            sat_affect: 1.5,
            sat_memory: 1.0,
            onset_intercept: -4.4,
            onset_stress: 1.6,
            onset_neuro: 1.0,
            onset_grudge: 0.3,
            onset_trust: -1.4,
            onset_affect: -1.2,
            onset_agree: -0.8,
            intensity_base: 0.3,
            intensity_stress: 0.3,
            intensity_neuro: 0.2,
            intensity_sd: 0.1,
            escalation_step: 0.15,
            intensity_decay: 0.92,
            fade_threshold: 0.08,
            accept_intercept: -0.6,
            accept_trust: 2.5,
            accept_forgive: 1.5,
            accept_grudge: -0.5,
            accept_intensity: -1.5,
            positive_episode_intensity: 0.12,
            withdraw_episode_intensity: 0.25,
            rejection_episode_intensity: 0.3,
            affect_closeness_gap_weight: 0.3,
            disappointment_weekly_rate: 0.15,
            disappointment_intensity: 0.3,
            separation_days_to_divorce: 60,
            outside_encounter_prob: 0.02,
        }
    }
}

/// The agents' decision policy: named utility weights for every action in every context.
/// The policy never sees the arm; it sees the agent's own private state plus observable
/// partner behaviour. `loveworld-engine policy-spec` prints these with the formulas.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PolicyConfig {
    pub temperature: f64,
    // Calm days: Affiliate vs Neutral
    pub aff_base: f64,
    pub aff_extraversion: f64,
    pub aff_trust: f64,
    pub aff_affect: f64,
    pub aff_stress: f64,
    pub aff_closeness: f64,
    // Conflict: Repair
    pub rep_base: f64,
    pub rep_agree: f64,
    pub rep_forgive: f64,
    pub rep_trust: f64,
    pub rep_posmem: f64,
    pub rep_negmem: f64,
    pub rep_partner_repaired: f64,
    pub rep_intensity: f64,
    pub rep_days: f64,
    // Conflict: Hold
    pub hold_base: f64,
    pub hold_avoidant: f64,
    pub hold_consc: f64,
    // Conflict: Escalate
    pub esc_base: f64,
    pub esc_neuro: f64,
    pub esc_engage: f64,
    pub esc_negmem: f64,
    pub esc_stress: f64,
    pub esc_trust: f64,
    pub esc_partner_escalated: f64,
    pub esc_affect: f64,
    // Conflict: Withdraw
    pub wd_base: f64,
    pub wd_avoidant: f64,
    pub wd_neuro: f64,
    pub wd_intensity: f64,
    pub wd_partner_escalated: f64,
    // Conflict or separation: Leave
    pub leave_base: f64,
    pub leave_commit: f64,
    pub leave_trust: f64,
    pub leave_negmem: f64,
    pub leave_posmem: f64,
    pub leave_intensity: f64,
    pub leave_days: f64,
    pub leave_satisfaction: f64,
    pub leave_network: f64,
    pub leave_outside_option: f64,
    pub leave_dating_bonus: f64,
    // Separation: Reunite and Hold bases
    pub sep_reunite_base: f64,
    pub sep_hold_base: f64,
    pub sep_leave_base: f64,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            temperature: 0.7,
            aff_base: -0.4,
            aff_extraversion: 0.8,
            aff_trust: 1.0,
            aff_affect: 0.8,
            aff_stress: 0.8,
            aff_closeness: 0.6,
            rep_base: -0.3,
            rep_agree: 1.0,
            rep_forgive: 1.0,
            rep_trust: 1.0,
            rep_posmem: 0.8,
            rep_negmem: 1.0,
            rep_partner_repaired: 1.2,
            rep_intensity: 1.5,
            rep_days: 0.08,
            hold_base: 0.6,
            hold_avoidant: 0.8,
            hold_consc: 0.3,
            esc_base: -1.4,
            esc_neuro: 1.2,
            esc_engage: 0.8,
            esc_negmem: 0.25,
            esc_stress: 1.0,
            esc_trust: 1.2,
            esc_partner_escalated: 0.5,
            esc_affect: 1.0,
            wd_base: -0.8,
            wd_avoidant: 1.4,
            wd_neuro: 0.6,
            wd_intensity: 0.8,
            wd_partner_escalated: 0.6,
            leave_base: 0.2,
            leave_commit: 2.5,
            leave_trust: 2.0,
            leave_negmem: 0.7,
            leave_posmem: 1.0,
            leave_intensity: 1.2,
            leave_days: 0.05,
            leave_satisfaction: 2.5,
            leave_network: 0.0,
            leave_outside_option: 1.0,
            leave_dating_bonus: 1.2,
            sep_reunite_base: 0.2,
            sep_hold_base: 0.5,
            sep_leave_base: -1.2,
        }
    }
}

/// Remarriage market, after Hills and Todd's MADAM: singles meet a few candidates a day,
/// accept when compatibility clears a personal threshold that relaxes with time alone and
/// is anchored to the last marriage after a divorce.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MarketConfig {
    pub meet_per_day: usize,
    pub initial_threshold: f64,
    pub threshold_floor: f64,
    pub relax_rate_mean: f64,
    pub relax_rate_sd: f64,
    /// Threshold after a divorce = last compatibility minus this.
    pub anchor_discount: f64,
    pub cooldown_days: u32,
    pub dating_min_days: u32,
    pub marry_hazard_base: f64,
    pub marry_hazard_compat: f64,
    pub marry_hazard_commit: f64,
    /// Wedding Ring style contagion: share of married network neighbours raises the hazard.
    pub marry_network_weight: f64,
}

impl Default for MarketConfig {
    fn default() -> Self {
        Self {
            meet_per_day: 2,
            initial_threshold: 0.75,
            threshold_floor: 0.35,
            relax_rate_mean: 0.004,
            relax_rate_sd: 0.002,
            anchor_discount: 0.05,
            cooldown_days: 90,
            dating_min_days: 30,
            marry_hazard_base: 0.004,
            marry_hazard_compat: 0.02,
            marry_hazard_commit: 0.01,
            marry_network_weight: 0.0,
        }
    }
}

/// A scheduled stressor or kindness applied to one arm or to everyone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShockKind {
    JobLoss,
    FinancialCrisis,
    Temptation,
    IntimacyMismatch,
    DailyTexts,
    Anniversary,
    DateNights,
    TraitShift,
}

/// Traits a trait_shift shock may move.
pub const SHIFTABLE_TRAITS: [&str; 9] = [
    "neuroticism",
    "agreeableness",
    "conscientiousness",
    "openness",
    "extraversion",
    "forgiveness",
    "commitment",
    "closeness_pref",
    "conflict_engagement",
];

impl ShockKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ShockKind::JobLoss => "job_loss",
            ShockKind::FinancialCrisis => "financial_crisis",
            ShockKind::Temptation => "temptation",
            ShockKind::IntimacyMismatch => "intimacy_mismatch",
            ShockKind::DailyTexts => "daily_texts",
            ShockKind::Anniversary => "anniversary",
            ShockKind::DateNights => "date_nights",
            ShockKind::TraitShift => "trait_shift",
        }
    }

    /// Allowed magnitude range and default, plus the default length in days (None = open).
    pub fn bounds(self) -> (f64, f64, f64, Option<u32>) {
        match self {
            ShockKind::JobLoss => (0.0, 5.0, 1.5, Some(120)),
            ShockKind::FinancialCrisis => (0.0, 5.0, 1.0, Some(120)),
            ShockKind::Temptation => (0.0, 1.0, 0.2, Some(120)),
            ShockKind::IntimacyMismatch => (-1.0, 1.0, 0.4, None),
            ShockKind::DailyTexts => (0.0, 5.0, 1.0, None),
            ShockKind::Anniversary => (0.0, 2.0, 1.0, None),
            ShockKind::DateNights => (0.0, 2.0, 1.0, None),
            ShockKind::TraitShift => (-1.0, 1.0, 0.3, None),
        }
    }

    pub fn all() -> [ShockKind; 8] {
        [
            ShockKind::JobLoss,
            ShockKind::FinancialCrisis,
            ShockKind::Temptation,
            ShockKind::IntimacyMismatch,
            ShockKind::DailyTexts,
            ShockKind::Anniversary,
            ShockKind::DateNights,
            ShockKind::TraitShift,
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShockTarget {
    Treatment,
    Control,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShockMember {
    A,
    B,
    Random,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShockConfig {
    pub kind: ShockKind,
    pub target: ShockTarget,
    #[serde(default = "default_member")]
    pub member: ShockMember,
    pub start_day: u32,
    #[serde(default)]
    pub end_day: Option<u32>,
    /// Omitted means the kind's catalog default.
    #[serde(default)]
    pub magnitude: Option<f64>,
    /// For trait_shift only: which trait moves.
    #[serde(default, rename = "trait")]
    pub trait_name: Option<String>,
}

fn default_member() -> ShockMember {
    ShockMember::Random
}

impl ShockConfig {
    /// Effective magnitude: the configured value or the kind's catalog default.
    pub fn magnitude(&self) -> f64 {
        self.magnitude.unwrap_or(self.kind.bounds().2)
    }

    /// Last day (inclusive) the shock is active.
    pub fn last_day(&self, days: u32) -> i32 {
        let v: i64 = match (self.end_day, self.kind.bounds().3) {
            (Some(e), _) => e as i64,
            (None, Some(len)) => self.start_day as i64 + len as i64,
            (None, None) => days as i64 - 1,
        };
        v.min(i32::MAX as i64) as i32
    }
}

/// Longest run accepted (100 years), which keeps every day arithmetic inside i32.
pub const MAX_DAYS: u32 = 36_500;

/// Shock kinds with their bounds, for the picker.
pub fn shock_catalog() -> serde_json::Value {
    serde_json::json!(ShockKind::all()
        .iter()
        .map(|k| {
            let (lo, hi, default, len) = k.bounds();
            serde_json::json!({"kind": k.as_str(), "min": lo, "max": hi, "default": default, "default_length_days": len,
                "traits": if *k == ShockKind::TraitShift { SHIFTABLE_TRAITS.to_vec() } else { Vec::new() }})
        })
        .collect::<Vec<_>>())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SimConfig {
    pub name: String,
    pub n_couples: u32,
    pub days: u32,
    pub seeds: Seeds,
    pub assignment: AssignmentConfig,
    pub memory: MemoryConfig,
    pub memory_rules: MemoryRules,
    pub association: AssociationConfig,
    pub legacy: LegacyConfig,
    pub population: PopulationConfig,
    pub dynamics: DynamicsConfig,
    pub policy: PolicyConfig,
    pub market: MarketConfig,
    /// Force every couple into one arm (twin runs on common random numbers).
    pub arm_override: Option<Arm>,
    /// Scheduled shocks (stressors and kindnesses), see `ShockConfig`.
    pub shocks: Vec<ShockConfig>,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            name: "default".to_string(),
            n_couples: 1000,
            days: 365,
            seeds: Seeds::default(),
            assignment: AssignmentConfig::default(),
            memory: MemoryConfig::default(),
            memory_rules: MemoryRules::default(),
            association: AssociationConfig::default(),
            legacy: LegacyConfig::default(),
            population: PopulationConfig::default(),
            dynamics: DynamicsConfig::default(),
            policy: PolicyConfig::default(),
            market: MarketConfig::default(),
            arm_override: None,
            shocks: Vec::new(),
        }
    }
}

/// Every numeric coefficient must be finite and within +/- 10,000 so utilities and hazards
/// stay finite (a softmax over infinities would be undefined).
fn check_bounded(path: &str, v: &serde_json::Value) -> anyhow::Result<()> {
    match v {
        serde_json::Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            anyhow::ensure!(
                x.is_finite() && x.abs() <= 1e4,
                "{path} must be finite and within +/- 10000 (got {x})"
            );
            Ok(())
        }
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                check_bounded(&format!("{path}.{k}"), val)?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => {
            for (i, val) in items.iter().enumerate() {
                check_bounded(&format!("{path}[{i}]"), val)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

impl SimConfig {
    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        let cfg: SimConfig = serde_json::from_str(text)?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.n_couples >= 1, "n_couples must be at least 1");
        anyhow::ensure!(self.days >= 1, "days must be at least 1");
        anyhow::ensure!(self.days <= MAX_DAYS, "days must be at most {MAX_DAYS}");
        let f = self.assignment.treatment_fraction;
        anyhow::ensure!(
            (0.0..=1.0).contains(&f),
            "treatment_fraction must be in [0, 1]"
        );
        anyhow::ensure!(
            self.assignment.block_size >= 1,
            "block_size must be at least 1"
        );
        for (name, p) in [
            ("control", &self.memory.control),
            ("treatment", &self.memory.treatment),
        ] {
            anyhow::ensure!(
                p.conflict_half_life_days > 0.0,
                "{name}.conflict_half_life_days must be positive"
            );
            anyhow::ensure!(
                p.repair_half_life_days > 0.0,
                "{name}.repair_half_life_days must be positive"
            );
            anyhow::ensure!(
                p.positive_half_life_days > 0.0,
                "{name}.positive_half_life_days must be positive"
            );
            anyhow::ensure!(
                p.load_saturation > 0.0,
                "{name}.load_saturation must be positive"
            );
        }
        anyhow::ensure!(
            self.memory.capacity >= 1,
            "memory.capacity must be at least 1"
        );
        anyhow::ensure!(
            self.policy.temperature > 0.0,
            "policy.temperature must be positive"
        );
        anyhow::ensure!(
            self.population.network_k.is_multiple_of(2),
            "population.network_k must be even"
        );
        let agents = 2 * self.n_couples as usize;
        anyhow::ensure!(
            self.population.network_k < agents && self.population.network_k <= 64,
            "population.network_k must be smaller than the number of agents ({agents}) and at most 64"
        );
        anyhow::ensure!(
            self.memory.control.load_saturation >= 1e-6
                && self.memory.treatment.load_saturation >= 1e-6,
            "memory load_saturation must be at least 1e-6"
        );
        for (i, sh) in self.shocks.iter().enumerate() {
            let (lo, hi, _, _) = sh.kind.bounds();
            anyhow::ensure!(
                sh.start_day < self.days,
                "shocks[{i}].start_day must be before the end of the run ({})",
                self.days
            );
            if let Some(e) = sh.end_day {
                anyhow::ensure!(
                    e >= sh.start_day,
                    "shocks[{i}].end_day must not precede start_day"
                );
            }
            let m = sh.magnitude();
            anyhow::ensure!(
                m.is_finite() && m >= lo && m <= hi,
                "shocks[{i}].magnitude must be within [{lo}, {hi}] for {}",
                sh.kind.as_str()
            );
            if sh.kind == ShockKind::TraitShift {
                let t = sh.trait_name.as_deref().unwrap_or("");
                anyhow::ensure!(
                    SHIFTABLE_TRAITS.contains(&t),
                    "shocks[{i}].trait must be one of {:?}",
                    SHIFTABLE_TRAITS
                );
            } else {
                anyhow::ensure!(
                    sh.trait_name.is_none(),
                    "shocks[{i}].trait is only valid for trait_shift"
                );
            }
        }
        let r = &self.memory_rules;
        anyhow::ensure!(
            r.plateau_days.is_finite() && (0.0..=3650.0).contains(&r.plateau_days),
            "memory_rules.plateau_days must be within [0, 3650]"
        );
        anyhow::ensure!(
            r.consolidate_after <= 10_000,
            "memory_rules.consolidate_after must be at most 10000 (0 turns consolidation off)"
        );
        let a = &self.association;
        anyhow::ensure!(
            (1..=3650).contains(&a.window_days),
            "association.window_days must be within [1, 3650]"
        );
        anyhow::ensure!(
            a.orphan_days_to_leave <= MAX_DAYS,
            "association.orphan_days_to_leave must be at most {MAX_DAYS} (0 turns the gate off)"
        );
        anyhow::ensure!(
            a.unlock_intensity.is_finite() && (0.0..=10.0).contains(&a.unlock_intensity),
            "association.unlock_intensity must be within [0, 10]"
        );
        let l = &self.legacy;
        anyhow::ensure!(
            l.commitment_shift.is_finite() && l.commitment_shift.abs() <= 10.0,
            "legacy.commitment_shift must be within [-10, 10]"
        );
        anyhow::ensure!(
            l.trust_prior_weight.is_finite() && (0.0..=1.0).contains(&l.trust_prior_weight),
            "legacy.trust_prior_weight must be within [0, 1]"
        );
        check_bounded("policy", &serde_json::to_value(&self.policy)?)?;
        check_bounded("dynamics", &serde_json::to_value(&self.dynamics)?)?;
        check_bounded("market", &serde_json::to_value(&self.market)?)?;
        anyhow::ensure!(
            self.market.cooldown_days >= 1,
            "market.cooldown_days must be at least 1 (a divorced agent re-enters the market the next day at the earliest)"
        );
        anyhow::ensure!(
            self.market.dating_min_days >= 1,
            "market.dating_min_days must be at least 1"
        );
        anyhow::ensure!(
            self.dynamics.separation_days_to_divorce >= 1,
            "dynamics.separation_days_to_divorce must be at least 1"
        );
        anyhow::ensure!(
            (0.0..=1.0).contains(&self.population.assortative_mixing),
            "population.assortative_mixing must be in [0, 1]"
        );
        Ok(())
    }

    pub fn memory_params(&self, arm: Arm) -> &MemoryParams {
        match arm {
            Arm::Control => &self.memory.control,
            Arm::Treatment => &self.memory.treatment,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_json_fills_defaults() {
        let cfg = SimConfig::from_json(r#"{"n_couples": 10, "days": 5}"#).unwrap();
        assert_eq!(cfg.n_couples, 10);
        assert_eq!(cfg.days, 5);
        assert_eq!(cfg.memory.treatment.conflict_half_life_days, 90.0);
        assert_eq!(cfg.seeds.dynamics, 33);
    }

    #[test]
    fn new_memory_governance_sections_default_and_validate() {
        let cfg = SimConfig::from_json(r#"{"n_couples": 4, "days": 5}"#).unwrap();
        assert_eq!(cfg.memory_rules.plateau_days, 2.0);
        assert_eq!(cfg.association.unlock_intensity, 0.95);
        assert_eq!(cfg.memory_rules.consolidate_after, 8);
        assert!(cfg.memory_rules.freeze_during_separation);
        assert_eq!(cfg.association.window_days, 42);
        assert_eq!(cfg.association.orphan_days_to_leave, 21);
        assert_eq!(cfg.legacy.commitment_shift, 0.3);
        for bad in [
            r#"{"memory_rules": {"plateau_days": -1}}"#,
            r#"{"memory_rules": {"plateau_days": 4000}}"#,
            r#"{"association": {"window_days": 0}}"#,
            r#"{"association": {"unlock_intensity": -0.1}}"#,
            r#"{"legacy": {"trust_prior_weight": 1.5}}"#,
            r#"{"legacy": {"commitment_shift": 11}}"#,
        ] {
            assert!(
                SimConfig::from_json(bad).is_err(),
                "{bad} should be rejected"
            );
        }
        // Each mechanism can be switched off.
        let off = SimConfig::from_json(
            r#"{"memory_rules": {"plateau_days": 0, "consolidate_after": 0, "freeze_during_separation": false},
                "association": {"orphan_days_to_leave": 0}, "legacy": {"commitment_shift": 0, "trust_prior_weight": 0}}"#,
        )
        .unwrap();
        assert_eq!(off.memory_rules.consolidate_after, 0);
    }

    #[test]
    fn invalid_config_rejected() {
        assert!(SimConfig::from_json(r#"{"n_couples": 0}"#).is_err());
        assert!(SimConfig::from_json(r#"{"assignment": {"treatment_fraction": 1.5}}"#).is_err());
        assert!(
            SimConfig::from_json(r#"{"memory": {"control": {"conflict_half_life_days": 0}}}"#)
                .is_err()
        );
        assert!(
            SimConfig::from_json(r#"{"n_couples": 2, "population": {"network_k": 4}}"#).is_err()
        );
        assert!(
            SimConfig::from_json(r#"{"n_couples": 3, "population": {"network_k": 4}}"#).is_ok()
        );
        assert!(SimConfig::from_json(r#"{"market": {"cooldown_days": 0}}"#).is_err());
        assert!(SimConfig::from_json(r#"{"population": {"network_k": 7}}"#).is_err());
        assert!(SimConfig::from_json(r#"{"population": {"network_k": 66}}"#).is_err());
        assert!(SimConfig::from_json(r#"{"policy": {"aff_base": 1e308}}"#).is_err());
        assert!(SimConfig::from_json(r#"{"dynamics": {"onset_intercept": -20000}}"#).is_err());
        assert!(
            SimConfig::from_json(r#"{"memory": {"control": {"load_saturation": 1e-12}}}"#).is_err()
        );
    }

    #[test]
    fn shocks_validate() {
        let ok = r#"{"days": 100, "shocks": [{"kind": "job_loss", "target": "treatment", "member": "a", "start_day": 10}]}"#;
        let cfg = SimConfig::from_json(ok).unwrap();
        assert_eq!(
            cfg.shocks[0].magnitude(),
            1.5,
            "omitted magnitude takes the kind default"
        );
        assert_eq!(cfg.shocks[0].last_day(100), 130);
        let t = SimConfig::from_json(
            r#"{"days": 100, "shocks": [{"kind": "temptation", "target": "all", "start_day": 1}]}"#,
        )
        .unwrap();
        assert_eq!(t.shocks[0].magnitude(), 0.2);
        assert!(SimConfig::from_json(r#"{"days": 4294967295}"#).is_err());
        assert!(SimConfig::from_json(
            r#"{"days": 100, "shocks": [{"kind": "job_loss", "target": "all", "start_day": 100}]}"#
        )
        .is_err());
        assert!(SimConfig::from_json(r#"{"days": 100, "shocks": [{"kind": "temptation", "target": "all", "start_day": 1, "magnitude": 2.0}]}"#).is_err());
        assert!(SimConfig::from_json(r#"{"days": 100, "shocks": [{"kind": "anniversary", "target": "all", "start_day": 5, "end_day": 2}]}"#).is_err());
        assert!(SimConfig::from_json(
            r#"{"days": 100, "shocks": [{"kind": "bogus", "target": "all", "start_day": 5}]}"#
        )
        .is_err());
        assert_eq!(shock_catalog().as_array().unwrap().len(), 8);
        assert!(SimConfig::from_json(r#"{"days": 100, "shocks": [{"kind": "trait_shift", "target": "treatment", "start_day": 0}]}"#).is_err());
        assert!(SimConfig::from_json(r#"{"days": 100, "shocks": [{"kind": "trait_shift", "target": "treatment", "start_day": 0, "trait": "neuroticism", "magnitude": 0.3}]}"#).is_ok());
    }

    #[test]
    fn tiny_legal_configs_run() {
        for text in [
            r#"{"n_couples": 1, "days": 1, "population": {"network_k": 0}}"#,
            r#"{"n_couples": 2, "days": 3, "population": {"network_k": 2}, "memory": {"capacity": 1}}"#,
        ] {
            let cfg = SimConfig::from_json(text).unwrap();
            let res = crate::sim::run(&cfg);
            assert_eq!(res.agents.len(), 2 * cfg.n_couples as usize);
        }
    }

    #[test]
    fn config_round_trips_through_json() {
        let cfg = SimConfig::default();
        let text = serde_json::to_string(&cfg).unwrap();
        let back = SimConfig::from_json(&text).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), text);
    }
}

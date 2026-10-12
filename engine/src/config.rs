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
    /// Matched pairs. Couples are sorted by a risk score built from values the population
    /// draws before day 0 (`pair_weights`) and cut into consecutive pairs, and a coin from the
    /// assignment seed sends one member of each pair to each arm. The pairing reads the
    /// population, so the population seed moves it; the coins read the assignment seed alone.
    Pairs,
}

/// Weights of the pairs-mode risk score, one per couple covariate. Each covariate is the mean
/// of the two partners' values (years married is shared), standardised over the run's
/// population before weighting, so the weights are unitless and only their ratios matter.
/// The defaults are an ordinary least squares fit over the example run's control couples of
/// the average of their standardised divorce indicator and standardised conflict rate, from
/// `tools/fit_pair_weights.py`, rounded to three decimals; docs/design.md records the fit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PairWeights {
    pub neuroticism: f64,
    pub conscientiousness: f64,
    pub agreeableness: f64,
    pub base_trust: f64,
    pub prior_divorces: f64,
    pub years_married: f64,
}

impl Default for PairWeights {
    fn default() -> Self {
        Self {
            neuroticism: 0.170,
            conscientiousness: 0.028,
            agreeableness: -0.206,
            base_trust: -0.256,
            prior_divorces: -0.027,
            years_married: -0.038,
        }
    }
}

impl PairWeights {
    /// The weights in covariate order, matching `assignment::couple_covariates`.
    pub fn as_array(&self) -> [f64; 6] {
        [
            self.neuroticism,
            self.conscientiousness,
            self.agreeableness,
            self.base_trust,
            self.prior_divorces,
            self.years_married,
        ]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssignmentConfig {
    pub mode: AssignmentMode,
    /// Share of couples treated in couple and block mode. Pairs mode treats exactly one couple
    /// per pair, so it requires 0.5.
    pub treatment_fraction: f64,
    pub block_size: u32,
    pub pair_weights: PairWeights,
}

impl Default for AssignmentConfig {
    fn default() -> Self {
        Self {
            mode: AssignmentMode::Couple,
            treatment_fraction: 0.5,
            block_size: 10,
            pair_weights: PairWeights::default(),
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
/// partner behaviour. The engine binary (`loveworld-engine`, this crate's command-line program)
/// prints them with the formulas through its `policy-spec` command.
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

/// A scheduled stressor or kindness applied to one arm or to everyone. The eight named kinds are
/// shorthands for fixed effect lists (`builtin_effects`); `custom` carries its own list.
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
    Custom,
}

/// Traits a trait_shift shock (or a trait effect) may move.
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
            ShockKind::Custom => "custom",
        }
    }

    /// Allowed magnitude range and default, plus the default length in days (None = open).
    /// A custom shock has no magnitude (each effect carries its own amount) and is open-ended.
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
            ShockKind::Custom => (0.0, 0.0, 0.0, None),
        }
    }

    /// The eight named kinds (not `custom`), in catalog order.
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

/// What an effect acts on. Every channel is a quantity the engine already models; none of them
/// reaches memory half-lives, the memory rules, the leave gate, policy weights, the temperature,
/// assignment, seeds or the arm.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectChannel {
    Stress,
    Affect,
    Trust,
    Episode,
    Outside,
    OnsetHazard,
    RepairPropensity,
    Trait,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectOp {
    Add,
    Multiply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cadence {
    Once,
    Daily,
    Weekly,
    Yearly,
}

/// Whom an effect hits, relative to the shock's resolved member.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectWho {
    Member,
    Partner,
    Both,
}

/// Episode classes an episode effect may store.
pub const EFFECT_EPISODE_CLASSES: [&str; 4] = ["positive", "conflict", "repair", "disappointment"];

/// One effect of a shock: a channel, an operation, an amount, how often it acts, whom it hits and
/// (optionally) a window inside the shock's own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectConfig {
    pub channel: EffectChannel,
    pub op: EffectOp,
    pub amount: f64,
    pub cadence: Cadence,
    #[serde(default = "default_who")]
    pub who: EffectWho,
    /// Episode effects only: which kind of memory is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    /// Trait effects only: which trait moves.
    #[serde(default, rename = "trait", skip_serializing_if = "Option::is_none")]
    pub trait_name: Option<String>,
    /// First day the effect acts; defaults to the shock's start day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_day: Option<u32>,
    /// Last day (inclusive) the effect acts; defaults to the shock's last day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_day: Option<u32>,
}

fn default_who() -> EffectWho {
    EffectWho::Member
}

impl EffectChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            EffectChannel::Stress => "stress",
            EffectChannel::Affect => "affect",
            EffectChannel::Trust => "trust",
            EffectChannel::Episode => "episode",
            EffectChannel::Outside => "outside",
            EffectChannel::OnsetHazard => "onset_hazard",
            EffectChannel::RepairPropensity => "repair_propensity",
            EffectChannel::Trait => "trait",
        }
    }

    pub fn all() -> [EffectChannel; 8] {
        [
            EffectChannel::Stress,
            EffectChannel::Affect,
            EffectChannel::Trust,
            EffectChannel::Episode,
            EffectChannel::Outside,
            EffectChannel::OnsetHazard,
            EffectChannel::RepairPropensity,
            EffectChannel::Trait,
        ]
    }

    /// The one operation the channel accepts.
    pub fn op(self) -> EffectOp {
        match self {
            EffectChannel::OnsetHazard | EffectChannel::RepairPropensity => EffectOp::Multiply,
            _ => EffectOp::Add,
        }
    }

    /// The amount that leaves everything unchanged (an effect at this amount does nothing).
    pub fn identity(self) -> f64 {
        match self.op() {
            EffectOp::Add => 0.0,
            EffectOp::Multiply => 1.0,
        }
    }

    /// Hard bounds on the amount for a cadence, or None when the channel cannot act on it.
    pub fn bounds(self, cadence: Cadence) -> Option<(f64, f64)> {
        use Cadence::*;
        use EffectChannel::*;
        match (self, cadence) {
            (Stress, Once) | (Stress, Weekly) | (Stress, Yearly) => Some((-3.0, 5.0)),
            (Stress, Daily) => Some((-1.5, 1.5)),
            (Affect, Once) | (Affect, Yearly) => Some((-1.0, 1.0)),
            (Affect, Weekly) => Some((-0.5, 0.5)),
            (Affect, Daily) => Some((-0.1, 0.1)),
            (Trust, Once) | (Trust, Yearly) => Some((-0.5, 0.5)),
            (Trust, Weekly) => Some((-0.1, 0.1)),
            (Trust, Daily) => Some((-0.02, 0.02)),
            (Episode, Once) | (Episode, Yearly) => Some((0.0, 2.0)),
            (Episode, Weekly) => Some((0.0, 1.0)),
            (Episode, Daily) => Some((0.0, 0.25)),
            (Outside, Daily) => Some((0.0, 1.0)),
            (OnsetHazard, Daily) => Some((0.0, 5.0)),
            (RepairPropensity, Daily) => Some((0.1, 10.0)),
            (Trait, Once) => Some((-1.0, 1.0)),
            (Trait, Yearly) => Some((-0.25, 0.25)),
            _ => None,
        }
    }

    /// Whether the channel installs one standing modifier for its window (daily cadence) rather
    /// than acting on each day it fires.
    pub fn sustained(self, cadence: Cadence) -> bool {
        matches!(
            (self, cadence),
            (EffectChannel::Stress, Cadence::Daily)
                | (EffectChannel::Outside, _)
                | (EffectChannel::OnsetHazard, _)
                | (EffectChannel::RepairPropensity, _)
        )
    }

    /// Plain description of what the channel does, for the catalog.
    pub fn describe(self) -> &'static str {
        match self {
            EffectChannel::Stress => "Stress level, 0 to 3. Once, weekly or yearly: added to the level on each day it acts. Daily: a standing daily stress input for the window, so stress settles higher rather than climbing without limit.",
            EffectChannel::Affect => "Mood toward the partner, -1 to 1, added on each day the effect acts.",
            EffectChannel::Trust => "Trust in the partner, 0 to 1, added on each day the effect acts.",
            EffectChannel::Episode => "Stores a memory about the partner of the given class and intensity on each day the effect acts. Memories fade on the agent's own half-lives.",
            EffectChannel::Outside => "Daily chance of meeting an attractive alternative while the window lasts (the strongest active value wins).",
            EffectChannel::OnsetHazard => "Multiplies the couple's daily chance that a fight starts while the window lasts. Acts on the couple, so it always hits both.",
            EffectChannel::RepairPropensity => "Multiplies the odds that the agent chooses to repair, or to reunite when separated, while the window lasts.",
            EffectChannel::Trait => "Shifts a personality trait or preference (0 to 1) on each day the effect acts.",
        }
    }
}

impl Cadence {
    pub fn as_str(self) -> &'static str {
        match self {
            Cadence::Once => "once",
            Cadence::Daily => "daily",
            Cadence::Weekly => "weekly",
            Cadence::Yearly => "yearly",
        }
    }

    pub fn all() -> [Cadence; 4] {
        [
            Cadence::Once,
            Cadence::Daily,
            Cadence::Weekly,
            Cadence::Yearly,
        ]
    }
}

impl EffectConfig {
    fn plain(
        channel: EffectChannel,
        amount: f64,
        cadence: Cadence,
        who: EffectWho,
    ) -> EffectConfig {
        EffectConfig {
            channel,
            op: channel.op(),
            amount,
            cadence,
            who,
            class: None,
            trait_name: None,
            start_day: None,
            end_day: None,
        }
    }
}

/// The effect list a named kind stands for, at magnitude `m`. Running a named kind and running
/// `custom` with exactly this list produce identical behaviour (a parity test holds them to it).
pub fn builtin_effects(kind: ShockKind, m: f64, trait_name: Option<&str>) -> Vec<EffectConfig> {
    use Cadence::*;
    use EffectChannel::*;
    use EffectWho::*;
    let episode = |amount: f64, cadence: Cadence, who: EffectWho| EffectConfig {
        class: Some("positive".to_string()),
        ..EffectConfig::plain(Episode, amount, cadence, who)
    };
    let shift = |name: &str| EffectConfig {
        trait_name: Some(name.to_string()),
        ..EffectConfig::plain(Trait, m, Once, Member)
    };
    match kind {
        ShockKind::JobLoss => vec![
            EffectConfig::plain(Stress, m, Once, Member),
            EffectConfig::plain(Stress, 0.1 * m, Daily, Member),
        ],
        ShockKind::FinancialCrisis => vec![EffectConfig::plain(Stress, 0.3 * m, Daily, Both)],
        ShockKind::Temptation => vec![EffectConfig::plain(Outside, m, Daily, Member)],
        ShockKind::IntimacyMismatch => vec![shift("closeness_pref")],
        ShockKind::TraitShift => vec![shift(trait_name.unwrap_or("conflict_engagement"))],
        ShockKind::DailyTexts => vec![
            episode(0.05 * m, Daily, Partner),
            EffectConfig::plain(Affect, 0.02 * m, Daily, Partner),
        ],
        ShockKind::Anniversary => vec![
            episode(0.5 * m, Yearly, Both),
            EffectConfig::plain(Trust, 0.02 * m, Yearly, Both),
        ],
        ShockKind::DateNights => vec![episode(0.15 * m, Weekly, Both)],
        ShockKind::Custom => Vec::new(),
    }
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
    /// Omitted means the kind's catalog default. Not used by `custom`.
    #[serde(default)]
    pub magnitude: Option<f64>,
    /// For trait_shift only: which trait moves.
    #[serde(default, rename = "trait")]
    pub trait_name: Option<String>,
    /// For custom only: a short name used in logs (letters, digits, spaces, hyphens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// For custom only: one plain sentence saying what happens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// For custom only: what the shock does, as effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<Vec<EffectConfig>>,
}

fn default_member() -> ShockMember {
    ShockMember::Random
}

/// Most effects one custom shock may carry.
pub const MAX_EFFECTS: usize = 8;

impl ShockConfig {
    /// Effective magnitude: the configured value or the kind's catalog default (0 for custom).
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

    /// The effects this shock applies: its own list for custom, the kind's list otherwise.
    pub fn effect_list(&self) -> Vec<EffectConfig> {
        match self.kind {
            ShockKind::Custom => self.effects.clone().unwrap_or_default(),
            kind => builtin_effects(kind, self.magnitude(), self.trait_name.as_deref()),
        }
    }

    /// The label folded to a log-safe slug: lowercase letters, digits and single underscores.
    pub fn label_slug(&self) -> String {
        let raw = self.label.as_deref().unwrap_or("custom").to_lowercase();
        let mut out = String::new();
        for ch in raw.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch);
            } else if !out.ends_with('_') && !out.is_empty() {
                out.push('_');
            }
        }
        let out = out.trim_end_matches('_').to_string();
        if out.is_empty() {
            "custom".to_string()
        } else {
            out
        }
    }
}

/// Longest run accepted (100 years), which keeps every day arithmetic inside i32.
pub const MAX_DAYS: u32 = 36_500;

/// Shock kinds with their bounds, for the picker (the eight named kinds; see `effect_catalog`).
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

/// Every effect channel with its operation, identity, bounds per cadence and extra fields, and
/// the effect list each named kind stands for at its default magnitude.
pub fn effect_catalog() -> serde_json::Value {
    let channels: Vec<serde_json::Value> = EffectChannel::all()
        .iter()
        .map(|c| {
            let cadences: serde_json::Map<String, serde_json::Value> = Cadence::all()
                .iter()
                .filter_map(|cad| {
                    c.bounds(*cad).map(|(lo, hi)| {
                        (
                            cad.as_str().to_string(),
                            serde_json::json!({"min": lo, "max": hi, "sustained": c.sustained(*cad)}),
                        )
                    })
                })
                .collect();
            serde_json::json!({
                "channel": c.as_str(),
                "op": match c.op() { EffectOp::Add => "add", EffectOp::Multiply => "multiply" },
                "identity": c.identity(),
                "cadences": cadences,
                "who": if *c == EffectChannel::OnsetHazard { vec!["both"] } else { vec!["member", "partner", "both"] },
                "classes": if *c == EffectChannel::Episode { EFFECT_EPISODE_CLASSES.to_vec() } else { Vec::new() },
                "traits": if *c == EffectChannel::Trait { SHIFTABLE_TRAITS.to_vec() } else { Vec::new() },
                "description": c.describe(),
            })
        })
        .collect();
    let kinds: serde_json::Map<String, serde_json::Value> = ShockKind::all()
        .iter()
        .map(|k| {
            let trait_name = if *k == ShockKind::TraitShift {
                Some("neuroticism")
            } else {
                None
            };
            let m = k.bounds().2;
            (
                k.as_str().to_string(),
                serde_json::to_value(builtin_effects(*k, m, trait_name))
                    .expect("effects serialise"),
            )
        })
        .collect();
    serde_json::json!({
        "channels": channels,
        "max_effects": MAX_EFFECTS,
        "label_max_chars": 40,
        "description_max_chars": 240,
        "builtin_at_default_magnitude": kinds,
    })
}

/// Validate one custom shock's label, description and effects against the shock's window.
fn validate_custom(i: usize, sh: &ShockConfig, days: u32) -> anyhow::Result<()> {
    let label = sh.label.as_deref().unwrap_or("");
    anyhow::ensure!(
        !label.trim().is_empty() && label.chars().count() <= 40,
        "shocks[{i}].label must be 1 to 40 characters for a custom shock"
    );
    anyhow::ensure!(
        label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '\''),
        "shocks[{i}].label may use only letters, digits, spaces, hyphens, underscores and apostrophes"
    );
    if let Some(d) = &sh.description {
        anyhow::ensure!(
            d.chars().count() <= 240 && !d.chars().any(|c| c.is_control()),
            "shocks[{i}].description must be at most 240 characters with no control characters"
        );
    }
    anyhow::ensure!(
        sh.magnitude.is_none() && sh.trait_name.is_none(),
        "shocks[{i}] is custom, so magnitude and trait go on its effects instead"
    );
    let effects = sh.effects.as_deref().unwrap_or(&[]);
    anyhow::ensure!(
        !effects.is_empty() && effects.len() <= MAX_EFFECTS,
        "shocks[{i}].effects must hold 1 to {MAX_EFFECTS} effects"
    );
    let shock_last = sh.last_day(days) as i64;
    for (j, e) in effects.iter().enumerate() {
        let at = format!("shocks[{i}].effects[{j}]");
        let ch = e.channel.as_str();
        let (lo, hi) = e.channel.bounds(e.cadence).ok_or_else(|| {
            anyhow::anyhow!(
                "{at}: the {ch} channel cannot act {}; allowed: {}",
                e.cadence.as_str(),
                Cadence::all()
                    .iter()
                    .filter(|c| e.channel.bounds(**c).is_some())
                    .map(|c| c.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
        anyhow::ensure!(
            e.op == e.channel.op(),
            "{at}: the {ch} channel takes op {:?}",
            e.channel.op()
        );
        anyhow::ensure!(
            e.amount.is_finite() && e.amount >= lo && e.amount <= hi,
            "{at}: amount must be within [{lo}, {hi}] for {ch} {}",
            e.cadence.as_str()
        );
        if e.channel == EffectChannel::OnsetHazard {
            anyhow::ensure!(
                e.who == EffectWho::Both,
                "{at}: onset_hazard acts on the couple, so who must be both"
            );
        }
        if e.channel == EffectChannel::Episode {
            let c = e.class.as_deref().unwrap_or("");
            anyhow::ensure!(
                EFFECT_EPISODE_CLASSES.contains(&c),
                "{at}: class must be one of {:?}",
                EFFECT_EPISODE_CLASSES
            );
        } else {
            anyhow::ensure!(
                e.class.is_none(),
                "{at}: class is only valid for the episode channel"
            );
        }
        if e.channel == EffectChannel::Trait {
            let t = e.trait_name.as_deref().unwrap_or("");
            anyhow::ensure!(
                SHIFTABLE_TRAITS.contains(&t),
                "{at}: trait must be one of {:?}",
                SHIFTABLE_TRAITS
            );
        } else {
            anyhow::ensure!(
                e.trait_name.is_none(),
                "{at}: trait is only valid for the trait channel"
            );
        }
        let es = e.start_day.unwrap_or(sh.start_day) as i64;
        let el = e.end_day.map(|v| v as i64).unwrap_or(shock_last);
        anyhow::ensure!(
            es >= sh.start_day as i64 && es <= shock_last,
            "{at}: start_day must fall inside the shock's window [{}, {shock_last}]",
            sh.start_day
        );
        anyhow::ensure!(
            el >= es && el <= shock_last,
            "{at}: end_day must fall inside the shock's window and not precede the effect's start"
        );
    }
    Ok(())
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
        if self.assignment.mode == AssignmentMode::Pairs {
            anyhow::ensure!(
                f == 0.5,
                "pairs mode treats one couple of every pair, so treatment_fraction must be 0.5"
            );
        }
        anyhow::ensure!(
            self.assignment
                .pair_weights
                .as_array()
                .iter()
                .all(|w| w.is_finite()),
            "pair_weights must be finite numbers"
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
        anyhow::ensure!(self.shocks.len() <= 64, "at most 64 shocks per run");
        // Logs name a custom shock by its slug, so two custom shocks must not share one.
        let mut slugs: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
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
            if sh.kind == ShockKind::Custom {
                validate_custom(i, sh, self.days)?;
                let slug = sh.label_slug();
                if let Some(j) = slugs.insert(slug.clone(), i) {
                    anyhow::bail!(
                        "shocks[{i}]: the custom shock name {:?} is logged as {slug:?}, the same as shocks[{j}]; give each custom shock its own name",
                        sh.label.as_deref().unwrap_or("")
                    );
                }
                continue;
            }
            anyhow::ensure!(
                sh.label.is_none() && sh.description.is_none() && sh.effects.is_none(),
                "shocks[{i}]: label, description and effects are only valid for a custom shock"
            );
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

    fn custom_json(effects: &str) -> String {
        format!(
            r#"{{"days": 200, "shocks": [{{"kind": "custom", "target": "all", "start_day": 20, "end_day": 120, "label": "in-law moves in", "description": "His mother moves in for a while.", "effects": [{effects}]}}]}}"#
        )
    }

    fn custom_err(effects: &str) -> String {
        SimConfig::from_json(&custom_json(effects))
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap_or_default()
    }

    #[test]
    fn custom_shocks_parse_and_validate() {
        let ok = custom_json(
            r#"{"channel": "stress", "op": "add", "amount": 0.4, "cadence": "daily", "who": "both"},
               {"channel": "onset_hazard", "op": "multiply", "amount": 1.3, "cadence": "daily", "who": "both"},
               {"channel": "episode", "op": "add", "amount": 0.3, "cadence": "weekly", "class": "conflict", "start_day": 30, "end_day": 90},
               {"channel": "trait", "op": "add", "amount": -0.1, "cadence": "once", "trait": "forgiveness", "who": "partner"}"#,
        );
        let cfg = SimConfig::from_json(&ok).unwrap();
        assert_eq!(cfg.shocks[0].effect_list().len(), 4);
        assert_eq!(cfg.shocks[0].label_slug(), "in_law_moves_in");
        assert_eq!(cfg.shocks[0].last_day(200), 120);
        // Round trip keeps every field.
        let again: SimConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(again.shocks, cfg.shocks);
        // Named kinds serialise exactly as before (no new fields appear).
        let named = SimConfig::from_json(
            r#"{"days": 100, "shocks": [{"kind": "job_loss", "target": "all", "start_day": 3}]}"#,
        )
        .unwrap();
        let v = serde_json::to_value(&named.shocks[0]).unwrap();
        assert!(
            v.get("label").is_none()
                && v.get("effects").is_none()
                && v.get("description").is_none()
        );
    }

    #[test]
    fn custom_shocks_whose_names_share_a_log_name_are_rejected() {
        let two = |a: &str, b: &str| {
            let effect = r#"{"channel": "stress", "op": "add", "amount": 0.4, "cadence": "daily", "who": "both"}"#;
            let shock = |label: &str| {
                format!(
                    r#"{{"kind": "custom", "target": "all", "start_day": 20, "end_day": 120, "label": "{label}", "effects": [{effect}]}}"#
                )
            };
            SimConfig::from_json(&format!(
                r#"{{"days": 200, "shocks": [{}, {}]}}"#,
                shock(a),
                shock(b)
            ))
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap_or_default()
        };
        let err = two("in-law move", "in_law_move");
        assert!(
            err.contains("shocks[1]") && err.contains("the same as shocks[0]"),
            "{err}"
        );
        assert!(two("Mother moves in", "mother moves in").contains("the same as shocks[0]"));
        assert_eq!(two("mother moves in", "father moves in"), "");
    }

    #[test]
    fn custom_shocks_reject_what_the_catalog_forbids() {
        let cases = [
            (
                r#"{"channel": "stress", "op": "add", "amount": 2.0, "cadence": "daily"}"#,
                "amount must be within [-1.5, 1.5]",
            ),
            (
                r#"{"channel": "stress", "op": "multiply", "amount": 1.0, "cadence": "once"}"#,
                "takes op Add",
            ),
            (
                r#"{"channel": "outside", "op": "add", "amount": 0.2, "cadence": "weekly"}"#,
                "cannot act weekly",
            ),
            (
                r#"{"channel": "onset_hazard", "op": "multiply", "amount": 2.0, "cadence": "daily", "who": "member"}"#,
                "who must be both",
            ),
            (
                r#"{"channel": "episode", "op": "add", "amount": 0.2, "cadence": "once"}"#,
                "class must be one of",
            ),
            (
                r#"{"channel": "episode", "op": "add", "amount": 0.2, "cadence": "once", "class": "joy"}"#,
                "class must be one of",
            ),
            (
                r#"{"channel": "trait", "op": "add", "amount": 0.2, "cadence": "once"}"#,
                "trait must be one of",
            ),
            (
                r#"{"channel": "stress", "op": "add", "amount": 0.2, "cadence": "once", "trait": "openness"}"#,
                "trait is only valid",
            ),
            (
                r#"{"channel": "stress", "op": "add", "amount": 0.2, "cadence": "once", "start_day": 5}"#,
                "inside the shock's window",
            ),
            (
                r#"{"channel": "stress", "op": "add", "amount": 0.2, "cadence": "once", "end_day": 150}"#,
                "inside the shock's window",
            ),
            (
                r#"{"channel": "repair_propensity", "op": "multiply", "amount": 0.0, "cadence": "daily"}"#,
                "amount must be within [0.1, 10]",
            ),
            (
                r#"{"channel": "affect", "op": "add", "amount": 1e400, "cadence": "once"}"#,
                "",
            ),
            (
                r#"{"channel": "policy_weight", "op": "add", "amount": 1.0, "cadence": "once"}"#,
                "unknown variant",
            ),
            (
                r#"{"channel": "stress", "op": "add", "amount": 0.1, "cadence": "once", "magnitud": 3}"#,
                "unknown field",
            ),
        ];
        for (effect, expect) in cases {
            let err = custom_err(effect);
            assert!(!err.is_empty(), "accepted: {effect}");
            assert!(
                err.contains(expect),
                "{effect}: expected {expect:?}, got {err}"
            );
        }
        assert!(custom_err("").contains("1 to 8 effects"));
        let nine = [r#"{"channel": "affect", "op": "add", "amount": 0.1, "cadence": "once"}"#; 9]
            .join(",");
        assert!(custom_err(&nine).contains("1 to 8 effects"));
        let bad_label = r#"{"days": 100, "shocks": [{"kind": "custom", "target": "all", "start_day": 1, "label": "<script>", "effects": [{"channel": "affect", "op": "add", "amount": 0.1, "cadence": "once"}]}]}"#;
        assert!(SimConfig::from_json(bad_label).is_err());
        let with_magnitude = r#"{"days": 100, "shocks": [{"kind": "custom", "target": "all", "start_day": 1, "label": "x", "magnitude": 1.0, "effects": [{"channel": "affect", "op": "add", "amount": 0.1, "cadence": "once"}]}]}"#;
        assert!(SimConfig::from_json(with_magnitude).is_err());
        let named_with_effects = r#"{"days": 100, "shocks": [{"kind": "job_loss", "target": "all", "start_day": 1, "effects": [{"channel": "affect", "op": "add", "amount": 0.1, "cadence": "once"}]}]}"#;
        assert!(SimConfig::from_json(named_with_effects).is_err());
    }

    #[test]
    fn every_named_kind_fits_the_channel_bounds_at_every_magnitude() {
        for kind in ShockKind::all() {
            let (lo, hi, default, _) = kind.bounds();
            for m in [lo, default, hi] {
                for e in builtin_effects(kind, m, Some("neuroticism")) {
                    let (blo, bhi) = e.channel.bounds(e.cadence).unwrap_or_else(|| {
                        panic!("{kind:?}: {:?} cannot act {:?}", e.channel, e.cadence)
                    });
                    assert!(
                        e.amount >= blo && e.amount <= bhi,
                        "{kind:?} at {m}: {e:?} outside [{blo}, {bhi}]"
                    );
                    assert_eq!(e.op, e.channel.op());
                }
            }
        }
    }

    #[test]
    fn effect_catalog_lists_every_channel_and_the_named_kinds() {
        let c = effect_catalog();
        assert_eq!(c["channels"].as_array().unwrap().len(), 8);
        assert_eq!(c["max_effects"], 8);
        let stress = &c["channels"][0];
        assert_eq!(stress["channel"], "stress");
        assert_eq!(stress["cadences"]["daily"]["sustained"], true);
        assert_eq!(stress["cadences"]["once"]["max"], 5.0);
        assert_eq!(
            c["builtin_at_default_magnitude"].as_object().unwrap().len(),
            8
        );
        // shock_catalog still lists only the eight named kinds.
        assert_eq!(shock_catalog().as_array().unwrap().len(), 8);
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

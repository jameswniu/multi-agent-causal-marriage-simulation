// Types mirroring docs/contracts.md: Parquet rows (section 1), summary.json (section 2), API (section 3).

export type Arm = 'control' | 'treatment';
export type RelState = 'dating' | 'married' | 'separated' | 'divorced' | 'broken_up';
export type Origin = 'initial' | 'remarriage';
export type ConflictOutcome = 'reconciled' | 'faded' | 'separated' | 'breakup' | 'open_at_end';

export interface AgentRow {
  agent_id: number;
  couple_id: number;
  arm: Arm;
  neuroticism: number;
  agreeableness: number;
  conscientiousness: number;
  openness: number;
  extraversion: number;
  forgiveness: number;
  commitment: number;
  closeness_pref: number;
  conflict_engagement: number;
  prior_relationships: number;
  prior_divorces: number;
  years_married: number;
  base_trust: number;
  relax_rate: number;
  initial_episodes: number;
  conflict_half_life_days: number;
  repair_half_life_days: number;
  positive_half_life_days: number;
  divorces_in_sim: number;
  marriages_in_sim: number;
  final_trust: number;
  final_memory_size: number;
}

export interface CoupleRow {
  couple_id: number;
  agent_a: number;
  agent_b: number;
  arm: Arm | null;
  origin: Origin;
  formed_day: number;
  married_day: number | null;
  compatibility: number;
  final_state: RelState;
  ended_day: number | null;
  years_married_at_start: number;
}

export interface EventRow {
  day: number;
  seq: number;
  couple_id: number;
  agent_id: number | null;
  kind: string;
  from_state: string | null;
  to_state: string | null;
  value: number | null;
}

export interface DailyRow {
  day: number;
  couple_id: number;
  state: RelState;
  in_conflict: boolean;
  conflict_days: number;
  intensity: number;
  positive_episode: boolean;
  trust_a: number;
  trust_b: number;
  affect_a: number;
  affect_b: number;
  satisfaction_a: number;
  satisfaction_b: number;
  neg_a: number;
  neg_b: number;
  pos_a: number;
  pos_b: number;
  stress_a: number;
  stress_b: number;
  /** Consecutive days without a warm memory on both sides (newer engines; absent means 0). */
  orphan_days?: number;
}

export interface DecisionRow {
  day: number;
  couple_id: number;
  agent_id: number;
  context: 'conflict' | 'separated';
  action: string;
  p_chosen: number;
  u_repair: number | null;
  u_hold: number | null;
  u_escalate: number | null;
  u_withdraw: number | null;
  u_leave: number | null;
  trust: number;
  affect: number;
  neg_load: number;
  pos_load: number;
  intensity: number;
  conflict_days: number;
  partner_last: string | null;
}

export interface ConflictRow {
  couple_id: number;
  started_day: number;
  ended_day: number | null;
  outcome: ConflictOutcome;
  peak_intensity: number;
  escalations: number;
  repair_attempts: number;
  duration_days: number | null;
}

export interface Outcome {
  name: string;
  label: string;
  unit: string;
  type: 'binary' | 'continuous' | string;
  level: 'couple' | 'agent' | 'conflict' | string;
  n_control: number;
  n_treatment: number;
  control_mean: number | null;
  treatment_mean: number | null;
  ate: number | null;
  ci_low: number | null;
  ci_high: number | null;
  ci_level: number;
  ci_method: string;
  n_boot: number;
  p_permutation: number | null;
  n_perm: number;
  conditional_on_post_treatment: boolean;
  note: string;
}

export interface BalanceRow {
  covariate: string;
  control_mean: number;
  treatment_mean: number;
  smd: number;
}

export interface ArmSeries {
  day: number[];
  control: number[];
  treatment: number[];
}

export interface BandSeries {
  day: number[];
  control_mean: number[];
  control_lo: number[];
  control_hi: number[];
  treatment_mean: number[];
  treatment_lo: number[];
  treatment_hi: number[];
}

export interface Curves {
  survival: ArmSeries;
  trust: BandSeries;
  in_conflict: ArmSeries;
  neg_load: ArmSeries;
}

export interface Histogram {
  bins: number[];
  control: number[];
  treatment: number[];
}

export interface Distributions {
  recovery_days: Histogram;
  conflicts_per_couple: Histogram;
}

export interface Seeds {
  population: number;
  assignment: number;
  dynamics: number;
}

export interface TreatmentSpec {
  /** "none" when the arms share the same memory parameters (a shock-only experiment). */
  parameter: string;
  control_value: number | null;
  treatment_value: number | null;
}

export interface ExperimentInfo {
  name: string;
  n_couples: number;
  days: number;
  seeds: Seeds;
  treatment: TreatmentSpec;
  /** Scheduled shocks; target "treatment" is part of the intervention, "all" hits everyone. */
  shocks?: ShockSpec[];
  determinism_hash: string;
}

export interface PairedOutcome {
  name: string;
  label?: string;
  mean_diff: number;
  ci_low: number;
  ci_high: number;
  n_pairs: number;
}

/** A governance run (placebo) carries the same outcome rows as the main run. */
export interface GovernanceRun {
  experiment?: Partial<ExperimentInfo>;
  outcomes: Outcome[];
  note?: string;
}

export interface TwinsRun {
  experiment?: Partial<ExperimentInfo>;
  paired: PairedOutcome[];
  outcomes?: Outcome[];
  note?: string;
}

export interface Summary {
  evidence_class: string;
  disclaimer: string;
  experiment: ExperimentInfo;
  arms: Record<Arm, { couples: number; agents: number }>;
  outcomes: Outcome[];
  balance: BalanceRow[];
  curves: Curves;
  distributions: Distributions;
  governance: { placebo: GovernanceRun | null; twins: TwinsRun | null };
}

export interface PolicySpec {
  kind: string;
  visibility: { sees: string[]; never_sees: string[] };
  sampling: { rule: string; temperature: number };
  contexts: Record<string, Record<string, string>>;
  weights: Record<string, number>;
  /** When leaving is on the menu for a married or separated couple (newer engines). */
  leave_rule?: { association_window_days: number; orphan_days_to_leave: number; unlock_intensity: number; applies_to: string[] };
}

export interface Manifest {
  engine: string;
  engine_version: string;
  evidence_class: string;
  name: string;
  n_couples: number;
  days: number;
  seeds: Seeds;
  arm_override: Arm | null;
  config: Record<string, unknown>;
  policy_spec: PolicySpec;
  files: Record<string, { rows: number; sha256: string }>;
  determinism_hash: string;
  summary: Record<string, unknown>;
  generated_at_unix: number;
}

export interface ExperimentResponse {
  manifest: Manifest;
  summary: Summary | null;
}

export interface CouplesQuery {
  arm?: Arm | '';
  state?: RelState | '';
  origin?: Origin | '';
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface CouplesResponse {
  total: number;
  items: CoupleRow[];
}

export interface CoupleDetailResponse {
  couple: CoupleRow;
  agents: AgentRow[];
  daily: DailyRow[];
  events: EventRow[];
  conflicts: ConflictRow[];
  decisions: DecisionRow[];
  episodes?: EpisodeRow[];
  legacies?: LegacyRow[];
}

export interface AgentDailyRow {
  day: number;
  couple_id: number;
  trust: number;
  affect: number;
  satisfaction: number;
  neg: number;
  pos: number;
  stress: number;
  state: RelState;
  orphan_days?: number;
}

export interface AgentDetailResponse {
  agent: AgentRow;
  couples: CoupleRow[];
  events: EventRow[];
  daily: AgentDailyRow[];
  episodes?: EpisodeRow[];
  decisions?: DecisionRow[];
  legacies?: LegacyRow[];
}

// Section 5: world replay.
export type StateChar = 'M' | 'C' | 'S' | 'D' | 'T' | 'B' | '-';

export interface ArmCounts {
  married: number;
  conflict: number;
  separated: number;
  divorced: number;
}

export interface WorldCount {
  day: number;
  control: ArmCounts;
  treatment: ArmCounts;
  remarriage: { dating: number; married: number };
}

export interface WorldResponse {
  days: number;
  couples: number[];
  arms: (Arm | null)[];
  origin: Origin[];
  states: string[];
  legend: Record<string, string>;
  counts: WorldCount[];
}

export interface EventsDayResponse {
  day?: number;
  items: EventRow[];
}

// Twins world: every couple simulated under both arms on the same random streams.
export interface TwinsWorldAvailable {
  available: true;
  days: number;
  couples: number[];
  states_control: string[];
  states_treatment: string[];
  diverged: number[];
  counts_control: ArmCounts[];
  counts_treatment: ArmCounts[];
  paired: PairedOutcome[];
}

export interface TwinsWorldUnavailable {
  available: false;
  reason: string;
}

export type TwinsWorldResponse = TwinsWorldAvailable | TwinsWorldUnavailable;

// Section 6: experiments, shocks, episodes.
export interface ExperimentListItem {
  name: string;
  dir: string;
  n_couples: number;
  days: number;
  seeds: Seeds;
  intervention: { memory: Record<string, [number, number]> | null; shocks: ShockSpec[] } | null;
  divorce_control: number | null;
  divorce_treatment: number | null;
  generated_at_unix: number;
}

export interface ExperimentsResponse {
  default: string;
  items: ExperimentListItem[];
}

export type ShockTarget = 'treatment' | 'control' | 'all';
export type ShockMember = 'a' | 'b' | 'random';

export interface ShockSpec {
  kind: string;
  target: ShockTarget;
  member: ShockMember;
  start_day: number;
  end_day: number | null;
  magnitude: number;
  trait?: string | null;
}

export interface ShockKind {
  kind: string;
  label: string;
  blurb: string;
  member_applies: boolean;
  /** Present for kinds that act on one named trait (trait_shift): the choices. */
  traits?: string[];
  magnitude: { min: number; max: number; default: number; unit: string };
  default_start_day: number;
  default_end_day: number | null;
}

export interface ShocksCatalog {
  kinds: ShockKind[];
}

export interface RunRequest {
  name?: string;
  n_couples?: number;
  days?: number;
  seeds?: Seeds;
  treatment: { conflict_half_life_days?: number; shocks?: Omit<ShockSpec, 'target'>[] };
  control?: Record<string, number>;
  world?: { shocks: Omit<ShockSpec, 'target'>[] };
  engine?: Record<string, unknown>;
  analysis?: { n_boot: number; n_perm: number };
  overwrite?: boolean;
}

export interface RunResponse {
  name: string;
  dir: string;
  summary: Summary;
}

/** The sealed record of a marriage that ended in divorce, one per member (newer engines). */
export interface LegacyRow {
  day: number;
  couple_id: number;
  agent_id: number;
  partner_id: number;
  ended_by: 'self' | 'partner' | 'time';
  conflicts: number;
  reconciled: number;
  final_trust: number;
  final_neg_load: number;
  final_pos_load: number;
  match_quality: number;
  commitment_shift: number;
  trust_prior: number;
}

export interface EpisodeRow {
  day: number;
  couple_id: number;
  agent_id: number;
  partner_id: number;
  kind: string;
  intensity: number;
  source: string;
  amplified: boolean;
}

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
  /** A forked world's record of its parent and the couple-by-couple comparison; absent or null otherwise. */
  parent?: ParentRecord | null;
}

/** One outcome's child-minus-parent difference over identical couples, with a cluster bootstrap interval. */
export interface PairedRow {
  name: string;
  mean_diff: number | null;
  ci_low: number | null;
  ci_high: number | null;
  n_pairs: number;
  share_changed: number | null;
}

export type ParentComparison =
  | { comparable: true; n_couples: number; arms: Record<'all' | 'control' | 'treatment', PairedRow[]> }
  | { comparable: false; reason: string };

export interface ParentRecord {
  parent: string;
  parent_determinism_hash: string;
  parent_engine_version: string;
  appended_shocks: ShockSpec[];
  comparison: ParentComparison;
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
  /** Records the two partners sealed when an earlier marriage of theirs ended (newer servers). */
  partner_legacies?: LegacyRow[];
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
  /** The world this one was forked from, when it is a fork. */
  parent?: string | null;
}

export interface ExperimentsResponse {
  default: string;
  items: ExperimentListItem[];
}

export type ShockTarget = 'treatment' | 'control' | 'all';
export type ShockMember = 'a' | 'b' | 'random';

export type EffectChannel = 'stress' | 'affect' | 'trust' | 'episode' | 'outside' | 'onset_hazard' | 'repair_propensity' | 'trait';
export type EffectCadence = 'once' | 'daily' | 'weekly' | 'yearly';
export type EffectWho = 'member' | 'partner' | 'both';

/** One effect of a custom shock: a channel, how much, how often, whom it hits, and an optional window inside the shock's. */
export interface EffectSpec {
  channel: EffectChannel;
  op: 'add' | 'multiply';
  amount: number;
  cadence: EffectCadence;
  who: EffectWho;
  class?: string | null;
  trait?: string | null;
  start_day?: number | null;
  end_day?: number | null;
}

export interface ShockSpec {
  kind: string;
  target: ShockTarget;
  member: ShockMember;
  start_day: number;
  end_day: number | null;
  /** Named kinds only; a custom shock carries an amount on each effect instead. */
  magnitude: number;
  trait?: string | null;
  /** Custom shocks only. */
  label?: string | null;
  description?: string | null;
  effects?: EffectSpec[] | null;
}

/** One effect channel as the engine's effect catalog describes it. */
export interface EffectChannelSpec {
  channel: EffectChannel;
  op: 'add' | 'multiply';
  identity: number;
  cadences: Partial<Record<EffectCadence, { min: number; max: number; sustained: boolean }>>;
  who: EffectWho[];
  classes: string[];
  traits: string[];
  description: string;
}

export interface EffectCatalog {
  channels: EffectChannelSpec[];
  max_effects: number;
  label_max_chars: number;
  description_max_chars: number;
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
  /** Days a shock with no end day lasts, or null when it runs to the end of the run. */
  default_length_days?: number | null;
  default_end_day: number | null;
}

export interface ShocksCatalog {
  kinds: ShockKind[];
  /** Present on servers that run custom shocks. */
  effects?: EffectCatalog;
}

/** One translated description: the shock it maps to, or why it maps to none (section 6). */
export interface TranslateResponse {
  translation_id: string;
  status: 'ok' | 'unsupported' | 'invalid';
  /** The validated shock (ok), or the shock as the model proposed it (invalid); null when unsupported. */
  spec: ShockSpec | null;
  words: string | null;
  rationale: string;
  model: string;
  errors: string[];
  message: string | null;
}

/** A shock as a run request carries it: the target is set by its section, and a custom shock has no magnitude. */
export type RunShock = Omit<ShockSpec, 'target' | 'magnitude'> & { magnitude?: number };

/** Points the server at the translation a shock came from; shock_index counts treatment shocks, then world shocks. */
export interface RunTranslation {
  translation_id: string;
  shock_index: number;
}

export interface RunRequest {
  name?: string;
  n_couples?: number;
  days?: number;
  seeds?: Seeds;
  treatment: { conflict_half_life_days?: number; shocks?: RunShock[] };
  control?: Record<string, number>;
  world?: { shocks: RunShock[] };
  engine?: Record<string, unknown>;
  analysis?: { n_boot: number; n_perm: number };
  overwrite?: boolean;
  translations?: RunTranslation[];
}

export interface RunResponse {
  name: string;
  dir: string;
  summary: Summary;
}

export type JobState = 'queued' | 'running' | 'done' | 'failed';

/** A queued engine run, as POST run, POST fork and GET /api/jobs/{id} report it. */
export interface JobResponse {
  job_id: string;
  kind: 'run' | 'fork';
  name: string;
  state: JobState;
  /** Place in line while queued (1 is next), else null. */
  position: number | null;
  error: string | null;
  created: number;
  started: number | null;
  finished: number | null;
}

/** POST /api/experiments/fork: the parent's world with these shocks appended and nothing else changed. */
export interface ForkRequest {
  parent: string;
  name?: string;
  shocks: (RunShock & { target: 'treatment' | 'all' })[];
  translations?: RunTranslation[];
}

export interface HealthResponse {
  ok: boolean;
  experiments: string[];
  /** Public mode: fixed names, no overwrite, capped runs, visitors see only their own runs. */
  public?: boolean;
  limits?: { max_couples: number; max_days: number };
  turnstile_site_key?: string | null;
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

/** One colour view of the town: a logged daily number per couple on a fixed range. */
export interface LensMeta {
  name: string;
  label: string;
  words: string;
  lo: number;
  hi: number;
  higher_is_worse: boolean;
}

export interface LensesResponse {
  items: LensMeta[];
}

/** A lens for one run: `bytes[day * couples + i]` is couple `i` of /api/world on that day, 0 to 254 over
 * [lo, hi], 255 when the couple does not exist that day. */
export interface LensData {
  name: string;
  days: number;
  couples: number;
  lo: number;
  hi: number;
  worseHigh: boolean;
  bytes: Uint8Array;
}

/** Event counts per day: `kinds[kind][group][day]`, groups control, treatment and remarriage. */
export interface DayDigest {
  days: number;
  groups: string[];
  kinds: Record<string, Record<string, number[]>>;
}

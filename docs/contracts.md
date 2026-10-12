# LoveWorld contracts

LoveWorld simulates 1,000 married agent couples for a year to test whether changing how long agents
remember a fight changes divorce, trust and repair. This file is the contract between its three
layers, which depend in one direction. The Rust engine writes Parquet, the Python package reads
Parquet and writes `summary.json`, and the FastAPI layer serves both to the React dashboard.
Change this file before changing a consumer.

## 1. Engine CLI (Rust, done)

Binary: `target/release/loveworld-engine` (built by `cargo build --release`).

```
loveworld-engine run --config <json|-> --out <dir> [--overwrite] [--arm-override control|treatment] [--name X]
loveworld-engine replay --manifest <dir>/manifest.json [--out <dir>]      # exit 0 iff every table hash matches
loveworld-engine policy-spec [--config <json>]                              # weights + formulas, JSON
loveworld-engine assign --config <json>                                     # ["control","treatment",...] by couple id
loveworld-engine default-config                                             # every parameter with defaults
loveworld-engine shock-catalog                                              # named shock kinds with magnitude bounds
loveworld-engine effect-catalog                                             # channels a custom shock may use, with bounds
```

`run` prints the manifest summary as one JSON line on stdout and timing on stderr.
`run` holds an exclusive `.<dir>.lock` next to `--out` for the whole call (a held lock fails the run,
a stale one is reported, never stolen), repairs any publication an earlier run left interrupted there,
stages the whole output in a hidden sibling `.<dir>.tmp-<pid>-<n>` and publishes it by rename once every
file is written. An existing `--out` is replaced only when it is empty or holds a `manifest.json`, and it
survives any failure: it is renamed to `.<dir>.old-<pid>-<n>` carrying a `.loveworld-swap.json` marker and
removed only once the new run is in place. The lock, marker and names are the Python runner's, so either
side recovers what the other left behind.
Config JSON may be partial; missing fields take defaults. Unknown keys are rejected at every level,
with the key named in the error, so a misspelt field can never quietly fall back to its default
(engine 0.2.1). Seeds: `seeds.population`, `seeds.assignment`, `seeds.dynamics`. Treatment arm memory
params: `memory.treatment`.

### Output directory

`manifest.json` (one per run): engine_version, evidence_class="simulation", name, n_couples, days,
seeds, arm_override, config (full), policy_spec, files{name:{rows,sha256}}, determinism_hash,
summary, generated_at_unix.

`config.json`: the full effective config.

`agents.parquet`, one row per agent of the initial couples (two per couple):

```
agent_id i64, couple_id i64, arm str,
neuroticism, agreeableness, conscientiousness, openness, extraversion f64 in [0,1],
forgiveness, commitment, closeness_pref, conflict_engagement f64 in [0,1],
prior_relationships i32, prior_divorces i32, years_married f64, base_trust f64, relax_rate f64,
initial_episodes i32,
conflict_half_life_days, repair_half_life_days, positive_half_life_days f64   (post-intervention),
divorces_in_sim i32, marriages_in_sim i32, final_trust f64, final_memory_size i32
```

`couples.parquet`, one row per couple (initial and remarriage):

```
couple_id i64, agent_a i64, agent_b i64,
arm str nullable            (null for remarriage couples),
origin str                  {initial, remarriage},
formed_day i32              (negative for initial couples: days before day 0),
married_day i32 nullable, compatibility f64,
final_state str             {dating, married, separated, divorced, broken_up},
ended_day i32 nullable, years_married_at_start f64
```

`events.parquet`, one row per event:

```
day i32, seq i32 (order within day), couple_id i64, agent_id i64 nullable (the actor),
kind str, from_state str nullable, to_state str nullable, value f64 nullable
```

Event kinds: intervention_applied, outside_encounter, conflict_started, escalated, withdrew,
repair_attempted, repair_rejected, reconciled, conflict_faded, separated, reunited, divorced,
broke_up, matched, married, disappointed, sealed (one per member on the day of a divorce; value is
the next relationship's trust prior), memory_consolidated (one per merge; value is the number of
episodes merged), and shock_<kind>. State transitions carry from_state and to_state.

`daily.parquet`, one row per couple-day while the couple is active, plus the day it ends:

```
day i32, couple_id i64, state str, in_conflict bool, conflict_days i32, intensity f64,
positive_episode bool,
trust_a, trust_b, affect_a, affect_b, satisfaction_a, satisfaction_b,
neg_a, neg_b, pos_a, pos_b, stress_a, stress_b f64,
orphan_days i32   (consecutive days without a warm memory on both sides; 0 while associated;
                   absent in runs from older engines, read as 0)
```

`decisions.parquet`, one row per agent decision in conflict or separation:

```
day i32, couple_id i64, agent_id i64, context str {conflict, separated}, action str, p_chosen f64,
u_repair, u_hold, u_escalate, u_withdraw, u_leave f64 nullable,
trust, affect, neg_load, pos_load, intensity f64, conflict_days i32, partner_last str nullable
```

`interventions.parquet`, one row per agent and parameter:

```
day i32, couple_id i64, agent_id i64, arm str, parameter str, control_value f64, applied_value f64
```

`episodes.parquet`, one row per memory episode stored, amplified or consolidated (columns in
section 6).

`legacies.parquet`, one row per member of a marriage that ended in divorce (section 7):

```
day i32, couple_id i64, agent_id i64, partner_id i64,
ended_by str {self, partner, time}, conflicts i32, reconciled i32,
final_trust, final_neg_load, final_pos_load, match_quality, commitment_shift, trust_prior f64
```

`conflicts.parquet`, one row per conflict episode:

```
couple_id i64, started_day i32, ended_day i32 nullable,
outcome str {reconciled, faded, separated, breakup, open_at_end},
peak_intensity f64, escalations i32, repair_attempts i32,
duration_days i32 nullable   (= ended_day - started_day + 1)
```

Day 0 is the first simulated day. `daily.day` runs 0..days-1. Initial couples start Married.
`neg_*` and `pos_*` in `daily` are the saturated loads the agents act on (see memory.load_saturation).

## 2. Python package (`python/`, package `loveworld`, managed by uv)

```
loveworld run <experiment.yaml> [--out results/<name>] [--overwrite]   # build engine config, run engine, run analyze
loveworld analyze <results_dir>                                          # write <results_dir>/summary.json, print table
loveworld placebo <experiment.yaml> [--out ...]                           # same experiment with treatment params := control params
loveworld twins <experiment.yaml> [--out ...]                             # arm-override both ways on the same seeds, paired effects
loveworld replay <results_dir>                                            # engine replay, exit non-zero on mismatch
loveworld serve <results_dir> [--port 8765]                              # FastAPI + built dashboard
loveworld build-engine                                                    # cargo build --release
```

Every engine command is stopped after 120 seconds (env `LOVEWORLD_ENGINE_TIMEOUT`, in seconds); the
stopped run's staging directory and lock are removed and an `EngineError` names the timeout.

`run`, `placebo` and `twins` publish through a staging directory under a per-target lock
(`.<name>.lock`, reported rather than stolen when stale). A run that dies between its two publication
renames leaves `.<name>.old-<pid>` carrying a `.loveworld-swap.json` marker; the next run of any
experiment in that root, and `serve` at startup in root mode, restores it (target missing) or removes
it (target present again). Nothing without that marker is ever deleted.

Experiment YAML (`experiments/example.yaml`):

```yaml
name: retention-90d
n_couples: 1000
days: 365
seeds: {population: 11, assignment: 22, dynamics: 33}
treatment:                      # the one intervention; everything else identical across arms
  conflict_half_life_days: 90   # control value comes from the engine default unless overridden below
control: {}                     # optional overrides of the control memory params
engine: {}                      # optional overrides of any other engine config key (dynamics, policy, market, assignment)
analysis:
  n_boot: 2000
  n_perm: 2000
  seed: 7
```

The package writes the effective engine config to `<results_dir>/config.json` via the engine.

### `summary.json` (written by `analyze`)

```json
{
  "evidence_class": "simulation",
  "disclaimer": "Findings describe simulated agents under an explicit rule-based policy; they are not evidence about human relationships.",
  "experiment": {"name": "...", "n_couples": 1000, "days": 365, "seeds": {},
                  "treatment": {"parameter": "conflict_half_life_days", "control_value": 14.0, "treatment_value": 90.0},
                  "determinism_hash": "..."},
  "arms": {"control": {"couples": 500, "agents": 1000}, "treatment": {"couples": 500, "agents": 1000}},
  "outcomes": [
    {"name": "divorce_rate", "label": "Divorced within the year", "unit": "share of couples", "type": "binary", "level": "couple",
     "n_control": 500, "n_treatment": 500, "control_mean": 0.05, "treatment_mean": 0.09,
     "ate": 0.04, "ci_low": 0.01, "ci_high": 0.07, "ci_level": 0.95, "ci_method": "bootstrap_percentile", "n_boot": 2000,
     "p_permutation": 0.01, "n_perm": 2000, "conditional_on_post_treatment": false, "note": ""}
  ],
  "balance": [{"covariate": "neuroticism", "control_mean": 0.45, "treatment_mean": 0.46, "smd": 0.02}],
  "curves": {
    "survival": {"day": [], "control": [], "treatment": []},
    "trust": {"day": [], "control_mean": [], "control_lo": [], "control_hi": [], "treatment_mean": [], "treatment_lo": [], "treatment_hi": []},
    "in_conflict": {"day": [], "control": [], "treatment": []},
    "neg_load": {"day": [], "control": [], "treatment": []}
  },
  "distributions": {
    "recovery_days": {"bins": [], "control": [], "treatment": []},
    "conflicts_per_couple": {"bins": [], "control": [], "treatment": []}
  },
  "governance": {"placebo": null, "twins": null}
}
```

Outcome names (fixed): divorce_rate, separation_rate, days_married (days until divorce or end),
final_trust (mean of both members on the couple's last logged day), mean_trust (mean over couple-days),
conflict_rate (conflicts per couple-year), escalations_per_conflict (conditional),
reconciliation_rate (share of conflicts reconciled; conditional), recovery_days (mean duration of
reconciled conflicts; conditional), remarriage_rate (agent level among divorced agents; conditional).
Conditional outcomes carry `conditional_on_post_treatment: true`.

Placebo and twins runs write their own results dir and `summary.json`; `analyze` on the main run
links them under `governance` when present at `<results_dir>/../<name>-placebo` and `-twins`.
Twins summary adds `"paired": [{"name": ..., "mean_diff": ..., "ci_low": ..., "ci_high": ..., "n_pairs": ...}]`.

## 3. HTTP API (FastAPI, `loveworld serve`)

All responses JSON. Numbers are plain floats; nulls allowed where the table is nullable.

```
GET /api/experiment        -> {"manifest": <manifest.json>, "summary": <summary.json or null>}
GET /api/ate               -> summary.outcomes (array)
GET /api/curves            -> summary.curves
GET /api/distributions     -> summary.distributions
GET /api/policy            -> manifest.policy_spec
GET /api/couples?arm=&state=&origin=&limit=100&offset=0&sort=couple_id
                           -> {"total": n, "items": [couples.parquet rows]}
GET /api/couples/{id}      -> {"couple": row, "agents": [agent row a, agent row b], "daily": [daily rows for the couple],
                               "events": [event rows], "conflicts": [conflict rows], "decisions": [decision rows]}
GET /api/agents/{id}       -> {"agent": agent row, "couples": [couple rows the agent belonged to], "events": [event rows where agent_id = id],
                               "daily": [{"day", "couple_id", "trust", "affect", "satisfaction", "neg", "pos", "stress", "state"}]}
GET /api/health            -> {"ok": true}
```

Static dashboard is served at `/` from `frontend/dist`. Dev mode: Vite on 5173 proxies `/api` to 8765.

## 4. Frontend (`frontend/`, Vite + React 18 + TypeScript + Recharts)

Pages (left nav): Overview (banner "Simulated evidence", experiment card, ATE table with CIs, forest plot),
Comparisons (survival, trust band, in-conflict share, negative load, recovery and conflict histograms),
Couples (filterable table, click to timeline: state Gantt, trust and affect lines for both members,
conflict shading, event markers, decision table), Agents (search by id, trait radar, memory loads over time,
events), Policy (weights table and formulas), Governance (placebo and twins results, balance table).
Build with `npm run build` into `frontend/dist`. Tests with Vitest and Testing Library against fixture JSON
in `frontend/src/fixtures/`.

## 5. World replay (added after the first draft; both layers implement it)

API addition:

```
GET /api/world             -> {"days": 365,
                               "couples": [couple_id, ...]            (initial couples first by id, then remarriage couples),
                               "arms": ["control"|"treatment"|null, ...] (same order),
                               "origin": ["initial"|"remarriage", ...],
                               "states": ["MMCM...", ...]              (one string per day, one char per couple, same order),
                               "legend": {"M": "married", "C": "married, in conflict", "S": "separated", "D": "divorced",
                                          "T": "dating", "B": "broken up", "-": "not formed yet"},
                               "counts": [{"day": 0, "control": {"married": n, "conflict": n, "separated": n, "divorced": n},
                                           "treatment": {...}, "remarriage": {"dating": n, "married": n}}, ...]}
GET /api/events?day=N      -> {"day": N, "items": [event rows of that day, in seq order]}
GET /api/events?from=A&to=B -> {"items": [event rows with A <= day <= B]}   (cap 5000 rows)
```

`states` is built from daily.parquet: a couple's char on a day is `C` when state is married and
in_conflict is true, otherwise the state's letter; a couple with no daily row that day is `-` before
its formed_day and keeps its terminal letter (`D` or `B`) after it ends.

Twins mode (the same couple under both arms, side by side). Source: the twins run named in
`summary.governance.twins.path` (absolute, or relative to the results dir), with subdirectories
`control` and `treatment`, each a full engine output; fallback `<results>/../<name>-twins`.

```
GET /api/twins/world
  -> {"available": true, "days": N,
      "couples": [initial couple ids 0..n_couples-1 in order],
      "states_control": ["MMC..." per day], "states_treatment": ["MMC..." per day]   (aligned index by index),
      "diverged": [number of couples whose letter differs that day, per day],
      "counts_control": [{"married", "conflict", "separated", "divorced"} per day],
      "counts_treatment": [same],
      "legend": {same as /api/world},
      "paired": summary.governance.twins.paired, "path": "<twins dir>"}
  -> {"available": false, "reason": "..."} with HTTP 200 when no twins run exists
GET /api/twins/couples/{id}
  -> {"control": <same shape as /api/couples/{id}, from the control twin run>,
      "treatment": <same, from the treatment twin run>}
  -> 404 when twins are absent or the id is unknown
```

State letters follow the `/api/world` rules, computed over the initial couples only. Both daily
tables are loaded once, lazily on the first twins request, and cached.

Frontend addition, page "World" (first item in the nav): a day scrubber with play, pause, speed
(1x, 10x, 50x days per second) and keyboard arrows; two tile grids side by side, control and
treatment, one tile per initial couple coloured by legend state with a short pulse on the day a
tile changes; a third smaller strip for remarriage couples; running counters per arm; an event
ticker listing the current day's events in plain words (couple id, kind, value); click a tile to
open that couple's detail page. Must stay smooth at 50x with 1,000 tiles (render tiles as a single
canvas or CSS grid of divs with className changes only; no per-tile React re-render per day).

Town view (added 2026-10-11). Where the browser offers WebGL, the World page opens on a town drawn
with PixiJS 8 (pinned at 8.21.0 and loaded only when the town is shown) in place of the grids. A Town
or Grid switch keeps the grids, which are also the fallback when WebGL is missing or the town fails to
start, and the twins mode always uses them. The town reads only `/api/world` and
`/api/couples?limit=10000`, for the two agent ids of every couple, and draws a pure layout from them
(`frontend/src/town/layout.ts`). Control lots sit left of a central plaza and treatment lots right of
it, in couple id order, 20 to a row. Remarried couples that marry at some point in the run get
new-home lots at the foot of the plaza, each roof half in the colour of the arm its partner first
married in, and a pair that only dates never gets a lot.

Each day an agent's place is a function of that day's state letters. `M` stands both partners at
home. `C` puts both outside and apart under a conflict sign. `S` sends one partner, a fixed choice by
couple id, to the plaza edge on its district's side while the other stays home. `D` and `B` make both
single, each at a fixed spot in the plaza, and `T` walks the pair together in the plaza's dating
area. The walk between two days' places is cosmetic: it snaps at 50x and on jumps of more than one
day, and it is never stored or read back. Below 24 screen pixels per lot only the houses are drawn.
The town must stay smooth at 50x with 2,000 figures. Measured on 2026-10-11 on an Apple M5 Pro
(headless Chromium on Metal), the frame time averaged 8.3 ms with a 95th percentile of 9.2 ms, and
updating every figure took 0.18 ms a frame.

## 6. Experiment picker, on-demand runs and shocks (added 2026-10-10 late)

### Shocks (engine)

A shock is a scheduled stressor applied to one arm or to everyone. The engine config gains a
`shocks` list; each entry has this shape.

```
{"kind": "job_loss" | "financial_crisis" | "temptation" | "intimacy_mismatch",
 "target": "treatment" | "control" | "all",
 "member": "a" | "b" | "random",        (ignored by financial_crisis, which hits both)
 "start_day": 90, "end_day": 210,        (end_day null means the kind's default length, or to the end of the run when it has none)
 "magnitude": 1.0}                        (kind-specific, see below)
```

What each kind does, in engine terms (every application is logged as an `interventions.parquet`
row with parameter = kind and applied_value = magnitude, and as an event `shock_<kind>`):

- job_loss: on start_day the member's stress jumps by `magnitude` and then carries an extra
  `0.1 * magnitude` of daily stress until end_day (default start_day + 120).
- financial_crisis: both members of every targeted couple carry `0.3 * magnitude` extra daily
  stress from start_day to end_day.
- temptation: the member's daily outside-encounter probability becomes `magnitude` (a probability,
  default 0.2) and encountered candidates are drawn 0.1 more compatible, from start_day to end_day.
- intimacy_mismatch: on start_day the member's closeness preference moves by `magnitude` (plus or
  minus, clamped to [0, 1]); a new dynamics term lowers affect by the couple's closeness gap, and
  each week the partner who wants more closeness may store a `disappointment` episode (negative,
  conflict class) with probability proportional to the gap.

A random member is drawn once per couple and shock from its own keyed stream (`seeds.dynamics`,
domain `shock_member_<shock index>`, couple id), never from the couple's own stream, so a shock that
does nothing leaves every other row exactly as it was; a zero-magnitude job loss is the test. Engine
0.2.1 made this change, which moves the table hashes of every run with a random-member shock: shock
experiments written by 0.2.0 replay only on 0.2.0, and runs without shocks keep their hashes.

`target: treatment` is an intervention (the treatment arm gets it, control does not).
`target: all` is a world event that hits both arms equally, so the memory treatment is tested under
stress. Remarriage couples have no arm and only receive `all` shocks.

Experiment YAML gains `treatment.shocks` (a list, target forced to treatment) and `world.shocks`
(a list, target forced to all). The engine config's own `shocks` key is not allowed under `engine:`.

Engine 0.3.0 runs every kind through one effect path and adds `kind: "custom"`, a shock written as
its own list of effects. Section 9 has its shape, the bounds, and the fixed list each named kind
stands for.

### Serving many experiments

`loveworld serve <dir>` accepts either one results dir (with summary.json) or a results root; every
child dir with a summary.json is an experiment, and `-placebo` and `-twins` dirs attach to their
parent by name and are not listed on their own. Every existing endpoint accepts
`?experiment=<name>` (default: the single experiment, or the first by name). At most two experiments
stay loaded in memory at once (env `LOVEWORLD_MAX_LOADED`), since one loaded year of 1,000 couples holds
about half a gigabyte; the least recently used is dropped and read again from disk when it is next asked for.

```
GET  /api/experiments      -> {"default": name, "items": [{"name", "dir", "n_couples", "days", "seeds",
                               "intervention": {"memory": {parameter: [control, treatment]} | null, "shocks": [...]},
                               "divorce_control", "divorce_treatment", "generated_at_unix"}]}
GET  /api/shocks/catalog   -> {"kinds": [{"kind", "label", "blurb", "member_applies", "magnitude": {"min","max","default","unit"},
                               "default_start_day", "default_length_days", "default_end_day"}],
                               "effects": {"channels": [{"channel", "op", "identity", "cadences": {cadence: {"min","max","sustained"}},
                               "who", "classes", "traits", "description"}], "max_effects", "label_max_chars",
                               "description_max_chars", "builtin_at_default_magnitude"}}   (effects: section 9)
POST /api/experiments/run  -> body {"name"?, "n_couples"? (<= 2000), "days"? (<= 730), "seeds"?,
                               "treatment": {"conflict_half_life_days"?, ..., "shocks"?: [...]},
                               "control"?, "world"?: {"shocks": [...]}, "engine"?, "analysis"?: {"n_boot" (<= 500), "n_perm" (<= 500)},
                               "overwrite"?: false}
                              runs the engine and the analysis synchronously (about ten seconds at 1,000 x 365)
                              -> {"name", "dir", "summary"}; 409 if the name exists and overwrite is false; 400 on validation errors
```

### Frontend

A top-bar experiment select (persisted in the URL as `?experiment=`) feeds every page. A
"New experiment" panel (its own route) offers a name, couples, days, the memory half-life for the
treatment arm (default equal to control, so a shock-only experiment is possible), a shock picker
built from `/api/shocks/catalog` (kind, which partner, start and end day, magnitude slider, and
whether it hits the treatment arm only or everyone), and a Run button that posts to
`/api/experiments/run`, shows progress, and selects the new experiment on success.

Positive kinds, same shape, same logging:

- daily_texts: from start_day to end_day the member sends affection every day; the partner stores a
  `positive` episode of intensity `0.05 * magnitude` and gains `0.02 * magnitude` affect that day.
- anniversary: on start_day and every 365 days after it, both members store a `positive` episode of
  intensity `0.5 * magnitude` and trust rises by `0.02 * magnitude` (member is ignored).
- date_nights: every seventh day from start_day to end_day, both members store a `positive` episode
  of intensity `0.15 * magnitude`.

### Episodes table and the developer log

The engine writes one more table, `episodes.parquet`, one row per memory episode stored or amplified
during the run (history episodes seeded before day 0 are included with their negative day).

```
day i32, couple_id i64, agent_id i64, partner_id i64, kind str, intensity f64,
source str   {history, conflict, escalation, withdrawal, rejection, reconciliation, separation,
              divorce, affiliation, shock:<kind>, disappointment, consolidated},
amplified bool   (true when an existing episode was raised rather than a new one stored)
```

A `consolidated` row records a weekly merge (section 7). It is dated on the day of the merge, its
kind is grievance, reconciliation or positive, and its intensity is the merged load on that day.
Inside the engine the merged episode keeps the latest merged day and an intensity that reproduces
the same strength, so the row is the readable view of the merge, not a new fresh memory.

`/api/couples/{id}` and `/api/agents/{id}` gain an `"episodes"` list (rows for that couple, or for
that agent). The dashboard shows a collapsed "Under the hood" panel on the couple and agent pages
(a details element, closed by default). Opened, it lists the days in order and, per day and per
member, the episodes stored with kind and intensity, the retained negative and positive load, trust
and affect with their change from the previous day, stress, the decision with its probabilities, and
any shock applied that day. A day filter and a member filter sit at the top; nothing renders while
the panel is closed, so the page stays fast.

An eighth kind, trait_shift, takes an extra field `trait` (one of neuroticism, agreeableness,
conscientiousness, openness, extraversion, forgiveness, commitment, closeness_pref,
conflict_engagement) and on start_day moves the member's trait by `magnitude` (plus or minus,
clamped to [0, 1]); its intervention row's parameter reads `trait_shift:<trait>`. The catalog entry
carries `"traits": [...]` so the picker can offer them. Any correlation the dashboard shows between a
baseline trait and an outcome within one arm is descriptive and must be labelled as such; the causal
version is this shock.

## 7. Memory governance (added 2026-10-11)

Four rules borrowed from how a long-lived memory store retires, seals and consolidates what it
holds. None of them differs between arms, and the intervention never writes them.

Config keys (all overridable under `engine:` in an experiment file, unlike `memory`):

```
memory_rules.plateau_days f64 = 2        days at full intensity before decay starts (0 = none)
memory_rules.consolidate_after usize = 8  merge when more episodes than this of one class about the
                                          current partner are older than the plateau (0 = never)
memory_rules.freeze_during_separation bool = true
association.window_days u32 = 42          a warm memory on both sides within the window = associated
association.orphan_days_to_leave u32 = 21 consecutive orphaned days before a married couple in a
                                          conflict is offered leave (0 = no gate)
association.unlock_intensity f64 = 0.95   an open conflict at or above this offers leave regardless
legacy.commitment_shift f64 = 0.3         added to the leave utility in every later relationship
legacy.trust_prior_weight f64 = 0.5       weight of the sealed final trust in the next starting trust
```

Rules:

1. Plateau. An episode's strength is `intensity * 0.5 ^ (max(0, age - plateau_days) / half_life)`.
2. Consolidation (weekly, before pruning). For the current partner only, and never for a frozen one,
   when more than `consolidate_after` episodes of one class are older than the plateau they become
   one standing episode (grievance, reconciliation or positive) dated at the latest of them, whose
   strength today equals their summed valence-weighted strength; it matches their sum on every
   later day too. The episode of a conflict that is still open is never merged. Each merge logs an
   episodes row (`source = consolidated`) and a `memory_consolidated` event.
3. Freeze. On separation both members' episodes about each other hold their strength and are
   exempt from pruning; on reunion or divorce each episode's day moves forward by the time it spent
   frozen.
4. Leave gate. Every day a couple is associated when both members stored a warm memory (positive or
   reconciliation) about each other on or after `day - window_days + 1`, and `orphan_days` counts
   the consecutive days it was not. A married couple in a conflict is offered leave only when
   `orphan_days >= orphan_days_to_leave` or the conflict's intensity is at least
   `unlock_intensity`; otherwise the leave utility is absent from the decision (`u_leave` null).
   Dating couples and separated couples are not gated.
5. Legacy. On the day a marriage ends in divorce, before the divorce episodes are stored, each
   member seals it from live state: who ended it, conflicts closed and reconciled in that marriage,
   final trust and the loads about the partner. `trust_prior = clamp((1 - w) * base_trust + w *
   final_trust, 0.05, 0.95)` sets the starting trust of the agent's next relationship (this replaces
   the earlier per-divorce trust penalty), and `commitment_shift` is added to its leave utility in
   every later relationship. A seal is minted from that marriage alone, and a second divorce
   replaces it. Divorces before day 0 (the population's prior divorces) carry no seal.

`policy_spec` gains `leave_rule` (`applies_to`, `association_window_days`, `orphan_days_to_leave`,
`unlock_intensity`, `rule`) and `legacy` (`legacy_shift`, `rule`).

API: `/api/couples/{id}` and `/api/agents/{id}` (and both twins variants) gain a `"legacies"` list,
and agent `daily` rows gain `orphan_days`. A run from an older engine serves an empty list and zeros.

Dashboard: the Under the hood panel lists sealed marriages in plain sentences above the days and,
on any day the couple is orphaned, a line with the orphan count and whether leaving is open. The
World page's day ticker leaves `memory_consolidated` events out of its list and states how many it
left out.

## 8. Shocks described in plain words (added 2026-10-11)

A visitor can describe an event in their own words ("he loses his job in month three for four
months") instead of filling in the shock fields. One model call translates the description into a
shock of the eight catalog kinds, the visitor reads and edits the result on a card, and the run goes
through the ordinary run endpoint. The model's only job is translation: it never runs the engine, it
sees the shock catalog and the run length and nothing else (no memory, policy, arm or seed
settings), and nothing it writes reaches the engine config, so replay never calls it.

```
POST /api/shocks/translate -> body {"text" (1 to 400 characters), "days"? (1 to 730, default 365)}
                             -> {"translation_id", "status": "ok" | "unsupported" | "invalid",
                                 "spec": {"kind", "target": "treatment" | "all", "member", "start_day", "end_day",
                                          "magnitude", "trait"} | null,
                                 "words", "rationale", "model", "errors": [...], "message"}
                             400 on a bad body; 503 when the server has no key or the model service is down
```

- The call: the Anthropic Messages API, model `LOVEWORLD_TRANSLATE_MODEL` (default `claude-haiku-5-5`),
  a 20 second timeout (`LOVEWORLD_TRANSLATE_TIMEOUT`), the description wrapped in `<description>` tags as
  data, and the answer forced through one tool, `submit_shock`, whose input is the shock spec plus a
  one-sentence rationale or `supported: false`. There is no temperature: current Claude models reject the
  parameter, and the recorded spec, not the model, is what a replay uses.
- The key is read on the server only: `ANTHROPIC_API_KEY`, else the first macOS Keychain service in
  `LOVEWORLD_KEYCHAIN_SERVICES` (default `loveworld-anthropic`) that holds one. To name another service, put
  `LOVEWORLD_KEYCHAIN_SERVICES=...` in an untracked `.env` file at the repository root, which only `make serve`
  reads; the port is a make variable (`make serve PORT=...`), not a `.env` setting. It is
  looked up again on the next request when missing, so adding a key needs no restart.
- The guard is validation, not the prompt. Every answer goes through `parse_shock`, the same parser an
  experiment file uses. `ok` returns the validated spec with a finite kind's end day resolved from its
  catalog length; `invalid` returns the spec as the model proposed it with the parser's error, never
  clamped; `unsupported` returns a message naming the kinds. Identical descriptions (lower-cased, spaces
  collapsed) for the same run length and model are answered from an in-process cache.
- Every translation is also written to `<results root>/.translations/<translation_id>.json` (the hash of
  the description, never the text, plus the spec, status, rationale and model), a hidden directory the
  experiment list never shows. A run can therefore be traced to its translation after the cache has
  moved on and across server restarts.
- `words` follows the dashboard's `shockWords` exactly, for example "One partner loses their job (a random
  partner, treatment arm), days 60 to 180, magnitude 1.5 (stress)".

The run body may add `"translations": [{"translation_id", "shock_index"}]` (at most 32), where
`shock_index` counts the experiment's shocks in parse order, treatment shocks first and then world
shocks. The client only points; the server writes `translation.json` beside `summary.json` in the same
publication as the run, from its own record:

```
{"translations": [{"shock_index", "translation_id", "verified": true, "text_sha256", "model",
                   "status_when_translated", "spec_as_translated", "spec_as_run", "edited"}]}
```

`text_sha256` hashes the normalised description (the text itself is not stored), and `edited` is
computed on the server by comparing the shock as run with the shock as translated. A translation id
the server has no record of, in memory or in `.translations/`, is recorded as `"verified": false`
with the shock as run, and the run still goes ahead. An entry with any other key, or a `shock_index`
past the experiment's shocks, is a 400. The engine config, the table hashes and replay are unchanged.

Dashboard: the New experiment page has a "Describe what happens" box above Add shock. Translate adds
a shock row prefilled from the spec, with a card above its fields showing the visitor's words, the
plain-words reading of the row as it stands (it follows every edit), the model's rationale, the model
name, any validation error, and a note once the row has been changed. When the answer was invalid,
fields the model got wrong fall back to the kind's defaults, and the run stays blocked until the
visitor changes a field or presses "These fields are right", so a wrong answer never runs unseen. An
unsupported description shows its message and adds no row. The World page header links here with `?describe=1`,
which puts the cursor in the box.

## 9. Custom shocks built from effects (added 2026-10-11, engine 0.3.0)

A shock of `kind: "custom"` carries its own list of effects instead of a named kind, so an event
that none of the eight kinds covers can still run. The translator writes one when the words fit no
named kind, and anyone can write or edit one by hand. Every effect acts on a quantity the engine
already models, inside fixed bounds, and the engine runs it as deterministically as any other shock.

```
{"kind": "custom", "target": "treatment" | "control" | "all", "member": "a" | "b" | "random",
 "start_day": 30, "end_day": 90,                       (end_day null means to the end of the run)
 "label": "mother moves in",                            (1 to 40 letters, digits, spaces, hyphens, underscores, apostrophes)
 "description": "His mother moves in for two months.",  (optional, at most 240 characters, and it runs nothing)
 "effects": [                                           (1 to 8)
   {"channel": "stress", "op": "add", "amount": 0.4, "cadence": "daily", "who": "both"},
   {"channel": "onset_hazard", "op": "multiply", "amount": 1.3, "cadence": "daily", "who": "both"},
   {"channel": "episode", "op": "add", "amount": 0.3, "cadence": "weekly", "who": "member",
    "class": "conflict", "start_day": 40, "end_day": 80}]}
```

A custom shock takes no `magnitude` or `trait`, since amounts and traits live on its effects. Each
effect's `op` must be its channel's own operation, and `who` defaults to `member`. `who` is relative
to the shock's member: `member` is the partner the event happens to, `partner` is their spouse, and
`both` is both. An effect's own `start_day` and `end_day` are optional and must lie inside the
shock's window. Unknown keys are rejected here as everywhere else in the config, and a run takes at
most 64 shocks. The logs name a custom shock by its label slug, the label in lowercase with each run
of other characters turned into one underscore, so two custom shocks in one run may not share a slug
("in-law move" and "in_law_move" both give `in_law_move`). The engine, the Python layer and the form
all refuse such a pair.

| Channel | Op | Cadences and amount bounds | Who | What it does |
|---|---|---|---|---|
| Stress (`stress`) | Add | Once, weekly or yearly -3 to 5, daily -1.5 to 1.5 | Any | Once, weekly or yearly, the amount is added to stress (0 to 3) on each day it acts. Daily, it is a standing daily stress input for the window, so stress settles higher instead of climbing |
| Affect (`affect`) | Add | Once or yearly -1 to 1, weekly -0.5 to 0.5, daily -0.1 to 0.1 | Any | Added to mood toward the partner (-1 to 1) on each day it acts |
| Trust (`trust`) | Add | Once or yearly -0.5 to 0.5, weekly -0.1 to 0.1, daily -0.02 to 0.02 | Any | Added to trust (0 to 1) on each day it acts |
| Memory (`episode`) | Add | Once or yearly 0 to 2, weekly 0 to 1, daily 0 to 0.25 | Any | Stores a memory about the partner of the effect's `class` (positive, conflict, repair or disappointment), with the amount as its intensity, on each day it acts |
| Outside chance (`outside`) | Add | Daily 0 to 1 | Any | Sets the daily chance of meeting an attractive alternative for the window, in place of `dynamics.outside_encounter_prob` (0.02 by default), with candidates 0.1 more compatible. The strongest active value wins |
| Fight onset (`onset_hazard`) | Multiply | Daily 0 to 5 | Both only | Multiplies the couple's daily chance that a fight starts, capped at 1 |
| Repair odds (`repair_propensity`) | Multiply | Daily 0.1 to 10 | Any | Multiplies the odds of choosing repair, or reunite when separated |
| Trait (`trait`) | Add | Once -1 to 1, yearly -0.25 to 0.25 | Any | Moves the trait named in `trait` (0 to 1), one of the nine the effect catalog lists |

Shocks act only on days a couple is dating or married. An effect acts on the days its cadence picks
inside its window, counted from the window's first day: every day, every seventh day, or every
365th. A once effect acts on the first day of its window the couple qualifies. The daily stress,
outside, onset and repair effects are standing modifiers, installed on that same first day and
expiring after the window's last day. An effect whose amount is its channel's identity (0 to add,
1 to multiply) does nothing at all, so a shock of zeros leaves every behavioural table exactly as it
was, and a test runs one effect of every channel at its identity to hold that.

The eight named kinds are fixed effect lists (`config::builtin_effects` in the engine,
`schema.builtin_effects` in Python), and the engine runs every shock through the same effect code.
A parity test runs each kind at its default, maximum and minimum magnitude both as itself and as a
custom shock carrying its list, and requires the daily, decision, conflict, legacy and episode rows
to be identical apart from the episode source name. At magnitude m the lists are these.

| Kind | Effects |
|---|---|
| Job loss | Stress once +m and stress daily +0.1m, on the member |
| Financial crisis | Stress daily +0.3m, on both |
| Temptation | Outside chance daily m, on the member |
| Intimacy mismatch | Trait closeness_pref once +m, on the member |
| Trait shift | The named trait once +m, on the member |
| Daily texts | A positive memory of 0.05m and mood +0.02m every day, on the partner |
| Anniversary | A positive memory of 0.5m and trust +0.02m every year, on both |
| Date nights | A positive memory of 0.15m every week, on both |

Intimacy mismatch only moves the trait. The lower mood from a closeness gap and the weekly
disappointment memories described in section 6 are dynamics every couple has, shocked or not, so
they follow from the wider gap, and the parity test covers them.

The policy sees the repair odds through `repair_bias`, the sum of the natural logs of the agent's
active multipliers (0 without one). The repair and reunite utilities add `temperature*repair_bias`,
so a combined multiplier m multiplies the odds of choosing repair by exactly m at any temperature,
and `policy-spec` prints the term in both formulas. The fight onset multiplier applies after
`conflict_onset_prob` and before the draw, so the number of draws never changes. No channel reaches
memory half-lives, the memory rules, the leave gate, policy weights, the temperature, assignment,
seeds or the arm, and a test holds the channel set and the effect code to that.

Every custom shock is logged. On the first day an effect acts on a couple, each partner it hits
gets an `interventions.parquet` row for it, with parameter `custom:<label slug>:<channel>` (plus
`:<class>` or `:<trait>`), control_value the channel's identity and applied_value the amount, so an
effect whose own window starts later logs its start on that later day. Each partner with an effect
starting that day also gets one event `shock_custom:<label slug>` whose value is the number of their
effects that started. Each later weekly or yearly firing logs a couple-level event of the same name
with the amount as its value. A once, daily or standing effect logs only its start, and every memory
an effect stores is an `episodes.parquet` row with source `shock:custom:<label slug>`. Named kinds
log exactly as before.

`loveworld-engine effect-catalog` prints every channel with its op, identity, bounds per cadence,
allowed `who`, classes, traits and description, plus each named kind's list at its default
magnitude. Python holds the same catalog in `schema.EFFECT_CHANNELS` and `schema.effect_catalog()`,
and a test requires the two to be equal. `GET /api/shocks/catalog` returns it as `effects`, next to
`kinds`.

The translator's one forced tool, `submit_shock`, also takes `kind: "custom"` with a label, a
description and up to 8 effects, and its prompt lists every channel with its bounds. A description
that fits no named kind becomes a custom shock. Only text that is not about a couple's life at all
is unsupported. A custom answer goes through the same parser and bounds, an amount out of range
comes back as a visible error and is never clamped, and `edited` in `translation.json` compares the
label and every effect but not the description. The New experiment card lists each effect in plain
words ("both partners: stress up 0.4 every day, days 30 to 90"), and the amount, how often and whom
it hits stay editable before Run.

Runs written by engine 0.2.1 replay identically on 0.3.0, since `replay` reruns the recorded config
and compares table hashes. That was checked table by table for all eight kinds at their default
magnitude and at one extreme, each with a random and a fixed member, for a run mixing five kinds
across both arms, and for the job-loss, daily-texts, neuroticism-shift and crisis-under-retention
experiments and the example. The one exception is a magnitude-0 daily_texts, anniversary,
date_nights or temptation shock. In 0.2.1 those stored zero-intensity memories or held the outside
chance at 0, and in 0.3.0 they do nothing. Runs with custom shocks need 0.3.0.

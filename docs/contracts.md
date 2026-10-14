# LoveWorld contracts

LoveWorld simulates 1,000 married agent couples for a year to test whether changing how long agents
remember a fight changes divorce, trust and repair. This file is the contract between its three
layers, which depend in one direction. The Rust engine writes Parquet, the Python package reads
Parquet and writes `summary.json`, and the FastAPI layer serves both to the React dashboard.
Change this file before changing a consumer.

## 1. Engine CLI (Rust, done)

Binary: `target/release/loveworld-engine` (built by `cargo build --release`).

```
loveworld-engine run --config <json|-> --out <dir> [--overwrite] [--arm-override control|treatment] [--name X] [--published <dir>]
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
side recovers what the other left behind. A run published over the same world, the same config with the same
hash for every table, keeps the published `generated_at_unix`, so publishing an unchanged world again rewrites
none of its bytes and `make example` run twice leaves git clean. The engine compares with the run in `--out`,
or in `--published <dir>` when a caller stages the run and publishes it itself (the Python runner, section 2).
Config JSON may be partial; missing fields take defaults. Unknown keys are rejected at every level,
with the key named in the error, so a misspelt field can never quietly fall back to its default
(engine 0.2.1). Seeds: `seeds.population`, `seeds.assignment`, `seeds.dynamics`. Treatment arm memory
params: `memory.treatment`.

### The same bytes on every platform

One config writes the same bytes on every platform, so its table hashes and determinism hash are the same on
macOS and Linux, on Arm and on x86. Every exp, log, power and cosine the engine computes comes from the libm
crate, a maths library written in plain Rust and pinned at 0.2.16 with its few hardware routines turned off
(`force-soft-floats`), never from the platform's own maths library, which rounds some results differently in
the last bit. Everything else the engine does with floats (arithmetic, square roots, rounding to whole numbers
and comparisons) gives the same bits on every machine, since IEEE 754 requires arithmetic and square roots to
be correctly rounded and the rest to be exact, and it happens in a fixed order. Three checks keep it so.
`clippy.toml` refuses the standard float methods that would call the platform library (exp, ln, powf, cos and
the others, and powi), `engine/tests/maths.rs` pins the exact bits those functions give for inputs the engine
uses, and CI replays the committed example on Linux x86_64 before it regenerates anything, then rebuilds it
from scratch and fails if any committed file of it changed or went missing, `summary.json` and the manifest's
`generated_at_unix` included, or if a new file appeared. The only platform maths left in the binary belongs to the Parquet writer's
decimal columns and bloom filters, and the engine writes neither. On macOS (Apple silicon), linux/arm64 and
linux/amd64 (run under emulation), the example, its placebo, its twins and the three demo worlds (section 14)
came out as the same bytes, `config.json` and `summary.json` included, apart from each manifest's
`generated_at_unix`.

A release that can change what a config writes bumps the engine version (`engine_version` in every manifest),
and this file says which version made the change and which earlier runs it no longer replays. Engine 0.3.1
moved the maths to libm. That moves the table hashes of every run, so runs written by 0.3.0 or earlier do
not replay on 0.3.1. They replay on the earlier engines, as sections 6 and 9 say, and only on the platform
that wrote them. What the runs say did not change: on the example and the three demo worlds every column that
is not a float came out as under 0.3.0 on macOS, and no float moved by more than 3e-14.

### Output directory

`manifest.json` (one per run): engine_version, evidence_class="simulation", name, n_couples, days,
seeds, arm_override, config (full), policy_spec, files{name:{rows,sha256}}, determinism_hash,
summary, generated_at_unix (when this world was first published, kept when the same world is published
again), and `pairs` in a pairs-mode run only (section 13).

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
pair_id i64 nullable        (pairs-mode runs only, section 13; null for remarriage couples),
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
loveworld demo [<results root>]                                           # run experiments/demo/ on the example (section 14)
loveworld static [<results root>] [--site site]                           # export the read-only demo's data (section 14)
loveworld build-engine                                                    # cargo build --release
```

Every engine command is stopped after 120 seconds (env `LOVEWORLD_ENGINE_TIMEOUT`, in seconds); the
stopped run's staging directory and lock are removed and an `EngineError` names the timeout.

`run`, `placebo` and `twins` publish through a staging directory under a per-target lock
(`.<name>.lock`, reported rather than stolen when stale). A run that dies between its two publication
renames leaves `.<name>.old-<pid>` carrying a `.loveworld-swap.json` marker; the next run of any
experiment in that root, and `serve` at startup in root mode, restores it (target missing) or removes
it (target present again). Nothing without that marker is ever deleted. The runner names its target to the
engine with `--published`, so a run, a placebo, a twins half or a run the API publishes with its twins keeps
the published `generated_at_unix` when it is the same world as the one in place (section 1).

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

`curves.trust` is each day's mean trust by arm with a band of 1.96 standard errors around it. Its standard
deviation is taken in two passes, from the sum of squared deviations from the day's mean, because pandas'
one-pass groupby std rounds its last bit differently on macOS and Linux. So `summary.json` is the same bytes on
every platform too.

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
                                           "treatment": {...}, "remarriage": {"dating": n, "married": n}}, ...],
                               "determinism_hash": "..."}              (the manifest's hash of the run the states were read from)
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
it, in couple id order, with as many lots to a row as make the whole town fit the canvas best (8 to 80,
worked out again when the canvas resizes). Remarried couples that marry at some point in the run get
new-home lots at the foot of the plaza, each roof half in the colour of the arm its partner first
married in, and a pair that only dates never gets a lot.

Each day an agent's place is a function of that day's state letters. `M` stands both partners at
home. `C` puts both outside and apart under a conflict sign. `S` sends one partner, a fixed choice by
couple id, to the plaza edge on its district's side while the other stays home. `D` and `B` make both
single, each at a fixed spot in the plaza, and `T` walks the pair together in the plaza's dating
area. The walk between two days' places is cosmetic: it snaps at 50x and on jumps of more than one
day, and it is never stored or read back. Below 24 screen pixels per lot each person is drawn as a
dot that still walks, in its arm's colour at home, yellow in a conflict, red when one partner has
walked out and grey in the plaza.
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
A loaded experiment whose results on disk were replaced since it was read (a run published over it by this
server, the command line or any other process, told by its `manifest.json`) is read again on its next
request rather than served from memory, and results replaced while they were being read are read once more.
While a run holds the lock to publish over a loaded experiment, the copy in memory is served in the moment
between the two renames when the results are missing; with no copy in memory that moment answers 503, to
be tried again, or 404 when not even the directory is there. Results missing with no run publishing are
gone: the copy in memory is dropped and the request is a 404.

```
GET  /api/experiments      -> {"default": name, "items": [{"name", "dir", "n_couples", "days", "seeds",
                               "intervention": {"memory": {parameter: [control, treatment]} | null, "shocks": [...]},
                               "divorce_control", "divorce_treatment", "generated_at_unix", "determinism_hash", "parent": name | null}]}
GET  /api/shocks/catalog   -> {"kinds": [{"kind", "label", "blurb", "member_applies", "magnitude": {"min","max","default","unit"},
                               "default_start_day", "default_length_days", "default_end_day"}],
                               "effects": {"channels": [{"channel", "op", "identity", "cadences": {cadence: {"min","max","sustained"}},
                               "who", "classes", "traits", "description"}], "max_effects", "label_max_chars",
                               "description_max_chars", "builtin_at_default_magnitude"}}   (effects: section 9)
POST /api/experiments/run  -> body {"name"?, "n_couples"? (<= 2000), "days"? (<= 730), "seeds"?,
                               "treatment": {"conflict_half_life_days"?, ..., "shocks"?: [...]},
                               "control"?, "world"?: {"shocks": [...]}, "engine"?, "analysis"?: {"n_boot" (<= 500), "n_perm" (<= 500)},
                               "overwrite"?: false}
                              validates, then queues the run (section 10) -> 202 {"job_id", "state", ...};
                              with ?wait=true it answers when the run is done -> {"job_id", "name", "dir", "summary"};
                              409 if the name exists and overwrite is false; 400 on validation errors; 429 when the queue is full
```

A run sent without a name (or with an empty one) is named by the server: `exp-` and the UTC date and time to
the second, such as `exp-20261014-121530`, with `-2`, `-3` and so on added when that name is taken. A name is
taken while a results directory of that name, its `-twins` or `-placebo` sibling, or its lock or its twins' lock
(`.<name>.lock`, `.<name>-twins.lock`) is on disk, or while a run for it is queued or running. The server names
and queues every run, named or not, under one lock, so two runs started in the same second get two names. A name
the visitor typed is never changed. It is a 409, which says why, while a run for it is queued or running, while
its lock or its twins' lock is on disk (a run that stopped while publishing leaves its lock, and the 409 says to
remove it if it is stale), and when its results or its twins already hold files and overwrite is not set. Its
`-placebo` sibling is no reason, since an experiment's placebo is run before it.

### Frontend

A top-bar experiment select (persisted in the URL as `?experiment=`) feeds every page. A
"New experiment" panel (its own route) offers a name (left empty, the server names the run as above, and the
field shows an example of that name), couples, days, the memory half-life for the
treatment arm (default equal to control, so a shock-only experiment is possible), a shock picker
built from `/api/shocks/catalog` (kind, which partner, start and end day, magnitude slider, and
whether it hits the treatment arm only or everyone), and a Run button that posts to
`/api/experiments/run`, shows progress, and opens the new experiment on the World page when it is done
(section 12). Since section 10 a "Start from" picker comes first: it defaults to the world in the URL,
which forks that world instead.

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
                                 "words", "rationale", "model", "errors": [...], "message",
                                 "reused": true | false, "recorded": "2026-10-12T01:33:33-07:00" | null}
                             400 on a bad body; 503 when the words need the model and the server has no key,
                             or the model service is down
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
  looked up again on the next request when missing, so adding a key needs no restart. A server with no key
  still answers words it has a saved translation for (below), by the model it is set to use, and answers 503
  only for words that need the model.
- The guard is validation, not the prompt. Every answer goes through `parse_shock`, the same parser an
  experiment file uses. `ok` returns the validated spec with a finite kind's end day resolved from its
  catalog length; `invalid` returns the spec as the model proposed it with the parser's error, never
  clamped; `unsupported` returns a message naming the kinds.
- Every translation is also written to `<results root>/.translations/<translation_id>.json` (the hash of
  the description, never the text, plus the spec, status, rationale, model, run length and `recorded`, the
  server's local time with its UTC offset when the record was written), a hidden directory the experiment
  list never shows. A run can therefore be traced to its translation after the cache has moved on and
  across server restarts.
- The same words get the same shock. Words translated before, with the same `text_sha256` (a SHA-256 of the
  description lowercased with its spacing collapsed), for a run of the same length by the same model, are
  answered from the saved record instead of the model. Those three are everything a request gives the model
  besides the prompt. Checking the record again catches a change to the parser or to the catalog's bounds: it
  must have come back `ok`, and its spec must still pass today's `parse_shock` for its run length and come out
  unchanged. A change to the prompt alone is not caught, so words translated before it keep their saved shock.
  Such an answer makes no model call, counts against no quota and writes no record. It is the saved record,
  with its own `translation_id`, spec, rationale and model, `reused: true`, the `recorded` time it was saved
  and `words` written again by today's `shock_words`. Other words, another run length or model, or a record
  that came back `invalid` or `unsupported` or no longer passes the parser unchanged, make one model call as
  before and save a new record (`reused: false`). A request field added later that changes the translation
  joins the three.
- Identical descriptions whose answer came back `invalid` or `unsupported` are answered again from an
  in-process cache, as before reuse existed: the same answer with no model call, no new record and
  `reused: false`, until the server restarts or the cache moves on. Such an answer is never reused from its
  record, so after a restart those words go to the model again. Two requests for the same words at once make
  one model call: the second is answered from the first's record when it came back `ok`, else from that cache.
- The demo's cards (section 14) hand their saved records to the live app's translator, each dated by its
  card's `translation.recorded`, and those answer their own words before any record in `.translations`, which
  need not hold them (a fresh clone holds none). So words a card shows typed come back as the shock the card
  shows, with the card's date, in any results root and with or without a key. While a reusable record exists
  no other is written for the same words, so only records written before reuse existed can share them. Of
  those the newest that still passes answers, by `recorded`, or for a record from before `recorded` existed by
  its file's modification time, which a copy can change. Such a record is never dated from its file: its
  `recorded` is null.
- `words` is the plain sentence the dashboard's `shockWords` writes for the same spec, for example "In every
  treatment couple, one partner picked at random loses their job on day 60, so their stress jumps by 1.5 that
  day and stays raised until day 180." Python writes it with `translate.shock_words`, a port of the dashboard's
  code, and `frontend/src/fixtures/shockWords.json` holds shocks of every kind with their sentences, which a
  Python test and a frontend test both require, so the two cannot drift apart.

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
the server has no record of, in memory, in `.translations/` or on a demo card, is recorded as `"verified": false`
with the shock as run, and the run still goes ahead. An entry with any other key, or a `shock_index`
past the experiment's shocks, is a 400. The engine config, the table hashes and replay are unchanged.

Dashboard: the New experiment page has a "Describe what happens" box above Add shock. Translate adds
a shock row prefilled from the spec, with a card above its fields showing the visitor's words, the
plain-words reading of the row as it stands (it follows every edit), the model's rationale, the model
name, any validation error, and a note once the row has been changed. A translation the server answered from
its saved record says so under the visitor's words, at the card's 16px, while the row is still that shock:
"Same words as on 12 October 2026, so the same shock, with no new model call." A record that carries no date
says "as an earlier translation" in place of the date. Once the row is changed, the note that it was changed
takes its place. When the answer was invalid,
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
words ("Stress goes up 0.4 every day for both partners from day 30 to day 90."), and the amount, how often
and whom it hits stay editable before Run.

Runs written by engine 0.2.1 replay identically on 0.3.0, since `replay` reruns the recorded config
and compares table hashes. That was checked table by table for all eight kinds at their default
magnitude and at one extreme, each with a random and a fixed member, for a run mixing five kinds
across both arms, and for the job-loss, daily-texts, neuroticism-shift and crisis-under-retention
experiments and the example. The one exception is a magnitude-0 daily_texts, anniversary,
date_nights or temptation shock. In 0.2.1 those stored zero-intensity memories or held the outside
chance at 0, and in 0.3.0 they do nothing. Runs with custom shocks need 0.3.0.

## 10. Forked worlds, the run queue and public mode (added 2026-10-11)

### Forking a world

A fork re-runs a finished world with shocks added and nothing else changed. The server reads the
parent's own `config.json` (its seeds, assignment, memory for both arms, policy and every engine
setting), appends the new shocks to its shock list, and runs that config under a new name with the
parent's analysis settings (resamples capped at 500). Because shock partners come from their own keyed
stream, a fork with zero-magnitude shocks has behavioural tables identical to its parent's, so a
difference between a fork and its parent is what the added shocks did to the very same couples.

```
POST /api/experiments/fork -> body {"parent": name, "name"?, "shocks": [{"kind", "target": "treatment" | "all",
                               "member"?, "start_day"?, "end_day"?, "magnitude"?, "trait"?}] (1 to 16),
                               "translations"?: [{"translation_id", "shock_index"}]}
                             -> 202 {"job_id", ...}, or with ?wait=true {"job_id", "name", "dir", "summary"}
                             404 unknown parent; 400 on any other key, an empty or invalid shock list, a name equal to
                             the parent's or ending in -placebo or -twins; 409 when the name exists (forks never overwrite)
```

`shock_index` counts the fork's `shocks` in the order sent. A fork sent without a name is named
`<parent>-fork-<UTC date>-<time>` with the parent's name cut to 36 characters, such as
`example-fork-20261014-121530`, and gets `-2`, `-3` and so on when that name is taken, by the rules and under
the lock a run without a name follows (section 6). A typed name gets the 409s a typed run name gets (section 6),
and a fork never overwrites. The child's results directory gains `parent.json`, written in the same publication
as the run:

```
{"parent", "parent_determinism_hash", "parent_engine_version", "appended_shocks": [...],
 "comparison": {"comparable": true, "n_couples", "arms": {"all" | "control" | "treatment": [
                 {"name", "mean_diff", "ci_low", "ci_high", "n_pairs", "share_changed"}]}}
              | {"comparable": false, "reason"}}
```

The comparison is child minus parent for each couple, averaged over the couples of each arm (and over
all of them), with a percentile bootstrap that resamples couples, or blocks under block assignment, for
the same six outcomes the twins summary pairs. It is refused, with the reason, when the parent was run
again while the fork waited (its determinism hash moved) or when the two runs came from different
engine versions. `GET /api/experiment` returns the record as `"parent"` (null for a world that is not
a fork), and the experiment list carries the parent's name.

### The run queue

Engine runs execute one at a time, in arrival order, on a worker thread inside the API. POST run and
POST fork validate the request first (all the 400 and 409 answers above happen before anything is
queued), then queue the run and answer 202 at once.

Every run and fork queued this way also runs its twins, inside the same job: each couple under both
arms on the run's own config and seeds, into `<name>-twins`, the way `loveworld twins` does it for an
experiment file. The run and its twins are simulated and analysed side by side in one staging
directory and published together (`runner.run_with_twins`), so the run's `summary.json` links them under
`governance.twins`, and a run that fails at any step, an overwrite included, leaves the earlier run and
its own twins as they were. The job's run cap, queue limit and public rules therefore cover the twins
too. A `<name>-twins` directory that already exists is a 409 before anything is queued, unless a run sets
`overwrite` (a fork never does).

Readers check that the twins beside a run were made for it, since a publication that stops between its
two renames can still leave the new twins beside the earlier run. Twins count for a run only when both
halves' manifests carry the run's own engine config apart from `name` and `arm_override` (each half's
`arm_override` its own arm), and, where the run's summary recorded the halves' determinism hashes under
`governance.twins.runs`, only when they are those very runs. Otherwise `/api/twins/world` answers
`available: false` with the reason, `/api/twins/couples/{id}` is a 404, the list's `has_twins` is false,
and `/api/experiment` serves the summary with `governance.twins` null, so the dashboard uses its words for
a run without twins. The summary file itself is left as the run wrote it. The check is made again
whenever the run's summary or a twins run beside it changes on disk, so twins made or replaced later
are judged afresh rather than answered from memory. With identical arms, as in a run with no intervention, the twins never
differ, and `/api/twins/world` reports zero diverged couples on every day.

```
GET /api/jobs/{job_id} -> {"job_id", "kind": "run" | "fork", "name", "state": "queued" | "running" | "done" | "failed",
                           "position" (1 is next, null unless queued), "error", "created", "started", "finished"}
                          404 for an unknown job (or, in public mode, another visitor's)
```

At most `LOVEWORLD_QUEUE_MAX` runs (default 3) may wait besides the running one; one more is answered
429 with a plain busy message. A name already queued or running is a 409. A failed run reports the
same message and status the synchronous endpoint used to answer with (409 for a results directory that
is not ours, 400 for an engine or configuration error), and `?wait=true` turns them back into the
HTTP answer. The engine timeout and the per-target lock still apply. Jobs live in memory, so a restart
forgets them; finished experiments stay on disk. The queue belongs to one server process, so the API runs
as a single process (`loveworld serve` and the Docker image both do); the translation counters lock their
file and stay correct even if several processes share a results root.

### Public mode

`LOVEWORLD_PUBLIC=1` (off by default) makes the dashboard safe to serve to strangers. It needs a
results root, not a single results directory.

- Experiments present at startup are curated and read-only. Overwrite is refused, and the default
  experiment is `example` when it exists, else the first curated one; with no curated experiment there
  is no default, so a request that names none is a 404 rather than someone else's run.
- Every visitor gets a signed session cookie, `lw_session` (an id and an HMAC of it, HttpOnly,
  SameSite=Lax, secure behind HTTPS). Their runs and forks get server-assigned names,
  `v-<session id>-<UTC date>-<time>`, any client-sent name is ignored, and those runs are visible only
  to that visitor: every `/api` request naming another visitor's run is a 404, and the list and health
  endpoints show the curated worlds plus the visitor's own. A visitor may have one run queued or
  running at a time (429 otherwise).
- Visitor runs are deleted after `LOVEWORLD_VISITOR_TTL_HOURS` (default 24) by a sweeper that runs at
  startup and every ten minutes, together with the `-twins` (or `-placebo`) run beside each, which ages
  with its run. Curated names and their siblings are never swept.
- A public run may set only `treatment.conflict_half_life_days`, `treatment.shocks`, `world.shocks`,
  `n_couples` and `days`. `engine`, `control`, `seeds`, `overwrite` and any other treatment key are a
  400, the analysis is fixed by the server (500 bootstrap and 500 permutation resamples, seed 7, 95%
  intervals, whatever the client sends), and runs (or forks of a world) are capped at
  `LOVEWORLD_PUBLIC_MAX_COUPLES` (1,000) couples and `LOVEWORLD_PUBLIC_MAX_DAYS` (365) days, checked
  after defaults apply, and at 16 shocks. Every POST to `/api` needs a `Content-Length` (411 without)
  of at most 64 KB (413 above).
- Translations keep the 400-character input cap and add a daily cap per client address
  (`LOVEWORLD_TRANSLATE_PER_IP_DAY`, default 20) and overall (`LOVEWORLD_TRANSLATE_GLOBAL_DAY`, default
  3,000), counted only for real model calls (an answer given again, from a saved translation or the
  in-process cache, is free) in
  `<results root>/.public/counters.json`, keyed by an HMAC of the address and reset at UTC midnight, so
  a restart keeps the counts. Either cap answers 429.
- With `LOVEWORLD_EDGE_SECRET` set, every POST to `/api` must carry `x-loveworld-edge` equal to it
  (403 otherwise), and the client address for the caps is `x-loveworld-client-ip`, trusted only on a
  request that carries the secret. The edge proxy (`deploy/cloudflare-worker/worker.js`) checks a
  Cloudflare Turnstile token before adding both headers.
- Signing uses `LOVEWORLD_SESSION_SECRET`, or a secret created once in `<results root>/.public/secret`
  with owner-only permissions.

```
GET /api/health -> {"ok", "experiments": [...], "public": bool,
                    "limits"?: {"max_couples", "max_days"}, "turnstile_site_key"?: string | null}
```

The dashboard reads `public` to hide the name and overwrite fields and apply the caps, and, when a
`turnstile_site_key` is set, renders the check and sends its token as `cf-turnstile-response` on the
next POST. Deployment is in `docs/deploy.md`.

## 11. World page views: colour lenses, a day digest and the couple panel (added 2026-10-11)

Three read-only views of a finished run keep the World page cheap to play. They read only the tables
the engine wrote (`python/loveworld/world_views.py`) and are built once per experiment on first use.

```
GET /api/lenses            -> {"items": [{"name": "grudge", "label": "Grudge", "words": "...", "lo": 0.0, "hi": 1.5,
                                          "higher_is_worse": true}, ...]}
GET /api/lens/{name}       -> application/octet-stream, days x couples bytes, day-major, couples in /api/world order
                              headers X-Lens-Days, X-Lens-Couples, X-Lens-Lo, X-Lens-Hi, X-Lens-Worse-High ("1" or "0")
                              404 for an unknown lens, or a run whose daily table lacks the lens columns
GET /api/digest            -> {"days": N, "groups": ["control", "treatment", "remarriage"],
                               "kinds": {kind: {group: [count per day, N entries]}}}
```

Lenses are trust (`trust_a`, `trust_b`, range 0 to 1), stress (`stress_a`, `stress_b`, 0 to 1.5),
grudge (`neg_a`, `neg_b`, 0 to 1.5), warmth (`pos_a`, `pos_b`, 0 to 1.5), satisfaction
(`satisfaction_a`, `satisfaction_b`, 0 to 1) and days without warmth (`orphan_days`, 0 to 42). A
couple's value on a day is the mean of the lens columns in its daily row. Byte `b` from 0 to 254
stands for `lo + b / 254 * (hi - lo)`, values outside the range are clipped, and 255 means the couple
has no daily row that day. Byte `day * couples + i` belongs to the couple at position `i` of
`/api/world`'s `couples`. Ranges are fixed, so a colour means the same value in every experiment.

The digest counts every event of the run by kind, day and group. A couple's group is its arm for an
initial couple and `remarriage` otherwise, and every kind that occurs lists all three groups.

`/api/couples/{id}` gains `"partner_legacies"`, the records the couple's two partners sealed when an
earlier marriage of theirs ended in divorce before this couple formed (section 7), oldest first. The
panel shows a record only from the day it was sealed.

Dashboard. The town's toolbar picks a lens, which recolours every house on a green, yellow and red
ramp from the good end to the bad end, with a key that gives each district's mean for the day. The
page fetches a lens once per experiment and lens. A mini-map in the town's corner shows every lot and
a box for the view, and a click moves the view there. When the town is under 600 pixels wide it shows
one district at a time with a switch between control, the plaza and treatment, and on screens 640
pixels wide or less the mini-map hides.

Each district's title (its arm's label and how many couples it holds) stands on the district, at 16px. A town
600 pixels wide or more shows the whole label, on as many lines as it needs, with its bottom edge just above the
first row of houses and clear of any conflict sign there, and the camera keeps room above the districts for the
tallest title: the whole town is drawn at the largest scale that leaves that room, and a town that fits the
canvas sits no higher than the room allows. So a title never covers a house or a ring, and once the view is
zoomed or dragged past the top of the town the titles move off with it. A narrower town keeps each title to
one line, cut at its district's edge, since the switch above the canvas names every district in full.

Clicking a house, a married person or a grid tile opens a couple panel beside the town in place of
leaving the page, and clicking a single in the plaza still opens that agent's page. It shows the couple's state on the replay's day, both partners' trust and mood over the
run with a marker on that day, today's grudge and warmth loads, any sealed records, the last five
events up to that day, and a link to the full couple page. Escape or its Close button closes it and
returns focus to where it was opened. A Next event button jumps the replay to the inspected couple's
next day with an event, leaving `memory_consolidated` out.

The time bar labels the day as "Day 143, week 21". Under the scrubber a density strip draws, per arm
and per day, a bar for conflicts started and ticks for separations and divorces from the digest, a
band for each shock while it is active, and a cursor on the day, and a click jumps to that day. While
the replay plays, the ticker shows the day's counts from the digest. The list of a day's events is
fetched only while paused, 120 ms after the day stops changing.

## 12. Shocking a world in place (added 2026-10-12)

"Shock this world" on the World page opens the shock composer right above the town, in place of
sending the visitor to the New experiment page. It is the same composer that page uses
(`frontend/src/components/ShockComposer.tsx`, with the pure request builders in
`frontend/src/shockForm.ts`): the plain-words box, the editable shock card, the same validation, the
bot check in public mode, and the fork-plus-job flow of section 10. The panel only forks the world
being watched, leaves the name to the server, and shows the run waiting its turn and running inline.

When the job is done, the page switches to the new world in place: the URL's `experiment` becomes the
child, and the World page replays it at ten days a second from ten days before the earliest day any
added shock acts (a custom shock acts from its earliest effect), or from day 0 without shocks. The
replay starts once the town is drawn and the parent world has loaded, and never waits more than eight
seconds for them. Run on the New experiment page lands the same way. The World page, the Overview, Comparisons
and a couple's page show a world only once its arm labels, which come from its experiment and the shock catalog,
have loaded with its own data, so a switch never shows placeholder words (an arm called Control, or "a placebo
run") for a moment before the right ones. When its experiment cannot be loaded they say so in place of the world,
since its labels would stay placeholders. A catalog that cannot be loaded only leaves the kinds' names plainer.

A forked world's World page reads its parent's states as well (`/api/world?experiment=<parent>`) and
compares the two worlds day by day under "Compared with the world it came from"
(`frontend/src/worldDiff.ts`), but only while the parent the API serves is the run the fork was made
from: the `determinism_hash` that comes with the parent's states must equal `parent_determinism_hash`
in `parent.json`. Both are the engine's hash of every table a run wrote, so a parent run again under
the same name with anything changed fails the check, while one run again exactly as it was writes the
same tables and passes. A page left open also reads the experiment list again whenever it comes back into
view and every two minutes while in view, and a parent whose listed `determinism_hash` has moved since fails
the check too. When the check fails, or either hash is missing, the page draws no rings, no counter and no
switch, and says in one sentence that the world this one came from was run again after the fork (or cannot
be checked), so houses are not compared. Only the couples both worlds start with are
compared, matched by couple id, since a remarriage can pair different people under the same id. Each day:

- Every house whose couple's state letter differs from the same couple's in the parent gets a ring, in
  one colour (`#ff2bd6`) that no arm, state or lens uses, about three screen pixels wide at any zoom,
  and the mini-map outlines the same lots. The Grid view rings the same couples' tiles in the same
  colour, three pixels wide inside the tile, and its key says what a ring means.
- A counter reads "N of 1,000 couples differ from <parent> today".
- A switch draws the parent on the same day instead, with the parent's own couples table and arm
  labels and the same rings. The scoreboard, the counts and the events stay with the child and say so,
  colour lenses are hidden, and a house opened then opens that couple in the parent.
- The couple-by-couple table over the whole year stays on the child's Overview, under Versus its
  parent, and the panel links to it.

The town opens on the whole town, or on one district at a time on a phone. On a phone, a world whose added
shocks all reach only the treatment arm opens on that district, where its rings are, and the town keeps the
district when it draws the parent. Plus and minus zoom, drag pans, the wheel zooms about the pointer, and Whole
town returns to the opening view. There is no separate plaza view. Switching between the child and its parent
keeps the camera where it was.

A run with no intervention (equal memory in both arms and no shock aimed at one arm alone) says so where
the gap between the arms shows, in a box on the World page that stays through the replay and in a
headline on its Overview. Every run started from the app brings its twins (section 10), and when the
run's summary links them the words lead with them: run on the same 1,000 couples, the two settings give
identical results, and 0 of 1,000 couples end differently (identical behaviour tables, or every paired
outcome unchanged). The gap between the two halves follows as the second line, since they are
different couples and two different groups never come out exactly even, with the divorce gap
(treatment minus control), its interval and whether that interval includes zero. Without twins the
first line says both halves follow identical rules, so the gap comes only from splitting the couples in
two. The "Same couples, both arms" view of such a run reports 0 couples whose fate differs on every day.

## 13. Matched pairs (added 2026-10-12)

`assignment.mode` takes `pairs` beside `couple` (the default) and `block`:

```yaml
engine:
  assignment: {mode: pairs}
```

The engine scores every initial couple from six values the population draws before day 0: the two
partners' mean neuroticism, conscientiousness, agreeableness, base trust and prior divorces, and the
couple's years married. Each is standardised over the run's population (mean zero, population standard
deviation one) and weighted by `assignment.pair_weights`, whose defaults and their fit are in
docs/design.md under Matched pairs. Couples are sorted by score, ties by couple id, and cut into
consecutive pairs numbered from the lowest score up. One fair coin per pair, drawn from the stream keyed
by (assignment seed, `pair`, pair id), treats the member with the lower couple id on heads and the other
on tails. With an odd count the highest-scoring couple is alone in the last pair, and its own coin
decides its arm. `treatment_fraction` must be 0.5 in this mode, and the engine refuses any other value
by name.

The pairs follow the population seed and `pair_weights`, the coins follow the assignment seed alone, and
the dynamics seed touches neither. So in pairs mode, unlike couple and block mode, a new population seed
can move a couple's arm.

Only a pairs run adds anything, so couple and block runs write the same bytes as before:

- `couples.parquet` gains `pair_id i64 nullable` after `arm`, null for remarriage couples.
- `manifest.json` gains `pairs`: `design` (one line), `covariates`, `weights`, `n_pairs`,
  `unpaired_couple` (a couple id, or null for an even count) and `pair_id` (one entry per couple id).
- A run with `--arm-override` (the twins) still records the pairs of its config.

The analysis reads `config.assignment.mode`:

- `summary.json` names the design for every mode. `analysis.design` says it in plain words,
  `analysis.inference_unit` is `couple`, `block of N couples` or `pair of couples`, and
  `analysis.n_clusters` counts couples, blocks or pairs.
- A pairs run's estimate is the difference of arm means (ratio of sums for conditional outcomes), as in
  every mode. `ci_low` and `ci_high` come from a percentile bootstrap that resamples whole pairs, and
  `p_permutation` flips the arms within each pair, a lone couple's arm flipping on its own (Bai, Romano
  and Shaikh). Conditional outcomes' notes say the bootstrap is over pairs. A pairs run whose couples
  table has no `pair_id` is refused.
- Couple and block runs are analysed exactly as before, pinned by golden values in
  `python/tests/test_pairs.py`.
- The twins of a pairs run resample pairs for their intervals too.

`tools/fit_pair_weights.py` refits the weights from a full example run, and `tools/pairs_sweep.py`
repeats the measurement docs/design.md reports.

## 14. The free read-only demo (added 2026-10-12)

A static copy of the dashboard for GitHub Pages holds the example and a few shocks run in advance, with no
server and no model. docs/static-demo.md describes it for a reader, and this section is its contract.

`experiments/demo/<name>.json`, one per shock, with exactly these keys:

```
{"name": "demo-...", "order": 1, "title": "...", "words": "...", "typed": bool,
 "parent": "example", "hits": "treatment" | "all",
 "shocks": [the fork's shocks, each exactly as Shock.to_engine() writes it, target included],
 "translation": {"shock_index", "recorded": "2026-10-12T01:33:33-07:00", "record": <a saved
                 results/.translations record, status ok>} | null,
 "note": "..."}
```

`typed` may be true only when `translate.text_sha256(words)` equals the record's `text_sha256`, a hash of the
text lowercased with its spacing collapsed, which cannot check case or spacing. A record saved since records
carry their own `recorded` time (section 8) keeps it, and it must equal the block's `recorded`. The live app
answers a card's words from its record, dated by the block's `recorded` (section 8). `hits` is
`all` when any shock targets all, else `treatment`. A translated shock must be the shock as translated.
`loveworld demo` forks each file's parent through `forking.plan_fork` and `forking.run_fork` (the fork
endpoint's own code), writing translation.json from the saved record through `translate.translation_file`,
and replaces an earlier build of the same world. It never calls a model. The engine writes the same bytes on
every platform (section 1), so the demo worlds CI builds on Linux are the worlds a Mac builds from these files,
determinism hashes included.

`loveworld static` stages a results root of the default world and the demo worlds (hard links, with their
placebo and twins siblings), asks `create_app` on it for every read below, and writes each response body
gzipped (level 9, no timestamp) under `<site>/data`, refusing a demo world whose parent.json no longer matches
the parent on disk. It fails above 900 MB and says when the data passes 400 MB. It asks in its own process
through `loveworld.asgi_reader`, which speaks ASGI to the app as uvicorn does: the app's lifespan runs around
the reads (an app without one is read without one), each GET gets a server's scope, and the reply's status,
headers and body come back exactly as the app sent them. It needs no package outside the app's own
dependencies, so `uv sync --no-dev` is enough to export. A dev-only test compares it with fastapi's TestClient
byte for byte on every kind of read the export makes.

```
index.json.gz                     {"format": 1, "default", "event_chunk_days": 10, "couples_page": 10000, "quickstart",
                                   "worlds": [{"name", "days", "couples", "agents", "couples_columns",
                                               "lenses": {name: {"headers": {X-Lens-*}} | {"status": 404, "detail"}}}],
                                   "demos": [{"name", "order", "title", "words", "typed", "parent", "hits", "shocks",
                                              "note", "translation": {"translation_id", "model", "recorded",
                                                                      "rationale", "words"} | null}],
                                   "not_exported": [...]}
experiments, health, shocks-catalog, lenses .json.gz    the global reads
w/<world>/<read>.json.gz          experiment, ate, curves, distributions, policy, world, twins-world, digest
w/<world>/couples.json.gz         GET /api/couples?limit=10000 (every couple, in table order, which is couple id order)
w/<world>/couples/<id>.json.gz    GET /api/couples/<id>, for every couple
w/<world>/agents/<id>.json.gz     GET /api/agents/<id>, for every agent in the agents table
w/<world>/events/<k>.json.gz      {"from": 10k, "to", "days": [GET /api/events?day=N for each day, as sent]}
w/<world>/lens/<name>.bin.gz      GET /api/lens/<name>
```

The dashboard built with `VITE_STATIC=1` (and `VITE_BASE`, the site's path) answers every `api.ts` read from
these files (`frontend/src/staticApi.ts`) and never requests `/api`. `make static-frontend`, which needs the
data first, puts it in `<site>` with a copy of `index.html` per page (`world.html`, `overview.html`,
`comparisons.html`, `couples.html`, `agents.html`, `policy.html`, `governance.html`, `new.html`) and, through
`make static-pages`, per couple and agent id that has a file under `<site>/data/w/<world>/couples/` or
`agents/` in any world (`couples/<id>.html`, `agents/<id>.html`). GitHub Pages serves each for a link to that
page, couple or agent with status 200, since a path without a trailing slash takes the `.html` file of its name
before a folder of that name. `404.html` is the copy through which any other link loads, with status 404.
`tools/serve_static.py` serves `<site>` by the same rules. `/api/couples` keeps rows
equal to `arm`, `state` (final state) and `origin` when given, stable-sorts by `sort` (a couples column,
missing values last), then pages by `offset` and `limit` (1 to 10,000), with the server's 400 and 422 answers.
A detail id with no file is the server's 404 (`couple N not found`). Every POST, and `/api/jobs`, is refused
with a 405 and a plain message. The World page offers "Try a shock" in place of "Shock this world", with one
card per demo, and picking one opens that world as a finished run opens (section 12). The New experiment route
is a one-line note, the top bar has no link to it, and a banner on every page says what LoveWorld is and that
the site is read-only. A shocked world's Governance page points to its parent's placebo, and the Overview heads
each world with the name the demo lists it by, adding its run name when the two differ.

Everything else is the live app's. On a phone, a world whose added shocks all reach only the treatment arm
opens on that district in both builds (section 12). Each shock is said in its own plain sentence (`shockWords`
in `frontend/src/arms.tsx`) in both builds. No text in either build is under 16px, chart text included. Apart
from reading these files under the site's path, only what being read-only needs differs: the banner, Try a
shock, the one-line New experiment page with no link to it, the Governance placebo pointer and the Overview
heading under the name the world is listed by.

`.github/workflows/pages.yml` builds and publishes the site when run by hand and on every push to main except
a push that changes only `README.md`, `docs/**`, `assets/**`, `LICENSE`, `NOTICE`, `fly.toml`, `deploy/**`,
`Dockerfile`, `.dockerignore` or `.github/workflows/ci.yml`. The build reads none of them, and a file on that
list must leave it before the build may read it. The workflow caches the Rust build, the uv packages (keyed on
`python/uv.lock`, with setup-uv's pruning off, since pruning drops every downloaded wheel) and the npm
packages (keyed on `frontend/package-lock.json`). It installs the Python package without the dev tools, with
`uv sync --no-dev` and with `UV_NO_DEV` set so that no `uv run` adds them back, so every build proves the
export needs none.

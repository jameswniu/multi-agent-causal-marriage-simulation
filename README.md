# LoveWorld

A reproducible causal simulation of 1,000 married AI-agent couples over one year. Change one thing
about how the agents remember, and measure what it does to divorce, trust, conflict and repair.

Everything here is simulated. The agents run an explicit rule-based policy whose every weight is
printed by one command. Findings describe this world and nothing about human couples. That line is
kept on purpose: the point of the project is a clean experiment, not a prediction.

## The experiment

Each agent keeps an episodic memory of what happened with its partner. A memory of a conflict
fades with a half-life. The control arm forgets a conflict with a 14-day half-life; the treatment
arm keeps it six times longer, 90 days. Nothing else differs. Couples are randomised into arms,
every intervention and state transition is logged, and the effect is the difference between arms
with a bootstrap confidence interval and a permutation p-value.

Example run (`experiments/example.yaml`, 1,000 couples, 365 days, seeds 11/22/33):

| Outcome | Control | Treatment | Effect | 95% CI |
|---|---|---|---|---|
| Divorced within the year | 1.6% | 21.4% | +19.8 points | 16.2 to 23.6 |
| Ever separated | 19.4% | 88.6% | +69.2 points | 64.8 to 73.8 |
| Trust at the end (0 to 1) | 0.65 | 0.20 | -0.45 | -0.48 to -0.42 |
| Conflicts per couple-year | 7.8 | 15.7 | +7.8 | 7.0 to 8.6 |
| Conflicts reconciled (conditional) | 78% | 35% | -43 points | -47 to -39 |
| Days to reconcile (conditional) | 4.6 | 7.4 | +2.8 | 2.3 to 3.3 |

Two checks ship with every experiment. The placebo run gives both arms the same parameters: its
divorce effect is -0.2 points with a confidence interval of -1.8 to +1.4, and its behavioural
tables are byte-identical whichever arm label is applied. The twin run puts every couple through
both arms on the same random streams: the paired divorce effect is +20.0 points (17.4 to 22.7 by
bootstrap over couples), and 20.6% of couples end the year differently because of the intervention.

The effect is large because retained grudges feed a loop in this world: more retained negative
memory means more frequent conflicts, less repair, lower trust, and so on. That loop is a property
of the rules, all of which are inspectable and editable, and the sensitivity to the half-life is
one line away (`experiments/retention-45d.yaml` roughly halves the effect).

## Pick your own stressor

Memory is one knob. The same harness takes any scheduled shock aimed at one arm, and the dashboard
has a picker for them: job loss (a stress jump to one partner that fades over months), financial
crisis (daily stress on both partners for a stretch of the year), office temptation (more and better
outside options for one partner for a while), intimacy mismatch (one partner wants much more
closeness than the other), a trait shift (one partner becomes, say, 0.3 more neurotic), daily texts
(one partner sends affection every day), an anniversary and weekly date nights. Pick the shock, the
partner, the days and the size, hit Run, and a fresh experiment with its placebo-grade statistics
appears in the experiment dropdown about ten seconds later. Example files for four of them sit in
`experiments/`. A shock aimed at everyone is a world event, so you can ask whether holding onto
fights hurts more during a financial crisis.

These shocks are stylised on purpose. A job loss is a number of stress, not a bank balance, and
temptation is a probability, not a person. Each one is explicit, logged and switchable, so the
question "what does this do to this world" has one honest answer.

## How it works

```mermaid
flowchart LR
    Y[experiments/example.yaml] --> P[Python: loveworld CLI]
    P -->|config JSON| E[Rust engine on Bevy ECS]
    E -->|Parquet tables + manifest with hashes| R[(results/)]
    R --> A[Python analysis: effects, intervals, placebo, twins]
    A --> S[summary.json]
    S --> API[FastAPI]
    R --> API
    API --> D[React dashboard]
```

The engine (`engine/`) is a headless Bevy ECS world. Agents and couples are entities; one schedule
of systems runs each day in a fixed order: stress, affect (a Gottman-style influence equation
between partners), the couple interaction with its conflict, repair and leave decisions, trust,
memory pruning, the remarriage market, and the daily log. Every random draw comes from a stream
keyed by (seed, domain, id), so results do not depend on how the ECS iterates and a couple's stream
is identical across arms.

The Python package (`python/`) turns an experiment file into an engine config, runs the engine,
computes outcomes and treatment effects, and serves the results. The dashboard (`frontend/`) is a
Vite and React app over that API. The contract between the three layers is `docs/contracts.md`;
the model and the causal design are described in `docs/design.md`.

## Run it

Prerequisites: Rust (stable, via rustup), uv, Node 20 or newer.

```bash
make engine          # build the simulation engine (release)
make example         # run the example experiment and analysis into results/example
make placebo         # same experiment with treatment parameters equal to control
make twins           # every couple under both arms on the same random streams
make replay          # re-run the example and verify every table hash
make dashboard       # build the dashboard and serve it with the API on http://127.0.0.1:8765
make test            # Rust, Python and frontend test suites
```

A full run of 1,000 couples for a year takes about a second in the engine and about ten seconds
with the analysis. The engine can also be driven directly:

```bash
target/release/loveworld-engine run --config cfg.json --out results/mine
target/release/loveworld-engine replay --manifest results/mine/manifest.json
target/release/loveworld-engine policy-spec
target/release/loveworld-engine default-config
```

## The dashboard

The World page replays the year: play, pause, fast-forward at 1x, 10x or 50x days per second, with
every couple as a tile coloured by state (married, in conflict, separated, divorced, dating again),
control and treatment side by side, counters per arm and a ticker of the day's events. Click a
tile for that couple's story: the state timeline, both partners' trust and affect, every conflict,
and every decision with the utilities behind it. A second mode shows the same couples under both arms, each tile one couple
twice, with a counter of how many fates differ that day. The other pages hold the causal readout:
the effect table and forest plot, survival and trust curves by arm, recovery and conflict
distributions, the agent explorer, the policy inspector, and the governance page with the placebo
and twin results and the covariate balance table. Every couple and agent page has a collapsed
"Under the hood" panel that lists, day by day, what each partner remembered and how much it weighed,
how trust and affect moved, which action they chose and with what probabilities, and any shock that
landed.

## Governance

| Rule | How it is enforced |
|---|---|
| No hardcoded treatment effects | The arm only sets memory half-lives; the placebo run with equal parameters is byte-identical across arm labels (Rust and Python tests) |
| Interventions separate from decisions | The policy's input type has no arm field; a test greps policy, dynamics, market and memory sources for the token `Arm` |
| Every intervention and transition logged | `interventions.parquet` has one row per agent and parameter with control and applied values; `events.parquet` carries every state change with from and to states; illegal transitions fail a test |
| Reproducible | Keyed random streams, sorted outputs, SHA-256 per table, `replay` fails on any mismatch; a tampering test proves it |
| Assignment is random and independent | Exact half split, driven only by the assignment seed; changing the population seed leaves the arm vector unchanged; balance table in every summary |
| Simulated findings stay simulated | `evidence_class: simulation` in every manifest and summary, the disclaimer on every table, and no claim in this repository about human couples |
| No LLM agents before the baseline passes | The baseline policy is rule based; LLM and learned policies are a later phase under the same harness |

Outcomes that are only defined after treatment has acted (per conflict, or among the divorced) are
marked conditional. Their permutation p-values test the sharp null of no effect on anything, which
is why a conditional outcome can show a wide interval and a small p-value at the same time. With
ten outcomes, a placebo run can be expected to show a nominally significant difference about one
time in two by chance alone, and the example placebo does on one (the reconciliation share), so
read the placebo as a whole, not outcome by outcome.

## What was borrowed

The remarriage market follows Hills and Todd's MADAM model (JASSS 2008): singles accept a partner
when compatibility clears a threshold that relaxes with time and is anchored to the match quality
of the marriage that just ended. The daily affect update follows the influence equations in
Gottman and Murray's mathematics of marriage. The memory stream, recency decay with importance
weighting, follows Park and colleagues' Generative Agents (2023). The explicit action menu at
conflict turning points and the auditable relationship state follow RELATE-Sim (Yue and
colleagues, 2025), and the separation of an agent's private state from what its partner can see
follows Love First, Know Later (Shang and colleagues, 2025). An optional network term follows the
Wedding Ring model (Billari and colleagues, 2007).

What those systems do not do, and this one does, is run a randomised intervention on memory inside
one persistent population with a placebo check, counterfactual twins and bit-exact replay.

## Roadmap

Phase 2 renders logged episodes as dialogue with a cloned voice per agent and avatar video for
selected scenes; it narrates decisions the engine already made, so it cannot touch the estimate.
Phase 3 swaps in learned policies under the same harness: an LLM policy choosing from the same five
actions, and a PyTorch policy whose hidden state can be intervened on directly. Later: multi-year
and multi-generation runs, household economics, calibration against demographic rate schedules,
and legal dissolution.

## Repository layout

```
engine/        Rust crate: config, population, memory, policy, dynamics, systems, market, shocks, output, CLI
python/        uv package `loveworld`: experiments, analysis, API, CLI, tests
frontend/      Vite + React + TypeScript dashboard
experiments/   example.yaml, retention-45d.yaml, contagion-block.yaml, job-loss.yaml, daily-texts.yaml,
               neuroticism-shift.yaml, crisis-under-retention.yaml, smoke.yaml
results/       run outputs; results/example keeps the small tables and summary of the example run
docs/          design.md (model and causal design), contracts.md (schemas, CLI, API)
```

## License

MIT.

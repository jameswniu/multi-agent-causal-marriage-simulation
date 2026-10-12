# LoveWorld design

LoveWorld is a reproducible causal simulation of 1,000 married agent couples over one year. It
exists to answer one kind of question cleanly: if you change one thing about how agents remember,
what happens to their relationships? The first experiment changes how long an agent retains the
memory of a conflict and measures divorce, trust, conflict frequency, recovery time and
reconciliation.

Everything here is simulated. The agents follow an explicit rule-based policy whose every weight is
printed by `loveworld-engine policy-spec`. Findings describe this world, not human couples.

## Architecture

```
experiments/example.yaml
        |
        v
python/loveworld (uv)  --builds config-->  engine (Rust, Bevy ECS, headless)
        |                                        |
        |                                        v
        |                              results/<name>/*.parquet + manifest.json
        v                                        |
analysis.py: outcomes, ATE, bootstrap CI, permutation p, curves  <---+
        |
        v
summary.json  --->  FastAPI (loveworld serve)  --->  React dashboard (frontend/dist)
```

The engine is a Cargo workspace crate (`engine/`). Agents and couples are Bevy ECS entities; the
daily tick is a `Schedule` of systems run on the single-threaded executor. The engine knows nothing
about statistics: it writes Parquet tables and a manifest with a SHA-256 per table. Python owns the
experiment definition, the analysis and the API. The dashboard is a static Vite build served by the
API. The contract between the three is `docs/contracts.md`.

## The world

### Agents

Each agent has five personality traits (neuroticism, agreeableness, conscientiousness, openness,
extraversion), four preferences (forgiveness, commitment, closeness, conflict engagement), a
relationship history (prior relationships, prior divorces, years married) and a base trust level.
Traits are clipped-normal draws from the population seed. Partners are assortative: the second
member's traits mix the first member's with a fresh draw. Each couple starts married with a shared
history of past positive moments and past conflicts, pre-seeded into both members' memories at
negative day offsets. A Watts-Strogatz ring over agent ids gives every agent six network
neighbours.

### Episodic memory

Memory is a list of episodes: day, kind (conflict, escalation, withdrawal, rejection, separation,
divorce, disappointment, reconciliation, positive, and grievance for merged ones), intensity and
partner. An episode keeps its full intensity for a short plateau, two days by default, and then
fades: its strength on day `t` is `intensity * 0.5 ^ (max(0, t - day - plateau) / half_life)`,
with one half-life per class (conflict, repair, positive). The retained negative and positive loads
about the current partner are sums of those strengths passed through a saturating transform
`s * (1 - exp(-raw / s))`, so a long grudge list has diminishing marginal weight. Episodes below a
threshold are forgotten weekly, and at most 200 are kept. A conflict is one episode whose
intensity rises as the fight escalates, rather than a new episode per escalation day. This design
follows the memory-stream idea in Park and colleagues' Generative Agents (recency decay and
importance weighting), with a half-life instead of a per-hour decay factor.

Two housekeeping rules shape what is kept without changing what it weighs, and neither one ever
differs between arms.

- Consolidation. Once a week, when more than eight episodes of one class about the current partner
  are older than the plateau, they merge into one standing episode: a grievance for the conflict
  class, a reconciliation or a positive memory for the other two. The merged episode is dated at
  the latest of them and its intensity is set so that its strength today equals their summed
  strength. Because they share one half-life and are all past the plateau, it also matches their
  sum on every later day, so a repeated grievance becomes one standing grievance with exactly the
  weight the list had. The episode of a conflict that is still open is never merged, since an
  escalation may still raise it.
- The separation freeze. While a couple is separated, every episode either member holds about the
  other stops fading and cannot be pruned; reunion or divorce restarts the clock where it stopped.
  The separation is a pause, not a time to forget.

### Relationship states and the daily tick

States: dating, married, separated, divorced, broken up. Legal transitions: dating to married or
broken up; married to separated; separated back to married or on to divorced. Conflict is a flag on
a married or dating couple, with its own intensity, duration and escalation count.

Every day, in this order:

1. Stress: geometric decay plus occasional shocks, nudged by neuroticism.
2. Affect: a discrete-time influence equation in the style of Gottman and Murray. Each member's
   affect toward the partner is `baseline + inertia * own + influence(partner)`, where the
   influence function is steeper below a negativity threshold, and the baseline falls with retained
   negative load and stress and rises with retained positive load.
3. Couple interaction. Calm couples may face an outside encounter (a hypothetical better match,
   after MADAM) and a conflict-onset hazard that rises with stress, neuroticism and retained grudge
   and falls with trust, affect and agreeableness. Calm days end with each member choosing to
   affiliate or not; mutual affiliation stores a positive episode. Conflict days have each member
   choose repair, hold, escalate, withdraw or leave. Reconciliation needs both to repair, or one to
   repair and the other to accept, where acceptance is a hazard of the receiver's own trust,
   forgiveness, grudge and the conflict's intensity. Escalation raises the intensity and the
   memory of the fight. Withdrawal wounds the partner. Leaving a marriage opens a separation, which
   ends in reunion (both repair) or divorce (a leave, or sixty days apart).
   A married couple cannot walk out on one bad day. Each day the couple is associated when both
   members stored a warm memory (positive or reconciliation) about each other in the last 42 days,
   and orphaned otherwise. Leaving is on the menu in a conflict only after 21 consecutive orphaned
   days, or once the fight reaches an intensity of 0.95; until then the leave action is not offered
   at all. Dating couples are not gated, and neither is finalising a separation: separating already
   is the sustained distance. The orphan count is logged every day.
4. Trust: a slow integrator toward a target set by base trust, retained loads and affect, plus
   discrete hits for escalation, withdrawal, rejected repairs and separation and a gain for
   reconciliation. Satisfaction is a logistic function of trust, affect and memory balance.
5. Memory housekeeping (weekly): consolidation, then pruning.
6. The remarriage market, after Hills and Todd's MADAM: singles past a cooldown meet two other
   singles a day and pair when compatibility (one minus mean trait distance) clears both personal
   thresholds; thresholds start anchored to the match quality of the marriage that just ended and
   relax at a personal rate. Dating couples marry on a daily hazard after a minimum courtship.
   A Wedding Ring style term (share of married neighbours) is available and off by default.
   An agent coming out of a divorce carries a legacy into the market. On the day of the divorce
   each member seals the marriage: how it ended (who left, or the separation ran out), how many
   conflicts it had and how many were reconciled, and the trust and memory loads it ended with.
   The legacy has two consequences. Leaving is easier in every later relationship by a commitment
   shift (0.3 on the leave utility), the channel Amato and DeBoer (2001) find for the
   intergenerational transmission of divorce, which runs through weaker commitment to marriage
   rather than through conflict skills. And the next relationship starts from a trust prior halfway
   between the agent's base trust and the trust the marriage ended with. A legacy is minted from
   the marriage that just ended and nothing else: a second divorce replaces the first legacy rather
   than compounding it, so a lossy summary is never summarised again. The match quality of the
   ended marriage stays where the market already keeps it, as the anchor of the next threshold.
7. The daily log row per couple.

### Shocks: stressors and kindnesses

A shock is a scheduled event aimed at one arm or at everyone, so that anything a person might
name as "what strains a marriage" or "what helps one" can be tested the same way as the memory
change. Eight kinds ship: job loss (a stress jump to one partner that fades over months), financial
crisis (daily stress on both partners for a stretch of the year), temptation (one partner meets more
and better outside options for a while), intimacy mismatch (one partner's wish for closeness moves
away from the other's), a trait shift (any of the nine traits moves by a chosen amount, for example
one partner becoming more neurotic), daily texts (one partner sends affection every day, which the
other stores as a small positive memory), an anniversary (a strong shared positive memory once a
year) and date nights (a weekly one). Every application is logged as an intervention row and an
event, the member it lands on is drawn once per couple from its own keyed stream (so a shock that
does nothing moves no other draw), and a shock aimed at the treatment arm is an intervention while a
shock aimed at everyone is a world event under which the memory treatment is tested. Two dynamics terms came with the mismatch shock and apply to
every couple: affect falls with the gap between the partners' closeness preferences, and once a week
the partner who wants more closeness may store a disappointment, with probability proportional to
the gap.

These are stylised. A job loss is a number of stress, not a bank balance; temptation is a
probability, not a person. The point is that each one is explicit, logged and switchable, so the
question "what does X do to this world" has one honest answer.

Any other event runs as a custom shock: a named list of up to eight effects, each moving one quantity
the engine already models (stress, mood, trust, a stored memory, the chance of meeting someone, how
often fights start, the odds of making up, or a trait) by a bounded amount, once, daily, weekly or
yearly, on one partner or both. "His mother moves in for two months" becomes daily stress on both
partners and fights starting more often for those sixty days. The eight named kinds are themselves
such lists, and the engine runs every shock through the same effect code. That is how a model can
add a new kind of event from plain words without touching the agents' rules. The model only writes
the list, the engine checks it against fixed bounds, and the run is as deterministic and replayable
as any other. Contract section 9 has the channels, bounds and logging.

### The decision policy

Every action has a named linear utility over the agent's own private state and observable partner
behaviour, and the action is sampled from a softmax at a fixed temperature. The policy's input type
has no field for the treatment arm, the partner's trust or the partner's memory; it sees the
partner's last visible action, the shared conflict intensity, whether leaving is on the menu today
and its own sealed divorce, if any. `policy-spec` prints every weight and formula, the leave rule
and the legacy shift. A separate module, dynamics, holds the world's hazards; it also never sees the arm, and
a test greps both sources for the token `Arm`.

## The experiment

Three seeds keep the design clean. The population seed generates agents and the network. The
assignment seed randomises couples into arms, either per couple, in contiguous blocks (cluster
randomisation for runs with network contagion switched on) or in matched pairs (below). The dynamics
seed drives every stochastic process during the run, through one ChaCha8 stream per agent, per couple
and per global process, keyed by (seed, domain, id). Changing one seed never changes what another
controls, and tests pin that. The one designed exception is pairs mode, whose pairs are made from the
population.

The intervention sets the memory half-lives of both members of a treated couple to the treatment
values at day 0. It is the only arm-dependent write in the engine, and it logs every parameter it
touches, control value beside applied value, even when they are equal.

Outcomes are computed from the tables by Python: divorce rate, separation rate, days married, final
and mean trust, conflicts per couple-year, escalations per conflict, reconciliation share, recovery
days (duration of reconciled conflicts) and remarriage rate. The average treatment effect is the
difference in arm means with a bootstrap percentile confidence interval (resampling couples within
arm) and a permutation p-value (shuffling arm labels). A pairs-mode run resamples whole pairs and
flips the arms within each pair instead. Outcomes measured only on post-treatment
events (anything per conflict or among the divorced) are flagged as conditional, because
conditioning on a post-treatment variable can bias a causal contrast.

Two governance runs come with every experiment. The placebo run sets the treatment parameters equal
to the control parameters; its effect estimate must cover zero, and its twin runs must be byte
identical, which proves the arm label itself does nothing. The twin run forces every couple into
each arm on the same random streams, so each couple is its own counterfactual until the arms'
dynamics diverge; it gives a paired estimate beside the between-couple one.

Two interference channels are documented rather than hidden. The remarriage market mixes divorced
agents from both arms, so remarriage outcomes are not isolated between arms. The network terms
create spillovers when switched on, which is why block assignment exists; the example experiment
runs with both network weights at zero.

### Matched pairs

The placebo's two halves never come out exactly even, because they are different couples. Pairs
mode (`engine: {assignment: {mode: pairs}}`) tries to make the halves alike before the year starts.
Every couple gets a risk score from six values drawn before day 0: the partners' mean neuroticism,
conscientiousness, agreeableness, base trust and prior divorces, and the couple's years married, each
standardised over the population. Couples are sorted by score and paired with their neighbour, and
one coin per pair, from the assignment seed, sends one couple of each pair to each arm. With an odd
count the highest-scoring couple is alone and its own coin decides its arm. The pairs follow the
population, and the coins follow the assignment seed alone. A pairs run writes `pair_id` into
couples.parquet and the pairing into its manifest (contracts, section 13).

The weights come from the committed example run (seeds 11, 22 and 33). `tools/fit_pair_weights.py`
fits them by ordinary least squares over its 500 control couples, predicting the average of the
standardised divorce indicator and the standardised conflict rate. Only their ratios matter.

| Covariate | Weight |
|---|---|
| Neuroticism | 0.170 |
| Conscientiousness | 0.028 |
| Agreeableness | -0.206 |
| Base trust | -0.256 |
| Prior divorces | -0.027 |
| Years married | -0.038 |

The six values explain 23% of that average, 29% of the conflict rate and only 5% of divorce.

A pairs run is analysed as Bai, Romano and Shaikh recommend for matched pairs. The estimate is still
the difference in arm means. The interval resamples whole pairs, and the p-value flips the two arms
within each pair, which is how the design randomised. Resampling pairs is valid but leans wide when
the effect differs from couple to couple, since their pairs-of-pairs correction is not applied.

`tools/pairs_sweep.py` measured both designs on 100 assignment seeds, with the example's population
and dynamics seeds. The placebo gap is treatment minus control with both arms on the same rules, so
its spread over seeds is pure assignment luck.

| Placebo gap, spread over 100 seeds | Couple mode | Pairs mode | Change |
|---|---|---|---|
| Divorce, points | 0.93 | 0.91 | -2% (95% interval -19% to +19%) |
| Seeds with a divorce gap over 1 point | 30 | 27 | |
| Final trust (0 to 1 scale) | 0.015 | 0.010 | -35% |
| Mean trust (0 to 1 scale) | 0.013 | 0.009 | -32% |
| Conflicts per couple-year | 0.36 | 0.31 | -15% |

The exact spread over every possible assignment, which needs no seeds, agrees. Divorce goes from 0.89
to 0.89 points, final trust shrinks by 30% and conflicts by 9%. On a population and a year the weights
never saw (seeds 12 and 34) the cuts are 5%, 27% and 10%. Every placebo run had byte-identical
behaviour tables, so the gaps come from the split alone.

| Example on the same seeds, means | Couple mode | Pairs mode |
|---|---|---|
| Divorce effect, points | +14.3 | +14.4 |
| Width of its 95% interval, points | 6.9 | 6.8 |
| Final trust effect | -0.440 | -0.441 |
| Width of its 95% interval | 0.056 | 0.045 |
| Conflicts per couple-year, effect | +5.99 | +5.99 |
| Width of its 95% interval | 1.36 | 1.32 |

Couple mode, the random split, stays the default, because pairs cut the placebo's divorce-gap
spread by only 2%. That gap comes mostly from the luck each couple meets during the year rather than
from who the couples are, so no split made before day 0 can close it, and only the twins, the same
couples under both settings, bring it to zero.

The rule, set before measuring, was to make pairs the default only on a cut of at least 20% that
left the effect inside its interval. The effect stayed put, but the 2% is well inside the noise, and
the exact calculation says the spread does not fall at all. Pairs mode stays available for runs that
care most about trust.

The fit shows why. The six values explain only 5% of who divorces. The placebo has about 20 divorces
among 1,000 couples and no pair holds two of them, so each pair's coin moves a divorce from one half
to the other as often as a random split does. Trust is what the six values predict best, so its gap
shrinks by about a third.

### What the engine writes

Nine tables and a manifest: agents, couples, events, daily, decisions, interventions, conflicts,
episodes (one row per memory stored or amplified, including the history seeded before day 0) and
legacies (one row per member of a marriage that ended in divorce). A pairs-mode run adds `pair_id`
to the couples table and its pairing to the manifest.
The episodes table is what the dashboard's "Under the hood" panel reads to show, day by day, what
each partner remembered and how their trust and affect moved.

## Reproducibility

Every random draw comes from a keyed stream, every system iterates entities in id order, and every
table is sorted before writing. The manifest records a SHA-256 per table and a determinism hash
over them. `loveworld-engine replay` re-runs the manifest's config and checks every hash. Replay is
bit-exact on the same platform and toolchain; floating-point library differences across platforms
could change low bits, which the hash would catch rather than hide.

## Governance

| Rule | How it is enforced |
|---|---|
| No hardcoded treatment effects | The arm only sets memory half-lives; the placebo run with equal parameters is byte-identical across arm labels (Rust and Python tests) |
| Interventions separate from decisions | The policy's input type has no arm field; a test greps policy, dynamics, market and memory sources for the token `Arm` |
| Every intervention and transition logged | `interventions.parquet` has one row per agent and parameter with control and applied values; `events.parquet` carries every state change with from and to states; illegal transitions fail a test |
| Reproducible | Keyed random streams, sorted outputs, SHA-256 per table, `replay` fails on any mismatch; a tampering test proves it |
| Assignment is random and independent | Exact half split, driven only by the assignment seed; in couple and block mode, changing the population seed leaves the arm vector unchanged; in pairs mode the population forms the pairs and the assignment seed alone flips each pair's coin; balance table in every summary |
| Simulated findings stay simulated | `evidence_class: simulation` in every manifest and summary, the disclaimer on every table, and no claim in this repository about human couples |
| No LLM agents before the baseline passes | The baseline policy is rule based; LLM and learned policies are a later phase under the same harness |

In the example run the placebo's divorce effect is -1.2 points with a 95% confidence interval of
-3.0 to +0.4, and the twin run's paired divorce effect is +14.4 points (12.0 to 16.7 by bootstrap
over couples), with 16.0% of couples ending the year differently because of the intervention. The
sensitivity to the half-life is one file away: `experiments/retention-45d.yaml` halves the treatment
memory to 45 days and cuts the divorce effect from 12.8 to 5.2 points. The README's badges and
figures are redrawn from the example run by `tools/figures.py`, and CI reruns the placebo, the
twins, the example and its replay before checking that every badge and figure still matches.

Outcomes that are only defined after treatment has acted (per conflict, or among the divorced) are
marked conditional. Their permutation p-values test the sharp null of no effect on anything, which
is why a conditional outcome can show a wide interval and a small p-value at the same time. With
ten outcomes, chance alone gives a placebo run a nominally significant difference somewhere up to
about two times in five, and the example placebo shows one (the reconciliation share), so read the
placebo as a whole, not outcome by outcome.

## The dashboard

The World page replays the year as a town drawn with PixiJS inside the React app.

- Every couple is a house with its two people in front, control on the left under blue roofs and treatment on the right under orange ones.
- A couple in a conflict stands outside and apart under a yellow sign, a separated partner waits at the edge of the plaza, and a divorce dims the house and sends both people to the plaza, where some date and remarry into new homes.
- A time bar plays, pauses and scrubs the year at 1, 10 or 50 days a second, and colour lenses repaint every house by trust, stress, grudge, warmth, satisfaction or days without warmth.
- Clicking a house opens the couple panel with both partners' trust and mood over the year, their memory that day and the latest events, and the full couple and agent pages show every decision with the utilities behind it.
- Shock this world opens the plain-words shock box right above the town. Run forks the world being watched, the page switches to the new world and replays it from just before the shock, and a ring marks every house whose couple differs that day from the same couple in the parent world, with a counter and a switch that draws the parent on the same day. The fork's Overview compares every couple's whole year with itself in the parent world.

Where a person stands is a layout of their state that day, since the engine has no space. The town
art is Kenney's public-domain Tiny Town and Tiny Dungeon tiles, credited in
`frontend/public/assets/kenney/CREDITS.md`. The other pages hold the causal readout: the effect
table and forest plot, survival and trust curves by arm, the agent explorer, the policy inspector,
and the governance page with the placebo and twin results and the covariate balance table.

## Calibration

The default parameters were set by hand through a few sweeps so that the control world is plausible
rather than fitted: about seven conflicts per couple a year, close to nine in ten of them reconciled
in about six days, trust near 0.65, and about two divorces per hundred couples per year (2.6 in the
example run, between 1.2 and 2.6 across three dynamics seeds). The treatment value in the example (a
90-day conflict half-life against 14 days) produces a large effect in this world.

The memory housekeeping rules and the leave gate were calibrated the same way, by switching each off
in turn on the example's seeds, and they were tuned without touching the treatment.

- With all of them off the engine reproduces the earlier world exactly: 1.6 against 21.4 percent
  divorced.
- The plateau weighs most. At seven days it pushed control divorces to 3.0 percent and control
  trust to 0.63, so the default is two days.
- The freeze cuts both ways. The control arm loses the forgetting it used to do while apart, and the
  treatment arm stops losing its warm memories while apart, so it lowers treatment divorces.
- The gate almost never opens through distance. Couples share a warm memory on about four days in
  ten, and a married couple is orphaned on fewer than one day in two hundred, so in this world a
  walk-out in practice needs a fight at the 0.95 line. The orphan route matters for runs that cut
  warmth, such as a long financial crisis.
- Consolidation changes no load, only how long a merged memory stays above the forgetting
  threshold, and moves the results within seed noise.

Together they shrink the example's divorce effect from about 20 points to about 13, mostly through
the freeze and the gate, while the separation, trust and conflict effects stay large. That size is a property of these rules, chiefly the loop from retained grudge
to more frequent and less repairable conflicts, and not a claim about people. The sensitivity to
the half-life is visible by editing one line of the experiment file. No human study in the reviewed
record (see [prior-art.md](prior-art.md)) measures how long people retain a conflict or manipulates
that retention, so the 14 and 90 day values are design parameters, and the sign and size of the
effect are simulation results.

## Prior art and what was borrowed

Hills and Todd, MADAM (JASSS 2008): the marriage market with relaxing thresholds and anchoring to
the last marriage. Billari and colleagues, the Wedding Ring (Demographic Research 2007): social
influence on marriage, available as an optional term. Gottman, Murray and colleagues, The
Mathematics of Marriage: the influence equations behind the daily affect update. Park and
colleagues, Generative Agents (2023): the memory stream with recency decay and importance. Yue and
colleagues, RELATE-Sim (arXiv 2510.00414): explicit action menus at turning points and auditable
relationship state. Shang and colleagues, Love First, Know Later (arXiv 2512.11844): the
separation of private agent state from the observable environment. None of these runs a randomised
intervention with a placebo and counterfactual twins inside one persistent population, which is
the contribution here.

The wider record is in [prior-art.md](prior-art.md): eighteen marriage, divorce and kinship
simulations from 2005 to 2026, each read against its source by two independent checks. Marriage,
divorce and remarriage in one persistent population has company (MADAM, Grow and colleagues 2017,
SOCSIM, Jarynowski and Nyczka 2018), and a dating state appears in Grow and Van Bavel (2015, 2017).
What has no verified prior is a conflict process at the agent level with separation and reunion,
agent memory that decays, a randomised arm inside one population, common-random-number twins and
hash-verified replay. The nearest controlled counterfactual is Hammel (2005), who restarted every
run from the same population but with fresh random numbers and noted that controlling that
variation would sharpen the result. Two caveats bound the claim: those tools are standard
simulation methodology outside this domain, and the earlier models are fitted to real data where
this one is set by hand.

## Repository layout

```
engine/        Rust crate: config, population, memory, policy, dynamics, systems, market, shocks, output, CLI
python/        uv package `loveworld`: experiments, analysis, forks, run queue, translator, API, CLI, tests
frontend/      Vite + React + TypeScript dashboard, with the PixiJS town
experiments/   example.yaml, retention-45d.yaml, contagion-block.yaml, job-loss.yaml, daily-texts.yaml,
               neuroticism-shift.yaml, crisis-under-retention.yaml, smoke.yaml
results/       run outputs; results/example keeps the small tables and summary of the example run
docs/          design.md, contracts.md (schemas, CLI, API), prior-art.md, deploy.md, figures/
tools/         figures.py, which draws the README figures and badges from the example run;
               fit_pair_weights.py and pairs_sweep.py, behind the matched-pairs section
assets/        README recordings and screenshots of the dashboard
deploy/        the container entrypoint and the edge worker for a public deployment
```

## Roadmap

Phase 2, voice: render logged episodes as dialogue (an LLM writes the lines from the event, each
agent's traits and memory, and the decision's utilities), give each agent a cloned voice, and
render selected scenes with avatars. This layer narrates decisions the engine already made, so it
cannot change the causal estimate.

Phase 3, learned policies under the same harness: a Concordia or other LLM policy that chooses from
the same five actions given the same view, and a PyTorch policy whose hidden state can be
intervened on directly (a neural-circuit version of the memory intervention). The rule-based
baseline stays as the control for what a learned policy adds, and the governance runs apply
unchanged.

Later: multi-year and multi-generation runs, children and household economics, calibration of
rates against demographic schedules, and legal dissolution with asset division. The legacy is the
hook for multi-generation runs: a child's starting commitment and trust could be drawn from the
parents' seals, so whether a divorce is passed down becomes something the world can test rather
than assume.
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
divorce, reconciliation, positive), intensity and partner. An episode's strength on day `t` is
`intensity * 0.5 ^ ((t - day) / half_life)`, with one half-life per class (conflict, repair,
positive). The retained negative and positive loads about the current partner are sums of those
strengths passed through a saturating transform `s * (1 - exp(-raw / s))`, so a long grudge list
has diminishing marginal weight. Episodes below a threshold are forgotten weekly, and at most 200
are kept. A conflict is one episode whose intensity rises as the fight escalates, rather than a
new episode per escalation day. This design follows the memory-stream idea in Park and
colleagues' Generative Agents (recency decay and importance weighting), with a half-life instead of
a per-hour decay factor.

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
4. Trust: a slow integrator toward a target set by base trust, retained loads and affect, plus
   discrete hits for escalation, withdrawal, rejected repairs and separation and a gain for
   reconciliation. Satisfaction is a logistic function of trust, affect and memory balance.
5. Memory pruning (weekly).
6. The remarriage market, after Hills and Todd's MADAM: singles past a cooldown meet two other
   singles a day and pair when compatibility (one minus mean trait distance) clears both personal
   thresholds; thresholds start anchored to the match quality of the marriage that just ended and
   relax at a personal rate. Dating couples marry on a daily hazard after a minimum courtship.
   A Wedding Ring style term (share of married neighbours) is available and off by default.
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
event, the member it lands on is drawn once per couple from the couple's own stream, and a shock
aimed at the treatment arm is an intervention while a shock aimed at everyone is a world event under
which the memory treatment is tested. Two dynamics terms came with the mismatch shock and apply to
every couple: affect falls with the gap between the partners' closeness preferences, and once a week
the partner who wants more closeness may store a disappointment, with probability proportional to
the gap.

These are stylised. A job loss is a number of stress, not a bank balance; temptation is a
probability, not a person. The point is that each one is explicit, logged and switchable, so the
question "what does X do to this world" has one honest answer.

### The decision policy

Every action has a named linear utility over the agent's own private state and observable partner
behaviour, and the action is sampled from a softmax at a fixed temperature. The policy's input type
has no field for the treatment arm, the partner's trust or the partner's memory; it sees the
partner's last visible action and the shared conflict intensity. `policy-spec` prints every weight
and formula. A separate module, dynamics, holds the world's hazards; it also never sees the arm, and
a test greps both sources for the token `Arm`.

## The experiment

Three seeds keep the design clean. The population seed generates agents and the network. The
assignment seed randomises couples into arms, either per couple or in contiguous blocks (cluster
randomisation for runs with network contagion switched on). The dynamics seed drives every
stochastic process during the run, through one ChaCha8 stream per agent, per couple and per global
process, keyed by (seed, domain, id). Changing one seed never changes what another controls, and
tests pin that.

The intervention sets the memory half-lives of both members of a treated couple to the treatment
values at day 0. It is the only arm-dependent write in the engine, and it logs every parameter it
touches, control value beside applied value, even when they are equal.

Outcomes are computed from the tables by Python: divorce rate, separation rate, days married, final
and mean trust, conflicts per couple-year, escalations per conflict, reconciliation share, recovery
days (duration of reconciled conflicts) and remarriage rate. The average treatment effect is the
difference in arm means with a bootstrap percentile confidence interval (resampling couples within
arm) and a permutation p-value (shuffling arm labels). Outcomes measured only on post-treatment
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

### What the engine writes

Seven tables and a manifest: agents, couples, events, daily, decisions, interventions, conflicts
and episodes (one row per memory stored or amplified, including the history seeded before day 0).
The episodes table is what the dashboard's "Under the hood" panel reads to show, day by day, what
each partner remembered and how their trust and affect moved.

## Reproducibility

Every random draw comes from a keyed stream, every system iterates entities in id order, and every
table is sorted before writing. The manifest records a SHA-256 per table and a determinism hash
over them. `loveworld-engine replay` re-runs the manifest's config and checks every hash. Replay is
bit-exact on the same platform and toolchain; floating-point library differences across platforms
could change low bits, which the hash would catch rather than hide.

## Calibration

The default parameters were set by hand through a few sweeps so that the control world is plausible
rather than fitted: about one conflict every ten weeks, nine in ten conflicts reconciled within a
few days, trust drifting near 0.7, and one to two divorces per hundred couples per year. The
treatment value in the example (a 90-day conflict half-life against 14 days) produces a large
effect in this world. That size is a property of these rules, chiefly the loop from retained grudge
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
rates against demographic schedules, and legal dissolution with asset division.

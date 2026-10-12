# Prior art

What has been built before, what LoveWorld adds, and what it cannot claim. The review was run on
2026-10-10 and 2026-10-11 over the marriage, divorce and kinship simulation literature from 2005 to
2026. Six search angles were swept, every finding was checked against its source by two independent
readers set to refute it, a final pass looked for what the sweep had missed, and 251 findings
survived. The LoveWorld column rests on the project description, not an independent audit of the
code. Everything marked unverified below stayed unverified on purpose.

## Verdict

As of 2026-10-11, against the verified marriage, divorce and kinship simulation record (18 works from 2005 to 2026, each read and checked twice, independently), nothing combines what LoveWorld ships: 1,000 couples over 365 days in a persistent lifecycle with an explicit conflict process (repair, hold, escalate, withdraw, leave) and separation-reunion states, per-class decaying episodic memory where the conflict-memory half-life (14 vs 90 days) is the only arm-dependent write, randomized arms inside one population under three separated seeds, a placebo run that must be byte-identical across arm overrides, common-random-number twins, SHA-256 verified replay, Parquet logs of every transition, and a printed softmax policy that is arm-blind by construction. The lifecycle half has company: MADAM (Hills and Todd 2008), Grow, Schnor and Van Bavel (2017, GPL NetLogo with dating, marriage, divorce by repartnering and remarriage), SOCSIM/rsocsim (GPL, rate-driven marriage, divorce, widowhood, remarriage, release 1.9.18 in June 2026) and Jarynowski and Nyczka (2018) all run marriage, divorce and remarriage in one population, so the lifecycle alone is not new; what no verified prior has is a conflict process (Grow et al 2017 say outright their model "does not consider divorce for other reasons, such as relationship problems"), agent memory that decays, or separation and reunion. The causal half has no company in this domain: every prior varies parameters for the whole population (MADAM sweeps, Grow's turned-off counterfactuals, Hammel's fertility and mortality shocks, Silverman's health scenarios), the nearest twin design is Hammel 2005 (same 5,000-person start, different random numbers, 100 runs per scenario) who notes effects "would appear more sharply if interrun variation were controlled", and the one SOCSIM study that calls its runs "paired" (Snyder et al 2022) used disjoint seed sets. Nobody claims bit-exact replay: SOCSIM intends seed determinism and Grow 2017 exposes a seed for "full replication of a given run", neither verifies it, and Walker and Davis state runs are "similar but not identical". Two caveats cap the lead. The priors are ahead on empirical grounding (MADAM against US census hazards, Grow against ESS with 1,000 runs per country, SOCSIM against 8.2 million Swedish register records, the Pairfam thesis against 4,295 real couples with Sobol sensitivity) where this repository's description has none, and CRN, placebo and seeded replay are standard simulation-methodology tools whose general literature this search did not cover, so the defensible claim is first combination in this domain, not first invention of the techniques. The LoveWorld row rests on the project description, not an independent audit, and the repository was private at the time of the review, so nobody outside had yet checked its reproducibility claims.

One title that surfaced after the sweep was read on 2026-10-11: Hina, Abdullahi and Tahiru (2025) model
conflict, adultery, divorce and reconciliation as population compartments in a deterministic system of
differential equations solved by Runge-Kutta. It has no agents, no memory and no arms, so the claim
below is worded as the first agent-level conflict process, not the first model to name conflict.

## Comparison

| System | Persistent population lifecycle | Explicit inspectable policy | Randomized arms | Memory intervention | Placebo check | Counterfactual twins | Bit-exact replay | Open source |
|---|---|---|---|---|---|---|---|---|
| MADAM (Hills and Todd 2008) | Partial | Partial | No | No | No | No | No | No |
| Wedding Ring (Billari, Prskawetz, Aparicio Diaz, Fent 2007) | No | Partial | No | No | No | No | No | No |
| Mate-search heuristics (Todd, Billari, Simão 2005) | No | Partial | No | No | No | No | No | No |
| Reforging the Wedding Ring, SAMP (Bijak, Hilton, Silverman, Cao 2013) | No | Yes | No | No | No | No | No | Yes |
| Wedding Doughnut (Silverman, Bijak, Hilton, Cao, Noble 2013) | No | Yes | No | No | No | No | No | Yes |
| SESSL/ML3 linked-lives model (Reinhardt et al 2018) | Partial | Yes | No | No | No | No | No | Partial |
| Assortative mating ABM (Grow and Van Bavel 2015) | Partial | Yes | No | No | No | No | No | Yes |
| Relative divorce risks ABM (Grow, Schnor, Van Bavel 2017) | Yes | Yes | No | No | No | No | Partial | Yes |
| Census marriage market (Walker and Davis 2013) | No | Partial | No | No | No | No | No | Partial |
| SOCSIM / rsocsim (1970s to 2026) | Yes | Partial | No | No | No | No | Partial | Yes |
| SOCSIM kinship shocks (Hammel 2005) | No | Partial | No | No | No | No | No | No |
| SOCSIM vs Swedish registers (Calderón-Bernal et al 2023, 2026) | Partial | Partial | No | No | No | No | No | Partial |
| Divorce contagion SIRa ABM (Perez Visaires 2023) | No | Partial | No | No | No | No | No | Partial |
| Single-parameter marriage/divorce ABM (Jarynowski and Nyczka 2018) | Yes | Partial | No | No | No | No | No | No |
| Compartmental divorce spread, Spain (Duato and Jódar 2011, 2013) | No | Partial | No | No | No | No | No | No |
| Networked divorce epidemic (Gambrah and Abdul-Rahaman 2023) | No | Partial | No | No | No | No | No | No |
| Marital conflict difference equations (Gottman and Murray 1995, 1999, 2002) | No | Partial | No | No | No | No | No | No |
| LoveWorld (this repository) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

How to read the cells. Persistent population lifecycle: Yes means marriage, divorce and remarriage run in one persistent population (no prior has conflict, separation or reunion states, and only Grow 2015 and 2017 have a dating state); Partial means the two independent checks split on the flag (MADAM, SESSL/ML3, Grow 2015, Calderón-Bernal) because dating or conflict is missing. Explicit inspectable policy: Yes means the decision rule is fully stated and the code is public; Partial means the equations or rules are published but no code is released, or (SOCSIM lineage) behaviour is rate tables rather than a decision rule. Bit-exact replay Partial: a seed is settable and determinism is intended (SOCSIM's package-owned LCG, Grow 2017's seed_to_use own) but nothing verifies byte identity. Open source Partial: code is public without a licence (SESSL jasss2018 models repo, Walker's code printed in a copyrighted thesis appendix, Calderón-Bernal's two repos) or the independent checks disagree on whether code exists (UOC thesis). McDermott, Fowler and Christakis 2013 is omitted as a row because it is an empirical network study, not a model. The LoveWorld row reflects the project description at the time of the review, not an independent audit; the repository was private then and is open now, so its reproducibility claims can be checked by anyone.

## Closest prior work

### Grow, Schnor and Van Bavel 2017, relative divorce risks ABM (CoMSES codebase 5105)

https://www.comses.net/codebases/5105/releases/1.5.0/

Why it is close. Closest on lifecycle and openness: one persistent population per country (1,000 agents, 1921 to 2064), dating, marriage, divorce, a divorced status, remarriage and widowhood; mate value from education, earnings and age; NetLogo 5.2 under GPL-3.0 with an ODD+D description; a user-settable seed the Info tab says allows full replication of a run; 1,000 runs per country validated against ESS rounds 5 and 6. Both independent checks agree the lifecycle flag is true.

What it lacks. No conflict (divorce happens only when a better alternative appears and both parties agree; the authors state the model does not consider divorce for other reasons such as relationship problems), no separation or reunion state, no agent memory (ODD+D: agents do not learn), no treatment arms (sensitivity runs zero a weight for all agents), seed_to_use is random in the shipped experiment so no CRN twins, no placebo, no hash verification. Paper body itself returned 403 at Tandfonline; one check read the Lirias accepted manuscript, the other worked from the CoMSES archive.

### MADAM, Hills and Todd 2008 (JASSS 11(4) 5)

https://www.jasss.org/11/4/5.html

Why it is close. The named ancestor of LoveWorld's remarriage market. 100 males and 100 females with k of N traits, relaxing satisfice levels at individual rates, divorce as mutual trade-up, remarriage; individual heterogeneity (lambda vs divorces r=0.43); tuned to US 1990 marriage-by-age data and compared out of sample with US 1996 divorce data (0.47 vs 0.50 divorce share); 1,000 replications per setting.

What it lacks. No dating state (random encounters only), no conflict, no separation or reunion, no memory beyond satisfice carry-over (the word memory does not appear), parameter sweeps only, no code, seeds or data released (no CoMSES deposit found, search not exhaustive). The two independent checks split on the lifecycle flag: one true (marriage, divorce, remarriage persist), one false under the strict five-part definition.

### SOCSIM and rsocsim (Berkeley 1970s; MPIDR R package 1.9.18, 2026)

https://github.com/MPIDR/rsocsim

Why it is close. Open GPL-3.0 microsimulation framework still shipping in 2026: monthly competing risks of birth, death, marriage, divorce (duration-specific) and group transition; statuses single, married, divorced, widowed; remarriage via rate defaults; one- or two-queue marriage market; a package-owned LCG intended so the same seed gives the same stream across platforms; thousands of kin and partnership studies run on it.

What it lacks. No agent decision policy (rates in, events out), no dating, courtship, conflict, separation or reunion, no memory state in the person struct, no arms or interventions, no CRN pairing (one global stream desynchronizes on any rate change; Snyder et al 2022 'paired' runs had zero shared seeds), no bit-exact verification or hashes, and the README warns repeated in-session runs can corrupt later ones. Berkeley SOCSIM site was unreachable.

### Hammel 2005, Demographic dynamics and kinship in anthropological populations (PNAS)

https://pmc.ncbi.nlm.nih.gov/articles/PMC548587/

Why it is close. Nearest classical analogue to a controlled counterfactual: every run starts from the same 5,000-person population, 100 runs per scenario, 1,000 years each, stationary baseline vs 25-year fertility or mortality shocks at year 500, kin censuses every 25 years, Gini and Lorenz outputs; author notes conclusions are conservative because individual differences 'would appear more sharply if interrun variation were controlled'.

What it lacks. Different random numbers per run (no CRN pairing stated), shocks applied to the whole population rather than randomized across units, no divorce or remarriage mentioned, no memory, no replay or seeds reported, scripts and data 'available on request' only.

### Jarynowski and Nyczka 2018, single-parameter marriage/divorce ABM (arXiv 1805.02878)

https://arxiv.org/abs/1805.02878

Why it is close. ABM of 4,000 agents with attractiveness and preference traits, marriage, partner swapping, spontaneous breakup, births, deaths and remarriage in a constant-size population, driven by one pressure parameter p; authors call it the first agent-based study of both marriage and divorce for global societies; fitted to UN divorce/marriage ratios and WVS married shares; 2014 IEEE ENIC precursor. Both independent checks mark the lifecycle true.

What it lacks. No dating stage (two singles marry on the spot), no conflict process, no memory of any kind, p fixed per run with no arms, no seeds, replication protocol, code or data; arXiv v1 only with no journal version.

### Perez Visaires 2023, agent-based social contagion of divorce (UOC/URV master's thesis)

https://hdl.handle.net/10609/148860

Why it is close. The one classical ABM where couples carry personality and conflict-style traits: 4,295 married Pairfam couples as agents on a Watts-Strogatz network, SIR, SIRa and informed-SIRa models with per-couple instability probabilities from a CatBoost classifier (ROC AUC 0.90), particle-swarm fitting to real per-wave divorce counts, Sobol sensitivity, 500 runs per model with dispersion reported.

What it lacks. States are married, divorced-infectious, divorced-recovered only, so no dating, separation, reunion or remarriage; conflict exists as survey features, not as a simulated process; agents hold one number (the conclusions name this as the main limitation); no arms, no CRN or placebo, no fixed seeds or hashes. The two independent checks disagree on code: one found an MIT-licensed GitHub repo (jperezvisaires/pairfam-multisim, work on branch test-dev, data gitignored), the other found no code link anywhere in the thesis text.

### Reinhardt, Hilton, Warnke, Bijak and Uhrmacher 2018, SESSL/ML3 experiment specification (JASSS 21(3) 9)

https://www.jasss.org/21/3/9.html

Why it is close. The closest prior on experiment harnessing: declarative experiment specs with replication criteria, central composite and Latin hypercube designs, GP emulation and simulation-based optimization over a linked-lives model whose shipped ML3 file has an explicit divorce rule and a marriage market that re-matches divorcees; models public, SESSL and ML3 under Apache 2.0.

What it lacks. The ML3 binding does not forward SESSL's root seed, so no fixed-seed replay; no arms, memory, CRN or placebo; divorce is a memoryless age hazard on the husband; no dating or conflict; the jasss2018 models repo has no licence. The two independent checks split on the lifecycle flag (one true for marriage, divorce and implicit remarriage, one false under the strict definition).

### Gottman, Swanson and Murray 1999 and Cook et al 1995, difference-equation model of marital conflict

https://doi.org/10.1037/0893-3200.13.1.3

Why it is close. The only verified model of the conflict interaction itself: each spouse's next-turn affect is a set point plus emotional inertia (a one-step autoregressive memory) plus a nonlinear influence of the partner's last turn, with thresholds; fitted to turn-by-turn coded conversations; couples who later divorced had more negative uninfluenced steady states and lower negative-influence thresholds.

What it lacks. Dyad level, deterministic, no population, no lifecycle, memory is one turn not days, no arms, no code. Evidence here is abstract-level only (MIT Press returned 403). One check flagged that the repair and damping terms are misattributed to the 1999 paper, and that correction remains unchecked.

## What LoveWorld can claim

- First simulation in the verified marriage and divorce literature (2005 to 2026) whose couples have an explicit conflict process with repair, hold, escalate, withdraw and leave decisions, and separation and reunion states. No prior has any conflict mechanism; Grow, Schnor and Van Bavel 2017 state their model does not consider divorce for reasons such as relationship problems, and MADAM, SOCSIM, Jarynowski and Nyczka and SESSL/ML3 dissolve marriages by trade-up, hazard rate or threshold only.
- First randomized, within-population intervention in this literature. Every verified prior varies parameters for the whole population: MADAM sweeps N, k, mu, sigma; Grow 2015 turns mechanisms off for all agents; Hammel 2005 shocks fertility or mortality for everyone; Silverman 2013 halves or doubles health probabilities globally; none has a treatment arm, so none needed an arm-blind policy.
- First agent memory with decay in this literature, and the first time memory is the intervened variable. The nearest prior constructs are MADAM's satisfice carry-over across marriages (the paper never uses the word memory), relationship duration in Grow 2015 and 2017, and Gottman and Murray's one-turn emotional inertia; no prior agent stores episodes or forgets them on a half-life.
- First common-random-number twin design in this domain. Hammel 2005 restarted from a common population but with a different random number per run; Grow 2017's shipped experiment sets seed_to_use to random; Snyder et al 2022's 'paired' SOCSIM runs used two disjoint seed sets (checked in their OSF outputs); SOCSIM's single global RNG stream cannot pair arms.
- First placebo-by-byte-identity and hash-verified replay in this domain. No prior claims bit-exact replay: SOCSIM intends seed determinism without a check and warns in-session runs can corrupt each other, Grow 2017 exposes a seed for full replication but the published runs did not use it, SESSL's root seed is not forwarded to ML3, Walker and Davis say repeated runs are similar but not identical and use unseeded Math.random().
- A printed, inspectable rule-based policy with named weights, blind to arm by construction, alongside the first explicit three-seed separation (population, assignment, dynamics) in this literature; priors with public code expose rules in NetLogo, Java or ML3 but have no arm to be blind to.
- The remarriage market is MADAM-style by lineage, and that lineage is real: Hills and Todd 2008 ran marriage, divorce as trade-up and remarriage in a persistent population with individual heterogeneity, and Walker's 2010 thesis and Bijak et al 2013 both cite it as prior work.
- Baseline agents are rule-based, not LLM-driven, by governance rule, which keeps the ATE attributable to the half-life change; no verified prior in this literature uses LLM agents either, so this is a design statement rather than a contrast.

## What LoveWorld does not claim

Each of these is a line the evidence does not support, with the reason.

- 'Nobody has ever built anything like this' or 'first ever', unqualified. The verified set covers marriage, divorce and kinship simulation only. Common random numbers, placebo runs and seeded replay are standard simulation-methodology tools, and no finding searched that general literature, LLM-agent social simulations or causal-inference-in-simulation frameworks. Claim first combination in this domain.
- 'First agent-based model of marriage and divorce.' Jarynowski and Nyczka already claim that in 2018 (with a 2014 IEEE precursor), MADAM did marriage, divorce and remarriage in 2008, and Grow, Schnor and Van Bavel added divorce and remarriage to an open model in 2017.
- 'First persistent-population lifecycle.' MADAM, Grow 2017, SOCSIM/rsocsim, Jarynowski and Nyczka and the SESSL healthcare.ml3 model all run marriage, divorce and remarriage in one persistent population. The new pieces are conflict, separation and reunion, not the lifecycle.
- 'First dating stage.' Grow and Van Bavel 2015 and 2017 already have single, dating and married statuses with a dating-to-marriage transition.
- 'First open or reproducible marriage-divorce model.' Grow 2017 is GPL-3.0 with a settable seed designed for full replication of a run, SOCSIM is GPL-3.0 with a seed-deterministic stream, Wedding Doughnut and SAMP are AFL-3.0 on CoMSES, and LoveWorld's repository was private when this review ran and is public now, so its reproducibility claims can be checked by anyone.
- 'Realistic', 'validated' or 'calibrated'. The project description has no empirical calibration. MADAM matched US census hazards, Grow matched ESS across 12 countries with 1,000 runs each, Calderón-Bernal matched 8.2 million Swedish register records, the Pairfam thesis fitted 4,295 real couples with Sobol sensitivity, and the Wedding Doughnut matched ONS pyramids. Any realism wording invites that comparison.
- 'The 14 vs 90 day conflict-memory half-life is grounded in human evidence.' No verified finding measures or manipulates conflict-memory retention in humans (see human evidence). Present it as a design parameter with a sensitivity sweep.
- 'Counterfactual twins have never been done in social simulation.' Hammel 2005 is a near miss (common starting population, scenario vs baseline, 100 runs each) and says controlling inter-run variation would sharpen the result; Snyder et al 2022 call their runs paired. Say no verified prior shared seeds across arms.
- 'First model with heterogeneous couples carrying personality and conflict traits.' The 2023 UOC thesis gives 4,295 couples Big Five and conflict-style features from Pairfam; LoveWorld's difference is that traits drive a simulated conflict process rather than a classifier.
- Citing the 2025 Journal of Mathematics divorce model (Gambrah et al, DOI 10.1155/jom/7108342) as a Duato-Jódar descendant. Its 40 to 41 references do not cite Duato or Jódar; the resemblance is thematic.
- Calling the UOC thesis 'the only ABM of divorce contagion'. That was the finding's own claim and was not independently verified by either check.
- 'No prior model has a conflict or reconciliation state.' An unread 2025 Acadlore paper (DOI 10.56578/atams030204) is titled as a compartmental model of conflict, adultery, divorce and reconciliation; by title it is aggregate, not agent-based, but it was read on 2026-10-11 and is aggregate, not agent-based, which is why the claim above says agent-level conflict process.

## Human evidence on conflict memory

Human evidence, clearly labelled: no verified finding measures how long people retain conflict memories or manipulates that retention, so the 14 versus 90 day half-life has no direct human anchor in this evidence set. What the record does hold, by strength. (1) Gottman, Swanson and Murray 1999 (Journal of Family Psychology 13(1):3-19) and Cook et al 1995, prospective observational studies fitting difference equations to turn-by-turn coded conflict conversations in a newlywed sample and the Gottman-Levenson cohort: couples who later divorced had more negative uninfluenced husband and wife steady states and lower negative-influence thresholds; the model's 'emotional inertia' is a one-turn autoregressive carry-over of affect, not retention over days. Strength: moderate for 'conflict negativity predicts later divorce', nil for retention half-lives; small clinical samples; read at abstract level only here. (2) McDermott, Fowler and Christakis 2013 (Social Forces 92(2):491-519), Framingham Offspring Cohort, N=5,124, seven exam waves 1971 to 2001, GEE lagged logit with QAP permutation against 1,000 randomized networks: divorce probability 75 percent higher (CI 58 to 96) with a divorced friend, 33 percent (CI 18 to 52) at two degrees, none at three; each inbound friendship nomination lowers divorce 10 percent; each child weakens the friend effect; divorcees remarry divorcees 138 to 303 percent more often. This is social clustering of divorce, not memory. Strength: moderate observational and longitudinal, one almost entirely white network, and the authors acknowledge spurious effects cannot be ruled out. (3) German Pairfam panel as used in the 2023 UOC thesis, 4,295 married couples, waves 1 to 9: conflict-style scales (verbal aggression, manipulation, withdrawal, constructive behaviour) together with Big Five, satisfaction, durations and partner history predict 'serious relationship problems' with CatBoost ROC AUC 0.90 and average precision 0.71; the target is problems, not divorce (about 2 percent of married couples per wave), and it is a master's thesis. Strength: weak to moderate, predictive not causal, and conflict is a feature rather than a measured memory. (4) A gap statement rather than evidence: Grow, Schnor and Van Bavel 2017 write that their model 'does not consider divorce for other reasons, such as relationship problems', which records conflict-driven divorce as an acknowledged hole in the population-ABM literature. Net: the human evidence in this set supports that conflict negativity and withdrawal predict later divorce and that divorce clusters socially; it says nothing about retention half-lives or about whether forgetting conflict faster lowers divorce. The README should present the half-life as a design parameter with a sensitivity sweep and say plainly that the sign and size of the ATE are a simulation result, not a human finding.

## Unverified and unread

- The Gottman and Murray entry rests on abstract-level reading only. One check flagged that the repair and damping terms belong to a later Gottman and Murray formulation rather than the 1999 paper, and that correction remains unchecked; the row and its citations rest on the bibliographic facts alone (the 1999 DOI resolves to Gottman, Swanson and Murray; 1995 is Cook et al; the MIT Press 2002 monograph DOI resolves).
- LoveWorld's own row and feature list come from the project description, not from reading the private repo; no claim about its implementation was audited.
- Scope limit: the verified set is marriage, divorce and kinship simulation only. Nobody searched general simulation methodology, LLM-agent social simulations, or causal-inference-in-simulation frameworks for common random numbers, placebo runs or hash-verified replay, so novelty of those techniques outside this domain is unverified.
- Full texts not opened: Todd, Billari and Simão 2005 published version (the 2004 submitted draft was read instead); Grow, Schnor and Van Bavel 2017 at Tandfonline (403; one check read the Lirias accepted manuscript, the other only the CoMSES archive); Calderón-Bernal et al 2026 typeset article (403; the April 2026 working-paper revision with identical title and abstract was read); Duato and Jódar 2013 journal version (only the 2011 proceedings read); Gambrah et al 2025 Journal of Mathematics (403 on four endpoints); all three Gottman and Murray items (abstract level; MIT Press 403).
- Unreachable: lab.demog.berkeley.edu/socsim refused connections, so SOCSIM's own licence text and manual were read from the rsocsim repo copy; Semantic Scholar returned 429 in several checks; general web search was unavailable to the independent checks, which used direct page fetches and a paired search (one engine answers, a second is set to refute it) instead.
- The two independent checks disagreed on the lifecycle flag for MADAM, SESSL/ML3, Grow and Van Bavel 2015 and Calderón-Bernal (true in the marriage-divorce-remarriage sense, false under the strict five-part definition); the table marks these Partial.
- The two independent checks disagreed on code availability for the 2023 UOC thesis: one found an MIT-licensed GitHub repo (jperezvisaires/pairfam-multisim) whose work sits on branch test-dev, the other found no code link in the thesis text. Marked Partial. The same check noted two notebook cells add hard-coded offsets to plotted series; whether a thesis figure reflects them is undetermined.
- MADAM code: no CoMSES deposit found under MADAM, marriage divorce, Hills or Todd, but deeper result pages were not fully walked, so 'no deposit' is consistent rather than exhaustive.
- The 2025 Journal of Mathematics paper's claimed Duato-Jódar lineage was dropped: its 40 to 41 references do not cite Duato or Jódar. Its 'no empirical calibration or intervention' note is inferred from abstract and references only.
- Lineage pointers seen as titles only, not read: 'Dynamics of Divorce Epidemic' (MMAS 2025, DOI 10.1002/mma.11077), a 2025 Acadlore compartmental model of conflict, adultery, divorce and reconciliation (DOI 10.56578/atams030204), Chen-Charpentier et al 2025 marital satisfaction model (DOI 10.1002/mma.70382), and a 2026 American Journal of Applied Mathematics divorce model with counselling (DOI 10.11648/j.ajam.20261405.17). The Acadlore title names conflict and reconciliation states, so it should be read before the README asserts that no prior model has a conflict state of any kind.
- The finding's claim that the UOC thesis is 'the only classical ABM of divorce contagion' was not independently verified.
- Snyder et al 2022 was read only to check its 'paired' wording (disjoint seed sets confirmed from OSF run folders); its full methods were not otherwise reviewed, and Calderón-Bernal et al 2025 (European Journal of Population, DOI 10.1007/s10680-025-09756-4) was reported by the search route as ten rsocsim runs with different seeds and not opened.
- Whether the Grow and Van Bavel 2015 NetLogo code pins an internal seed is unverified (the 641 MB Dataverse zip was not downloaded); the paper text mentions none.
- Hammel 2005 never states whether the same random numbers were reused across scenarios, so 'no CRN pairing' there is an inference from silence; the paper also never states SOCSIM's licence (open-source status comes from the rsocsim README).

## Sources

- Thomas Hills and Peter Todd. Population Heterogeneity and Individual Differences in an Assortative Agent-Based Marriage and Divorce Model (MADAM) Using Search with Relaxing Expectations. Journal of Artificial Societies and Social Simulation 11(4) 5, 2008. https://www.jasss.org/11/4/5.html
- Francesco C. Billari, Alexia Prskawetz, Belinda Aparicio Diaz and Thomas Fent. The 'Wedding-Ring': An agent-based marriage model based on social interaction. Demographic Research 17(3):59-82, 2007. https://www.demographic-research.org/volumes/vol17/3/
- Peter M. Todd, Francesco C. Billari and Jorge Simão. Aggregate age-at-marriage patterns from individual mate-search heuristics. Demography 42(3):559-574, 2005. DOI 10.1353/dem.2005.0027; open submitted draft: https://csde.washington.edu/downloads/toddbillarisimao.pdf
- Jakub Bijak, Jason Hilton, Eric Silverman and Viet Dung Cao. Reforging the Wedding Ring: Exploring a Semi-Artificial Model of Population for the United Kingdom with Gaussian process emulators. Demographic Research 29(27):729-766, 2013. https://www.demographic-research.org/volumes/vol29/27/
- Eric Silverman, Jakub Bijak, Jason Hilton, Viet Dung Cao and Jason Noble. When Demography Met Social Simulation: A Tale of Two Modelling Approaches. Journal of Artificial Societies and Social Simulation 16(4) 9, 2013. https://www.jasss.org/16/4/9.html; model 'Wedding Doughnut', CoMSES codebase 3549 (Java, AFL-3.0): https://www.comses.net/codebases/3549/
- Oliver Reinhardt, Jason Hilton, Tom Warnke, Jakub Bijak and Adelinde M. Uhrmacher. Streamlining Simulation Experiments with Agent-Based Models in Demography. Journal of Artificial Societies and Social Simulation 21(3) 9, 2018. https://www.jasss.org/21/3/9.html; models: https://git.informatik.uni-rostock.de/mosi/jasss2018
- André Grow and Jan Van Bavel. Assortative Mating and the Reversal of Gender Inequality in Education in Europe: An Agent-Based Model. PLOS ONE 10(6):e0127806, 2015. https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0127806; code and data: Harvard Dataverse doi:10.7910/DVN/HPUQ1Y (CC0)
- André Grow, Christine Schnor and Jan Van Bavel. The reversal of the gender gap in education and relative divorce risks: a matter of alternatives in partner choice? Population Studies 71(sup1):15-34, 2017. https://doi.org/10.1080/00324728.2017.1371477; code: CoMSES codebase 5105 v1.5.0 (NetLogo, GPL-3.0): https://www.comses.net/codebases/5105/releases/1.5.0/
- Lyndon Walker and Peter Davis. Modelling Marriage Markets: A Population-Scale Implementation and Parameter Test. Journal of Artificial Societies and Social Simulation 16(1) 6, 2013. https://www.jasss.org/16/1/6.html; code printed in Walker's 2010 University of Auckland thesis: https://hdl.handle.net/2292/5823
- Tom Theile, Diego Alburez-Gutierrez, Mallika Snyder and Liliana P. Calderón-Bernal. rsocsim: SOCSIM with R, version 1.9.18 (GPL-3.0), MPIDR, 2026. https://github.com/MPIDR/rsocsim; SOCSIM manual 'Socsim Oversimplified' (Carl Mason, 2016): https://github.com/MPIDR/rsocsim/blob/main/socsim_oversimplified.md
- E. A. Hammel. Demographic dynamics and kinship in anthropological populations. Proceedings of the National Academy of Sciences 102(6):2248-2253, 2005. https://pmc.ncbi.nlm.nih.gov/articles/PMC548587/
- Mallika Snyder, Diego Alburez-Gutierrez, Iván Williams and Emilio Zagheni. Estimates from 31 countries show the significant impact of COVID-19 excess mortality on the incidence of family bereavement. PNAS 119(26):e2202686119, 2022 (SOCSIM runs described as paired; seed sets disjoint per OSF outputs). https://www.ebi.ac.uk/europepmc/webservices/rest/PMC9245632/fullTextXML
- Liliana P. Calderón-Bernal, Diego Alburez-Gutierrez, Martin Kolk and Emilio Zagheni. Assessing the agreement between microsimulated and register-based kin counts in Sweden. Population Studies, online 30 July 2026. https://doi.org/10.1080/00324728.2026.2706778; working-paper text: https://www.demogr.mpg.de/papers/working/wp-2025-020.pdf; code: https://github.com/liliana-calderon/SOCSIM_Registers
- Liliana P. Calderón-Bernal, Diego Alburez-Gutierrez and Emilio Zagheni. Analysing biases in genealogies using demographic microsimulation. MPIDR Working Paper WP-2023-034 (revised October 2025). https://www.demogr.mpg.de/papers/working/wp-2023-034.pdf; code: https://github.com/liliana-calderon/SOCSIM_Genealogies
- Rose McDermott, James H. Fowler and Nicholas A. Christakis. Breaking Up Is Hard to Do, Unless Everyone Else Is Doing It Too. Social Forces 92(2):491-519, 2013. https://pmc.ncbi.nlm.nih.gov/articles/PMC3990282/
- Jon Perez Visaires (director Jordi Duch Gavaldà). An agent-based simulation study of the social contagion of divorce. Master's thesis, Universitat Oberta de Catalunya and Universitat Rovira i Virgili, September 2023. https://hdl.handle.net/10609/148860; code per one check: https://github.com/jperezvisaires/pairfam-multisim
- Rubén Duato and Lucas Jódar. Mathematical modeling of the spread of divorce in Spain. Mathematical and Computer Modelling 57(7-8):1732-1737, 2013. DOI 10.1016/j.mcm.2011.11.020; 2011 extended abstract (pp. 105-111): https://imm.webs.upv.es/jornadas/proceedings/Modelling2011.pdf
- Patience Pokuaa Gambrah and Abdul-Samad Abdul-Rahaman. Modelling Divorce Epidemic on Network. Mathematical Theory and Modeling 13(3):11-18, 2023. https://iiste.org/Journals/index.php/MTM/article/view/61843
- Patience Pokuaa Gambrah, Davidon Jani, Kwasi Frempong Sarfo, Herman Matondo Mananga and Forster Owusu. Mathematical Modeling of Divorce Incidence With Social Media Influence Using Caputo Fractional Derivative. Journal of Mathematics 2025:7108342, 2025 (CC BY; full text not opened, metadata via Crossref). https://doi.org/10.1155/jom/7108342
- Andrzej Jarynowski and Piotr Nyczka. Single parameter model of marriage/divorces dynamics with countries classification. arXiv:1805.02878, 2018. https://arxiv.org/abs/1805.02878
- John M. Gottman, Catherine Swanson and James Murray. The mathematics of marital conflict: Dynamic mathematical nonlinear modeling of newlywed marital interaction. Journal of Family Psychology 13(1):3-19, 1999. https://doi.org/10.1037/0893-3200.13.1.3
- Julian Cook, Rebecca Tyson, Jane White, Regina Rushe, John Gottman and James Murray. Mathematics of marital conflict: Qualitative dynamic mathematical modeling of marital interaction. Journal of Family Psychology 9(2):110-130, 1995. https://doi.org/10.1037/0893-3200.9.2.110
- John M. Gottman, James D. Murray, Catherine C. Swanson, Rebecca Tyson and Kristin R. Swanson. The Mathematics of Marriage: Dynamic Nonlinear Models. MIT Press, 2002. https://doi.org/10.7551/mitpress/4499.001.0001
- Aliyu Danladi Hina, Isah Abdullahi and Adamu Garba Tahiru. Exploring the Dynamics and Numerical Analysis of a Mathematical Model for the Interactions Between Conflict, Adultery, Divorce, and Reconciliation Under Socioeconomic Influences. Acadlore Transactions on Applied Mathematics and Statistics 3(2), 2025. https://doi.org/10.56578/atams030204
- Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang and Michael S. Bernstein. Generative Agents: Interactive Simulacra of Human Behavior. UIST 2023. https://arxiv.org/abs/2304.03442
- Yue and colleagues. RELATE-Sim. arXiv:2510.00414, 2025. https://arxiv.org/abs/2510.00414
- Shang and colleagues. Love First, Know Later. arXiv:2512.11844, 2025. https://arxiv.org/abs/2512.11844

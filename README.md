<p align="center">
  <img src="docs/figures/hero.svg" alt="What does a grudge do to a marriage? LoveWorld runs 1,000 agent couples for one year, with one memory setting changed between the arms. Blue is the arm that forgets fights in 2 weeks, orange the arm that holds onto fights for 3 months. Divorced in a year, 2.6% against 15.4%, up 12.8 points, 95% confidence interval (CI) 9.6 to 16.4. Trust at year end, 0.65 against 0.21, down 0.44, 95% CI -0.46 to -0.41. Conflicts per couple, 7.4 against 12.9, up 5.5 a year, 95% CI 4.8 to 6.2. Redrawn from the example run by python3 tools/figures.py --write." width="100%">
</p>

<div align="center">

<b><font size="6">LoveWorld</font></b>

<br/>

<!-- badges:start, python3 tools/figures.py --write fills this block and --check fails when it drifts -->
<a href="https://github.com/jameswniu/multi-agent-causal-marriage-simulation/actions/workflows/ci.yml"><img alt="Test status on main" src="https://img.shields.io/github/actions/workflow/status/jameswniu/multi-agent-causal-marriage-simulation/ci.yml?branch=main&style=flat-square&labelColor=0e1119&label=tests"></a>
<a href="results/example/summary.json"><img alt="Divorce effect in the example run, holds onto fights for 3 months against forgets fights in 2 weeks, +12.8 points with a 95% confidence interval of 9.6 to 16.4" src="https://img.shields.io/badge/divorce_effect-%2B12.8_points_%289.6_to_16.4%29-4a5263?style=flat-square&labelColor=0e1119"></a>
<a href="results/example/summary.json"><img alt="Placebo run with identical arms, divorce difference -1.2 points, 95% confidence interval -3.0 to +0.4, which covers zero" src="https://img.shields.io/badge/placebo-null_%28--3.0_to_%2B0.4%29-4a5263?style=flat-square&labelColor=0e1119"></a>
<a href="results/example/manifest.json"><img alt="Replay reruns the example and checks all 9 output tables against their SHA-256 fingerprints" src="https://img.shields.io/badge/replay-bit--exact%2C_9_tables-4a5263?style=flat-square&labelColor=0e1119"></a>
<a href="experiments/example.yaml"><img alt="The example run simulates 1,000 agent couples for 365 days" src="https://img.shields.io/badge/simulation-1%2C000_couples%2C_365_days-4a5263?style=flat-square&labelColor=0e1119"></a>
<a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache_2.0-4a5263?style=flat-square&labelColor=0e1119"></a>
<br/>
<a href="engine/Cargo.toml"><img alt="Rust engine on bevy_ecs 0.20, the entity component system (ECS) from the Bevy game engine, which keeps each agent as plain data that the daily systems update" src="https://img.shields.io/badge/Rust-bevy__ecs_0.20-4a5263?style=flat-square&labelColor=0e1119&logo=rust&logoColor=eef0f4"></a>
<a href="python/pyproject.toml"><img alt="Python 3.12 or newer for experiments and statistics" src="https://img.shields.io/badge/Python-3.12%2B-4a5263?style=flat-square&labelColor=0e1119&logo=python&logoColor=eef0f4"></a>
<a href="frontend/package.json"><img alt="React 18 dashboard with a PixiJS 8 town" src="https://img.shields.io/badge/React-18%2C_PixiJS_8-4a5263?style=flat-square&labelColor=0e1119&logo=react&logoColor=eef0f4"></a>
<a href="python/loveworld/translate.py"><img alt="Claude Haiku 5.5 turns a plain-words shock into settings" src="https://img.shields.io/badge/Claude-Haiku_5.5-4a5263?style=flat-square&labelColor=0e1119&logo=claude&logoColor=eef0f4"></a>
<!-- badges:end -->

<br/>

A multi-agent simulation of married couples that runs a randomized controlled trial on one setting, how long each partner remembers a fight.<br/>
Every decision is logged and every run replays exactly, so each effect traces back to the rules that caused it.

<br/>

<a href="https://jameswniu.github.io/multi-agent-causal-marriage-simulation/"><img alt="Read-only demo of the dashboard on GitHub Pages, with the example town and three shocks run in advance" src="https://img.shields.io/badge/demo-try_it_in_your_browser-4a5263?style=flat-square&labelColor=0e1119"></a><br/>
<a href="https://jameswniu.github.io/multi-agent-causal-marriage-simulation/">Try the read-only demo in your browser</a>: the example town and three shocks run in advance, with nothing to install.

</div>

## Watch it

The World page plays the year back as a town, one house for each couple.

<p align="center">
  <img src="assets/town-playback-v2.gif" alt="The World page playing the example year at ten days a second. Couples who forget a fight in two weeks live on the left under blue roofs, and couples who hold onto it for three months live on the right under orange roofs. As the days pass the right side fills with couples standing outside in a fight, divorced people gather in the plaza between the two sides, and the scoreboard above counts far more divorces and fights on the right while its trust falls." width="100%">
</p>

- Couples on the left forget a fight in two weeks, and couples on the right hold onto it for three months.
- A couple in a fight stands outside its house, and a divorce sends both partners to the plaza.
- Lenses recolour every house by trust, stress, grudge or warmth, and a click opens that couple's year.

<p align="center">
  <img src="assets/grudge-lens-v2.png" alt="The town on day 300 under the grudge lens, which colours each house by how much negative memory its couple carries. Houses on the left, where fights fade in two weeks, are mostly green, and houses on the right, where fights are held for three months, are mostly red, an average grudge of 0.30 against 1.31." width="65%">
  <img src="assets/couple-panel-v2.png" alt="The panel for couple 3 on day 300, a couple that holds onto fights for three months, on the second day of a fight. Both partners' trust lines have sunk to 0.10 and 0.22, their mood sits at the floor, both grudge bars are full at 1.50, and the latest events read conflict started, repair attempted, repair rejected and withdrew." width="31%">
</p>

## Try a shock

Describe a life event in plain words, and the town runs it again right where you watch.

<p align="center">
  <img src="assets/shock-in-place-v3.gif" width="100%" alt="The World page of the example town. Shock this world opens a box above the town, and the sentence his mother moves in for two months starting in month four goes in. These words were translated before, so Translate answers from the translation saved for them on 12 October 2026 with no new model call and says so on the shock card, which raises stress by 0.5 and lowers mood by 0.03 a day for both partners from day 90 to day 150 in the treatment arm, the same shock the read-only demo runs. Run waits its turn and runs, then the page switches to the new world and replays it from day 80 at ten days a second. From day 90, pink rings light up around the houses on the right, the couples who hold onto fights, and the counter above the town climbs to close to 300 of 1,000 couples that differ from the original that day.">
</p>

- An LLM (a large language model, here Claude Haiku) turns the sentence into a shock card you can read and edit before anything runs.
- The new world keeps the same couples and the same random draws, so every ring is the shock's doing.
- A switch draws the original town on the same day, and the new world's Overview compares each couple's whole year.

## What it found

In this world, holding onto fights for three months instead of two weeks drives divorce up sharply.

<p align="center">
  <img src="docs/figures/results.svg" alt="Example run, control against treatment. 1,000 couples over 365 days, seeds 11, 22, 33. Bars are arm means, row by row. The right column is treatment minus control with its 95% bootstrap interval. Measured on every couple: divorced within the year 2.6% against 15.4%, effect +12.8 points, 95% CI 9.6 to 16.4; separated at least once 19.2% against 83.0%, effect +63.8 points, 95% CI 59.2 to 68.4; days married until divorce or end 359.6 against 337.2, effect -22.5, 95% CI -30.1 to -15.4; trust on the last day 0.65 against 0.21, effect -0.44, 95% CI -0.46 to -0.41; mean trust over the year 0.64 against 0.33, effect -0.31, 95% CI -0.33 to -0.28; conflicts per couple-year 7.4 against 12.9, effect +5.5, 95% CI 4.8 to 6.2. Conditional on events after assignment: escalations per conflict 2.4 against 5.8, effect +3.4, 95% CI 3.0 to 3.8; conflicts ending reconciled 86.2% against 52.6%, effect -33.6 points, 95% CI -37.4 to -30.1; days from conflict to repair 5.7 against 10.9, effect +5.3, 95% CI 4.5 to 6.0; divorced agents who remarried 34.6% against 7.1%, effect -27.5 points, 95% CI -52.4 to -4.4. Blue bars are control with a 14-day conflict memory, orange bars treatment with a 90-day one." width="100%">
</p>

- Remembered fights make the next fight likelier and repair rarer, trust wears down, and the loop runs all year.
- A placebo run, where both halves of the town get the same memory, finds no divorce effect.
- A twin run, where every couple lives both settings on the same random draws, finds an effect of about the same size.
- Halving the long memory shrinks the divorce effect, so the effect grows with how long fights are kept.

## How it works

One small config file defines an experiment, and three layers turn it into numbers anyone can rerun.

<p align="center">
  <img src="docs/figures/how-it-works.svg" alt="How a run flows, from an experiment file to a dashboard with every step logged. 1,000 couples, 365 days, one second in the engine. Section 01, the experiment file. One YAML file is the whole experiment. experiments/example.yaml. Couples, days, three seeds, the treatment memory half-life, and any shocks. Python turns it into the engine's config JSON and keeps both. Section 02, the engine. Rust on Bevy, no graphics, same seed same result. One schedule, every day. Stress, affect, conflict decision, trust, memory decay, market, log. Every draw keyed by seed and id. What it writes. Nine Parquet tables, one manifest with a SHA-256 per table. Replay fails on any mismatch. Section 03, the analysis. Python reads the tables and writes summary.json. Effects with intervals. Effect per outcome, with bootstrap intervals and permutation p-values. Conditional outcomes are flagged. Two checks on every experiment. Placebo: equal parameters, both arms must match byte for byte. Twins: each couple under both arms. Section 04, the dashboard. FastAPI serves the results, React shows them. World replay and the causal readout. Play the year day by day, open any couple or agent, read every decision. Pick a shock and run a new experiment from the page in about ten seconds. The policy never reads the arm. A test greps four modules for the word." width="100%">
</p>

- A Rust engine splits the couples into two groups at random, then moves every agent through each day on seeded random draws and logs each decision with the scores behind it.
- Python does the causal inference, measuring what the memory setting caused, with an interval from resampling couples for every effect.
- A React dashboard with a PixiJS town, served by FastAPI, replays the year and reads out every effect.

The model and the causal design are in [docs/design.md](docs/design.md), and every file format is in [docs/contracts.md](docs/contracts.md).

## Run it

You need Rust, uv (a Python project manager) and Node 20 or newer.

```bash
make placebo twins example   # build the engine, run both checks, then the example experiment
make replay                  # rerun the example and compare every table's SHA-256 fingerprint
make frontend-install build  # dashboard dependencies, then the engine and dashboard builds
make test                    # Rust, Python and frontend test suites
make figures-check           # fail if a figure or a badge no longer matches the results
```

Then `make serve` hosts the dashboard on http://127.0.0.1:8765. The shock box needs an Anthropic key in `ANTHROPIC_API_KEY`, and everything else runs offline. A public deployment with visitor limits is described in [docs/deploy.md](docs/deploy.md).

## Limits

- The agents follow hand-set rules fitted to no data, so every effect describes this world and nothing about people.
- The two memory lengths are design choices, since no human study measures how long people hold onto a fight.
- Shocks are stylised, so a job loss is a jump in stress rather than a bank balance.

## Prior art

[docs/prior-art.md](docs/prior-art.md) checks eighteen marriage and divorce simulations against their sources, and none pairs decaying agent memory with a randomized trial inside one population.

## License

Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The town art is Kenney's public-domain tile sets, credited in [CREDITS.md](frontend/public/assets/kenney/CREDITS.md).

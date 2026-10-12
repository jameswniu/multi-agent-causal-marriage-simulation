#!/usr/bin/env python3
"""Measure how evenly couple mode and pairs mode split the example's couples.

For each assignment seed (the population and dynamics seeds stay at the example's), the script runs
the placebo, both arms on the control memory, and records the gap between the arms' means, which
is pure assignment luck. It runs the example on the same seeds and records the effect and the width
of its interval, each mode with its own inference. Runs go one at a time. It also reports the exact
spread of the placebo gap, over every possible assignment, from one placebo run's outcomes: that
needs no sampling, so it checks the seed sweep, and it is repeated on a population the pairing
weights were never fitted on.

    cd python && uv run python ../tools/pairs_sweep.py --seeds 100 --out /tmp/pairs-sweep
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from loveworld import engine as eng
from loveworld.analysis import couple_frame, load_tables, outcomes_table
from loveworld.experiment import AnalysisSettings, build_engine_config, load_experiment

ROOT = Path(__file__).resolve().parent.parent
GAPS = ("divorce_rate", "final_trust", "mean_trust", "conflict_rate")
EFFECTS = ("divorce_rate", "final_trust", "conflict_rate")
BEHAVIOUR = ("events.parquet", "daily.parquet", "decisions.parquet", "conflicts.parquet", "episodes.parquet")
MODES = ("couple", "pairs")


def _config(
    base: dict[str, Any], mode: str, seed: int, population: int | None = None, dynamics: int | None = None
) -> dict[str, Any]:
    cfg = copy.deepcopy(base)
    cfg["assignment"]["mode"] = mode
    cfg["seeds"]["assignment"] = seed
    if population is not None:
        cfg["seeds"]["population"] = population
    if dynamics is not None:
        cfg["seeds"]["dynamics"] = dynamics
    return cfg


def _gaps(run: Path) -> dict[str, float]:
    df = couple_frame(load_tables(run))
    t = df["arm"] == "treatment"
    return {name: float(df.loc[t, name].mean() - df.loc[~t, name].mean()) for name in GAPS}


def exact_spread(run: Path) -> dict[str, dict[str, float]]:
    """Exact standard deviation of the placebo gap over every assignment, for both designs.

    The placebo's outcomes do not depend on the arms, so one run fixes them. An exact half split of n
    couples gives sd = s * sqrt(4 / n) (s the sample standard deviation), and pairs give
    sd = sqrt(sum of squared within-pair differences) / (n / 2). Both assume an even count.
    """
    t = load_tables(run)
    df = couple_frame(t)
    n = len(df)
    if n % 2:
        raise ValueError("the exact spreads assume an even number of couples")
    pairs = df["cluster"].to_numpy() if t.design == "pairs" else None
    out: dict[str, dict[str, float]] = {}
    for name in GAPS:
        y = df[name].to_numpy(dtype=float)
        row = {"couple": float(y.std(ddof=1) * math.sqrt(4.0 / n))}
        if pairs is not None:
            order = np.argsort(pairs, kind="stable")
            d = y[order][0::2] - y[order][1::2]
            row["pairs"] = float(math.sqrt(float((d**2).sum())) / (n / 2.0))
        out[name] = row
    return out


def sweep(n_seeds: int, out: Path, n_boot: int) -> dict[str, Any]:
    """Run the placebo and the example once per seed and mode, one engine run at a time."""
    exp = load_experiment(ROOT / "experiments" / "example.yaml")
    placebo_cfg = build_engine_config(exp, placebo=True)
    example_cfg = build_engine_config(exp)
    settings = AnalysisSettings(n_boot=n_boot, n_perm=0, seed=exp.analysis.seed)
    seeds = list(range(1, n_seeds + 1))
    rows: list[dict[str, Any]] = []
    hashes: set[tuple[str, ...]] = set()
    work = Path(tempfile.mkdtemp(prefix="pairs-sweep-", dir=out))
    exact: dict[str, Any] = {}
    try:
        for mode in MODES:
            for seed in seeds:
                run = work / f"{mode}-placebo"
                manifest = eng.run_engine(_config(placebo_cfg, mode, seed), run, overwrite=True)
                hashes.add(tuple(manifest["files"][f]["sha256"] for f in BEHAVIOUR))
                gaps = _gaps(run)
                if seed == seeds[0]:
                    exact[mode] = exact_spread(run)
                run = work / f"{mode}-example"
                eng.run_engine(_config(example_cfg, mode, seed), run, overwrite=True)
                t = load_tables(run)
                effects = {o["name"]: o for o in outcomes_table(couple_frame(t), settings, t.design)}
                rows.append(
                    {
                        "mode": mode,
                        "seed": seed,
                        "placebo_gap": gaps,
                        "effect": {k: effects[k]["ate"] for k in EFFECTS},
                        "ci_low": {k: effects[k]["ci_low"] for k in EFFECTS},
                        "ci_high": {k: effects[k]["ci_high"] for k in EFFECTS},
                    }
                )
                gap = 100 * gaps["divorce_rate"]
                print(f"{mode:6s} seed {seed:3d}  placebo divorce gap {gap:+.1f} points", flush=True)
        # A population and a year the weights never saw, for the exact spreads only.
        fresh: dict[str, Any] = {}
        for mode in MODES:
            run = work / f"{mode}-fresh"
            eng.run_engine(_config(placebo_cfg, mode, 1, population=12, dynamics=34), run, overwrite=True)
            fresh[mode] = exact_spread(run)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {
        "seeds": seeds,
        "population_seed": placebo_cfg["seeds"]["population"],
        "dynamics_seed": placebo_cfg["seeds"]["dynamics"],
        "n_boot": n_boot,
        "placebo_behaviour_identical": len(hashes) == 1,
        "rows": rows,
        "exact": {"couple": exact["couple"], "pairs": exact["pairs"]},
        "exact_fresh_population": {"population": 12, "dynamics": 34, **fresh},
    }


def report(data: dict[str, Any]) -> dict[str, Any]:
    """Spreads, exceedance, effects and widths per mode, with a bootstrap interval on the spread cut."""
    rows = data["rows"]
    rng = np.random.default_rng(7)
    out: dict[str, Any] = {"placebo": {}, "example": {}}
    by_mode = {m: [r for r in rows if r["mode"] == m] for m in MODES}
    for name in GAPS:
        g = {m: np.array([r["placebo_gap"][name] for r in by_mode[m]]) for m in MODES}
        sd = {m: float(g[m].std(ddof=1)) for m in MODES}
        boots = []
        for _ in range(4000):
            i = rng.integers(0, len(g["couple"]), len(g["couple"]))
            j = rng.integers(0, len(g["pairs"]), len(g["pairs"]))
            boots.append(1.0 - g["pairs"][j].std(ddof=1) / g["couple"][i].std(ddof=1))
        lo, hi = np.percentile(boots, [2.5, 97.5])
        out["placebo"][name] = {
            "sd": sd,
            "cut": 1.0 - sd["pairs"] / sd["couple"],
            "cut_95": [float(lo), float(hi)],
            "exact_sd": {m: data["exact"][m][name]["couple" if m == "couple" else "pairs"] for m in MODES},
            "exact_sd_fresh_population": {
                m: data["exact_fresh_population"][m][name]["couple" if m == "couple" else "pairs"] for m in MODES
            },
        }
        if name == "divorce_rate":
            out["placebo"][name]["share_over_1_point"] = {m: float(np.mean(np.abs(g[m]) > 0.01)) for m in MODES}
    for name in EFFECTS:
        row: dict[str, Any] = {}
        for m in MODES:
            eff = np.array([r["effect"][name] for r in by_mode[m]])
            width = np.array([r["ci_high"][name] - r["ci_low"][name] for r in by_mode[m]])
            low = np.array([r["ci_low"][name] for r in by_mode[m]])
            high = np.array([r["ci_high"][name] for r in by_mode[m]])
            row[m] = {
                "mean_effect": float(eff.mean()),
                "sd_effect": float(eff.std(ddof=1)),
                "mean_ci_width": float(width.mean()),
                "mean_ci": [float(low.mean()), float(high.mean())],
            }
        row["pairs_mean_inside_couple_interval"] = bool(
            row["couple"]["mean_ci"][0] <= row["pairs"]["mean_effect"] <= row["couple"]["mean_ci"][1]
        )
        out["example"][name] = row
    cut = out["placebo"]["divorce_rate"]["cut"]
    out["decision"] = {
        "divorce_spread_cut": cut,
        "needed": 0.20,
        "effect_inside_interval": out["example"]["divorce_rate"]["pairs_mean_inside_couple_interval"],
        "switch_default": bool(cut >= 0.20 and out["example"]["divorce_rate"]["pairs_mean_inside_couple_interval"]),
    }
    return out


def main() -> None:
    """Run the sweep, write sweep.json and report.json, and print the report."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seeds", type=int, default=100, help="Assignment seeds per mode (at least 30)")
    ap.add_argument("--n-boot", type=int, default=2000, help="Bootstrap resamples for each example interval")
    ap.add_argument("--out", type=Path, required=True, help="Directory for sweep.json and report.json")
    args = ap.parse_args()
    if args.seeds < 30:
        ap.error("use at least 30 seeds")
    args.out.mkdir(parents=True, exist_ok=True)
    data = sweep(args.seeds, args.out, args.n_boot)
    (args.out / "sweep.json").write_text(json.dumps(data, indent=1))
    rep = report(data)
    (args.out / "report.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()

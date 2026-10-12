#!/usr/bin/env python3
"""Fit the pairs-mode risk score from the example run's control arm.

A pairs-mode run sorts couples by a risk score built from six values drawn before day 0 and pairs
neighbours. The weights are an ordinary least squares fit, over the example's control couples, of
the average of the standardised divorce indicator and the standardised conflict rate on the six
covariates standardised over the whole population. The intercept is dropped, and so is the overall
scale, since only the order of the scores matters. The engine's defaults under
`assignment.pair_weights` are this script's output rounded to three decimals.

The committed example keeps only its small tables, so regenerate it first:

    make example
    cd python && uv run python ../tools/fit_pair_weights.py ../results/example
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from loveworld.analysis import PAIR_COVARIATES, couple_covariates, couple_frame, load_tables


def _z(v: np.ndarray) -> np.ndarray:
    sd = v.std()
    return (v - v.mean()) / sd if sd > 0 else np.zeros_like(v)


def _r2(y: np.ndarray, x: np.ndarray) -> float:
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta
    return float(1.0 - resid.var() / y.var()) if y.var() > 0 else float("nan")


def fit(results_dir: Path) -> dict[str, object]:
    """Weights, fit quality and provenance for one results directory."""
    t = load_tables(results_dir)
    cov = couple_covariates(t.agents)
    z = (cov - cov.mean()) / cov.std(ddof=0)
    df = couple_frame(t)
    ctrl = df.index[df["arm"] == "control"]
    x = np.column_stack([np.ones(len(ctrl)), z.loc[ctrl, list(PAIR_COVARIATES)].to_numpy(dtype=float)])
    divorce = _z(df.loc[ctrl, "divorce_rate"].to_numpy(dtype=float))
    conflict = _z(df.loc[ctrl, "conflict_rate"].to_numpy(dtype=float))
    target = (divorce + conflict) / 2.0
    beta, *_ = np.linalg.lstsq(x, target, rcond=None)
    seeds = t.config.get("seeds", {})
    return {
        "source": str(results_dir),
        "seeds": seeds,
        "determinism_hash": t.manifest.get("determinism_hash"),
        "control_couples": int(len(ctrl)),
        "weights": {name: round(float(w), 3) for name, w in zip(PAIR_COVARIATES, beta[1:], strict=True)},
        "r2": {
            "combined": round(_r2(target, x), 3),
            "divorce": round(_r2(divorce, x), 3),
            "conflict_rate": round(_r2(conflict, x), 3),
        },
    }


def main() -> None:
    """Print the fit as JSON."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results_dir", type=Path, help="A full results directory (run `make example` first)")
    print(json.dumps(fit(ap.parse_args().results_dir), indent=2))


if __name__ == "__main__":
    main()

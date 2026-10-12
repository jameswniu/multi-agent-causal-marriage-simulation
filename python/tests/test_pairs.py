"""Pairs mode: couples sorted by a pre-treatment risk score, paired with a neighbour, one coin per pair.

The analysis of a pairs run resamples whole pairs for its intervals and flips arms within pairs for its
p-values (Bai, Romano and Shaikh). Couple and block runs are analysed exactly as before; the golden
numbers below were produced by the analysis as it stood before pairs mode existed, on a synthetic frame
that needs no engine.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from loveworld import analysis
from loveworld import engine as eng
from loveworld.analysis import estimate_effect, estimate_paired_effect, outcomes_table
from loveworld.experiment import AnalysisSettings, build_engine_config, parse_experiment

PAIRS = {"assignment": {"mode": "pairs"}}

GOLDEN = {
    "couple": {
        "divorce_rate": (0.13333333333333333, 0.03333333333333333, 0.25, 0.023255813953488372),
        "separation_rate": (0.23333333333333334, 0.08333333333333334, 0.4, 0.009966777408637873),
        "days_married": (-22.014269690520507, -26.92891377192421, -17.748140412921117, 0.0033222591362126247),
        "final_trust": (-0.39806794002333834, -0.4343247482812114, -0.35989181116037866, 0.0033222591362126247),
        "mean_trust": (-0.2822637164863819, -0.3097150916847769, -0.2533463998038154, 0.0033222591362126247),
        "conflict_rate": (3.750000000000001, 2.674583333333334, 5.025416666666666, 0.0033222591362126247),
        "escalations_per_conflict": (
            -0.27935366624525915,
            -0.37613857510371096,
            -0.1772089503828872,
            0.0033222591362126247,
        ),
        "reconciliation_rate": (-0.16026966980770707, -0.25088696866370225, -0.08177697028423778, 0.006644518272425249),
        "recovery_days": (-0.14962976340978867, -0.23559300086046425, -0.07383702453158607, 0.0033222591362126247),
        "remarriage_rate": (-0.22303125000000001, -0.3064040332396874, -0.13752283593687858, 0.0033222591362126247),
    },
    "block": {
        "divorce_rate": (0.0, -0.06666666666666668, 0.08333333333333333, 1.0),
        "separation_rate": (0.35, 0.16666666666666669, 0.4833333333333334, 0.016611295681063124),
        "days_married": (-14.064443993691441, -18.895354832878184, -7.592831463997007, 0.009966777408637873),
        "final_trust": (-0.4153775147317861, -0.443844011534842, -0.3807821659464849, 0.006644518272425249),
        "mean_trust": (-0.3125340153436656, -0.33282315113133104, -0.284563209966171, 0.0033222591362126247),
        "conflict_rate": (4.333333333333333, 3.6245833333333333, 5.000000000000001, 0.0033222591362126247),
        "escalations_per_conflict": (
            -0.18678479143595422,
            -0.2508187760832989,
            -0.10376854962868735,
            0.0033222591362126247,
        ),
        "reconciliation_rate": (-0.19115296803652965, -0.25955663039477883, -0.125735656372465, 0.006644518272425249),
        "recovery_days": (-0.16338135674076903, -0.2576117694978373, -0.08359591267336977, 0.0033222591362126247),
        "remarriage_rate": (-0.12080334728033476, -0.1978788725499252, -0.04987183960781365, 0.009966777408637873),
    },
}


def _frame(design: str) -> pd.DataFrame:
    """A couple frame with every outcome, 120 couples, couple or block (10 per block) assignment."""
    rng = np.random.default_rng(2026)
    n = 120
    df = pd.DataFrame(index=pd.Index(range(n), name="couple_id"))
    if design == "block":
        df["cluster"] = df.index // 10
        treated_blocks = rng.permutation(12)[:6]
        treated = np.isin(df["cluster"].to_numpy(), treated_blocks)
    else:
        df["cluster"] = df.index
        treated = np.zeros(n, dtype=bool)
        treated[rng.permutation(n)[:60]] = True
    df["arm"] = np.where(treated, "treatment", "control")
    lift = np.where(treated, 1.0, 0.0)
    df["divorce_rate"] = (rng.random(n) < 0.05 + 0.1 * lift).astype(float)
    df["separation_rate"] = (rng.random(n) < 0.2 + 0.3 * lift).astype(float)
    df["days_married"] = np.minimum(365.0, rng.normal(355.0 - 20.0 * lift, 15.0))
    df["final_trust"] = rng.normal(0.65 - 0.4 * lift, 0.1)
    df["mean_trust"] = rng.normal(0.64 - 0.3 * lift, 0.08)
    df["conflict_rate"] = rng.poisson(7.0 + 5.0 * lift).astype(float)
    for name in ("escalations_per_conflict", "reconciliation_rate", "recovery_days", "remarriage_rate"):
        den = rng.poisson(4.0, n).astype(float)
        df[f"{name}__num"] = rng.binomial(den.astype(int), 0.5 - 0.2 * lift).astype(float)
        df[f"{name}__den"] = den
    return df


@pytest.mark.parametrize("design", ["couple", "block"])
def test_couple_and_block_analysis_is_unchanged(design: str) -> None:
    settings = AnalysisSettings(n_boot=300, n_perm=300, seed=5)
    for rows in (outcomes_table(_frame(design), settings, design), outcomes_table(_frame(design), settings)):
        got = {r["name"]: (r["ate"], r["ci_low"], r["ci_high"], r["p_permutation"]) for r in rows}
        assert set(got) == set(GOLDEN[design])
        for name, want in GOLDEN[design].items():
            assert got[name] == pytest.approx(want, rel=1e-9, abs=1e-12), name
        notes = {r["name"]: r["note"] for r in rows}
        assert notes["recovery_days"].endswith("cluster bootstrap over couples).")


def _pairs(m: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Pair ids 0..m-1 twice over, and one treated member per pair chosen by a coin."""
    pair = np.repeat(np.arange(m), 2)
    first = rng.random(m) < 0.5
    treated = np.empty(2 * m, dtype=bool)
    treated[0::2], treated[1::2] = first, ~first
    return pair, treated


def test_the_paired_estimate_is_the_difference_in_means() -> None:
    rng = np.random.default_rng(1)
    pair, treated = _pairs(200, rng)
    level = np.repeat(rng.normal(0.0, 3.0, 200), 2)
    y = level + rng.normal(0.0, 0.5, 400) + np.where(treated, 0.4, 0.0)
    e = estimate_paired_effect(y, np.ones(400), treated, pair, np.random.default_rng(2), 800, 800)
    assert e.ate == pytest.approx(y[treated].mean() - y[~treated].mean())
    assert e.n_treatment == 200 and e.n_control == 200
    assert e.ci_low < 0.4 < e.ci_high and e.ci_low > 0.0
    assert e.p_permutation < 0.01
    # The pairs absorb the large between-pair spread that the two-sample bootstrap has to carry.
    two_sample = estimate_effect(y, np.ones(400), treated, np.random.default_rng(2), 800, 0)
    assert (e.ci_high - e.ci_low) < 0.5 * (two_sample.ci_high - two_sample.ci_low)


def test_pairs_resample_and_flip_as_units() -> None:
    # Identical couples inside every pair: no flip and no resample of whole pairs can open a gap.
    rng = np.random.default_rng(3)
    pair, treated = _pairs(50, rng)
    y = np.repeat(rng.normal(0.0, 1.0, 50), 2)
    e = estimate_paired_effect(y, np.ones(100), treated, pair, np.random.default_rng(4), 300, 300)
    assert e.ate == pytest.approx(0.0, abs=1e-12)
    assert e.ci_low == pytest.approx(0.0, abs=1e-12) and e.ci_high == pytest.approx(0.0, abs=1e-12)
    assert e.p_permutation == 1.0
    # The same effect in every pair: every resample of whole pairs returns it.
    y2 = y + np.where(treated, 0.25, 0.0)
    e2 = estimate_paired_effect(y2, np.ones(100), treated, pair, np.random.default_rng(4), 300, 300)
    assert e2.ci_low == pytest.approx(0.25) and e2.ci_high == pytest.approx(0.25)
    assert e2.p_permutation < 0.01


def test_a_couple_alone_is_resampled_and_flipped_on_its_own() -> None:
    pair = np.array([0, 0, 1, 1, 2])
    treated = np.array([True, False, False, True, True])
    y = np.array([1.0, 0.0, 0.0, 1.0, 5.0])
    e = estimate_paired_effect(y, np.ones(5), treated, pair, np.random.default_rng(0), 400, 400)
    assert e.n_treatment == 3 and e.n_control == 2
    assert e.ate == pytest.approx((1.0 + 1.0 + 5.0) / 3 - 0.0)
    # Flipping the lone couple into control is one of the relabellings, so some flips beat nothing.
    assert 0.0 < e.p_permutation <= 1.0
    with pytest.raises(ValueError, match="one treated and one control"):
        estimate_paired_effect(
            y, np.ones(5), np.array([True, True, False, True, True]), pair, np.random.default_rng(0), 10, 10
        )


def test_paired_settings_are_checked() -> None:
    pair, treated = _pairs(5, np.random.default_rng(0))
    with pytest.raises(ValueError):
        estimate_paired_effect(np.ones(10), np.ones(10), treated, pair, np.random.default_rng(0), 10, 10, ci_level=1.0)
    with pytest.raises(ValueError):
        estimate_paired_effect(np.ones(10), np.ones(10), treated, pair, np.random.default_rng(0), -1, 10)


def _run(defaults: dict, tmp_path: Path, name: str, engine: dict, n: int = 200, days: int = 40) -> Path:
    raw = {
        "name": name,
        "n_couples": n,
        "days": days,
        "treatment": {"conflict_half_life_days": 90.0},
        "engine": engine,
        "analysis": {"n_boot": 200, "n_perm": 200},
    }
    exp = parse_experiment(raw, defaults)
    out = tmp_path / name
    eng.run_engine(build_engine_config(exp, defaults), out, overwrite=True)
    analysis.write_summary(out, exp.analysis)
    return out


def test_a_pairs_run_is_analysed_by_its_pairs(defaults: dict, tmp_path: Path) -> None:
    out = _run(defaults, tmp_path, "paired", PAIRS)
    t = analysis.load_tables(out)
    assert t.design == "pairs"
    df = analysis.couple_frame(t)
    init = t.initial.set_index("couple_id").sort_index()
    assert (df["cluster"] == init["pair_id"]).all()
    assert (df.groupby("cluster")["arm"].nunique() == 2).all()
    s = json.loads((out / "summary.json").read_text())
    assert s["analysis"]["inference_unit"] == "pair of couples"
    assert s["analysis"]["n_clusters"] == 100
    assert s["analysis"]["design"].startswith("Matched pairs")
    assert s["experiment"]["assignment"]["mode"] == "pairs"
    rows = {o["name"]: o for o in s["outcomes"]}
    assert rows["mean_trust"]["ci_low"] < rows["mean_trust"]["ate"] < rows["mean_trust"]["ci_high"]
    assert rows["recovery_days"]["note"].endswith("cluster bootstrap over pairs).")
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["pairs"]["pair_id"] == init["pair_id"].astype(int).tolist()
    # The engine's pairs are neighbours in the risk score as Python computes it from the agents table.
    score = analysis.risk_scores(t.agents, manifest["pairs"]["weights"])
    spans = score.groupby(init["pair_id"]).agg(["min", "max"]).sort_index()
    assert (spans["max"].to_numpy()[:-1] <= spans["min"].to_numpy()[1:] + 1e-9).all()


def test_every_design_is_named_in_the_summary(defaults: dict, tmp_path: Path) -> None:
    couple = json.loads((_run(defaults, tmp_path, "by-couple", {}, n=40, days=20) / "summary.json").read_text())
    assert couple["analysis"]["design"].startswith("Couple randomisation")
    assert couple["analysis"]["inference_unit"] == "couple"
    block = _run(defaults, tmp_path, "by-block", {"assignment": {"mode": "block", "block_size": 10}}, n=40, days=20)
    s = json.loads((block / "summary.json").read_text())
    assert s["analysis"]["design"].startswith("Block randomisation: blocks of 10")
    assert "pairs" not in json.loads((block / "manifest.json").read_text())


def test_pairs_follow_the_population_and_coins_follow_the_assignment_seed(defaults: dict) -> None:
    exp = parse_experiment({"name": "seeds", "n_couples": 200, "days": 5, "engine": PAIRS}, defaults)
    cfg = build_engine_config(exp, defaults)
    arms = eng.assign(cfg)
    assert arms.count("treatment") == 100
    moved = json.loads(json.dumps(cfg))
    moved["seeds"]["dynamics"] = 999
    assert eng.assign(moved) == arms, "the dynamics seed never touches assignment"
    moved["seeds"]["assignment"] = 999
    assert eng.assign(moved) != arms
    moved = json.loads(json.dumps(cfg))
    moved["seeds"]["population"] = 999
    assert eng.assign(moved) != arms, "the population forms the pairs"


def test_pairs_mode_refuses_an_uneven_split(defaults: dict) -> None:
    exp = parse_experiment(
        {
            "name": "uneven",
            "n_couples": 20,
            "days": 5,
            "engine": {"assignment": {"mode": "pairs", "treatment_fraction": 0.3}},
        },
        defaults,
    )
    with pytest.raises(eng.EngineError, match="treatment_fraction must be 0.5"):
        eng.assign(build_engine_config(exp, defaults))


def test_a_pairs_run_without_its_pairs_is_refused(defaults: dict, tmp_path: Path) -> None:
    out = _run(defaults, tmp_path, "stripped", PAIRS, n=20, days=10)
    t = analysis.load_tables(out)
    t.couples = t.couples.drop(columns=["pair_id"])
    with pytest.raises(ValueError, match="pair_id"):
        analysis.couple_frame(t)
    assert not math.isnan(analysis.build_summary(analysis.load_tables(out))["outcomes"][0]["ate"])

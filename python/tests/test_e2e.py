from __future__ import annotations

import json
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from loveworld import analysis
from loveworld import engine as eng
from loveworld.experiment import ExperimentError, build_engine_config, load_experiment
from loveworld.schema import DISCLAIMER, EVENT_KINDS, OUTCOME_NAMES, STATES, TABLES

from .conftest import EXPERIMENTS

SUMMARY_KEYS = {
    "evidence_class",
    "disclaimer",
    "experiment",
    "analysis",
    "arms",
    "outcomes",
    "balance",
    "curves",
    "distributions",
    "governance",
}
OUTCOME_KEYS = {
    "name",
    "label",
    "unit",
    "type",
    "level",
    "n_control",
    "n_treatment",
    "control_mean",
    "treatment_mean",
    "ate",
    "ci_low",
    "ci_high",
    "ci_level",
    "ci_method",
    "n_boot",
    "p_permutation",
    "n_perm",
    "conditional_on_post_treatment",
    "note",
}


def test_tables_and_manifest_exist(smoke_results: Path) -> None:
    for name in TABLES:
        assert (smoke_results / f"{name}.parquet").exists(), name
    m = json.loads((smoke_results / "manifest.json").read_text())
    assert m["evidence_class"] == "simulation"
    assert {f"{n}.parquet" for n in TABLES} <= set(m["files"])
    for name in TABLES:
        assert pq.read_table(smoke_results / f"{name}.parquet").num_rows == m["files"][f"{name}.parquet"]["rows"]


def test_summary_matches_contract(smoke_results: Path) -> None:
    text = (smoke_results / "summary.json").read_text()
    assert "NaN" not in text and "Infinity" not in text
    s = json.loads(text)
    assert SUMMARY_KEYS <= set(s)
    assert s["evidence_class"] == "simulation"
    assert s["disclaimer"] == DISCLAIMER
    assert [o["name"] for o in s["outcomes"]] == list(OUTCOME_NAMES)
    for o in s["outcomes"]:
        assert OUTCOME_KEYS <= set(o), o["name"]
    assert s["experiment"]["treatment"]["parameter"] == "conflict_half_life_days"
    assert s["experiment"]["treatment"]["treatment_value"] == 90.0
    assert s["experiment"]["shocks"] == []
    assert s["analysis"]["inference_unit"] == "couple" and s["analysis"]["n_clusters"] == 40
    assert s["arms"]["control"]["couples"] + s["arms"]["treatment"]["couples"] == 40
    assert set(s["curves"]) == {"survival", "trust", "in_conflict", "neg_load"}
    assert len(s["curves"]["survival"]["day"]) == 60
    assert len(s["curves"]["trust"]["control_mean"]) == 60
    assert set(s["distributions"]) == {"recovery_days", "conflicts_per_couple"}
    assert s["governance"]["placebo"] is None
    assert s["governance"]["twins"] is not None and s["governance"]["twins"]["paired"][0]["name"] == "divorce_rate"
    for b in s["balance"]:
        assert b["unit"] == "couple" and b["n_control"] + b["n_treatment"] == 40
        assert b["smd"] is None or abs(b["smd"]) < 5


def test_event_kinds_and_states_are_known(smoke_results: Path) -> None:
    ev = pq.read_table(smoke_results / "events.parquet").to_pandas()
    assert set(ev["kind"].unique()) <= set(EVENT_KINDS) | {k for k in ev["kind"].unique() if k.startswith("shock_")}
    cp = pq.read_table(smoke_results / "couples.parquet").to_pandas()
    assert set(cp["final_state"].unique()) <= set(STATES)
    assert (cp[cp["origin"] == "initial"]["arm"].isin(["control", "treatment"])).all()


def test_replay_passes_and_hash_is_stable(smoke_results: Path, fresh_dir: Path, defaults: dict) -> None:
    assert eng.replay(smoke_results)
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    m2 = eng.run_engine(build_engine_config(exp, defaults), fresh_dir, overwrite=True)
    m1 = json.loads((smoke_results / "manifest.json").read_text())
    assert m1["determinism_hash"] == m2["determinism_hash"]


def test_analysis_is_deterministic(smoke_results: Path, defaults: dict) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    t = analysis.load_tables(smoke_results)
    a = analysis.build_summary(t, exp.analysis)
    b = analysis.build_summary(t, exp.analysis)
    assert a["outcomes"] == b["outcomes"]


def test_days_married_counts_the_terminal_day(smoke_results: Path) -> None:
    t = analysis.load_tables(smoke_results)
    df = analysis.couple_frame(t)
    init = t.initial.set_index("couple_id")
    for cid, row in df.iterrows():
        if init.loc[cid, "final_state"] == "divorced":
            assert row["days_married"] == min(float(init.loc[cid, "ended_day"]) + 1.0, float(t.days))
        else:
            assert row["days_married"] == float(t.days)


def test_experiment_config_changes_only_the_named_parameter(defaults: dict) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    cfg = build_engine_config(exp, defaults)
    c, t = cfg["memory"]["control"], cfg["memory"]["treatment"]
    assert t["conflict_half_life_days"] == 90.0
    key = "conflict_half_life_days"
    assert {k: v for k, v in t.items() if k != key} == {k: v for k, v in c.items() if k != key}
    assert cfg["n_couples"] == 40 and cfg["days"] == 60
    placebo = build_engine_config(exp, defaults, placebo=True)
    assert placebo["memory"]["treatment"] == placebo["memory"]["control"]
    assert placebo["name"].endswith("-placebo")


def test_unknown_memory_parameter_is_rejected(tmp_path: Path, defaults: dict) -> None:
    p = tmp_path / "bad.yaml"
    p.write_text("name: bad\ntreatment:\n  bogus: 1\n")
    with pytest.raises(ExperimentError):
        load_experiment(p, defaults)

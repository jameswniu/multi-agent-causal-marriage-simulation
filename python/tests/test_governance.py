from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from loveworld import analysis
from loveworld import engine as eng
from loveworld.experiment import AnalysisSettings, build_engine_config, parse_experiment

from .conftest import REPO


def _exp(name: str, n: int, days: int, defaults: dict, **over: object) -> object:
    raw: dict = {
        "name": name,
        "n_couples": n,
        "days": days,
        "seeds": {"population": 11, "assignment": 22, "dynamics": 33},
    }
    raw.update(over)
    return parse_experiment(raw, defaults)


UNCONDITIONAL = ("divorce_rate", "separation_rate", "days_married", "final_trust", "mean_trust", "conflict_rate")


def test_placebo_effect_is_null_with_finite_statistics(defaults: dict, tmp_path: Path) -> None:
    exp = _exp("placebo-check", 300, 120, defaults, treatment={"conflict_half_life_days": 90.0})
    cfg = build_engine_config(exp, defaults, placebo=True)
    assert cfg["memory"]["treatment"] == cfg["memory"]["control"]
    out = tmp_path / "placebo"
    eng.run_engine(cfg, out, overwrite=True)
    s = analysis.write_summary(out, AnalysisSettings(n_boot=300, n_perm=300, seed=1))
    by_name = {o["name"]: o for o in s["outcomes"]}
    covering = 0
    for name in UNCONDITIONAL:
        o = by_name[name]
        for key in ("control_mean", "treatment_mean", "ate", "ci_low", "ci_high", "p_permutation"):
            assert o[key] is not None, (name, key)
            assert isinstance(o[key], float) and o[key] == o[key], (name, key)
        covering += int(o["ci_low"] <= 0.0 <= o["ci_high"])
        # Under the null, p is uniform; a family of six should never produce a tiny p.
        assert o["p_permutation"] > 0.005, name
    assert covering >= len(UNCONDITIONAL) - 1, {n: (by_name[n]["ci_low"], by_name[n]["ci_high"]) for n in UNCONDITIONAL}


def test_placebo_twins_share_every_label_free_table(defaults: dict, tmp_path: Path) -> None:
    exp = _exp("twins-placebo", 30, 40, defaults, treatment={"conflict_half_life_days": 90.0})
    cfg = build_engine_config(exp, defaults, placebo=True)
    manifests = {}
    for arm in ("control", "treatment"):
        manifests[arm] = eng.run_engine(cfg, tmp_path / arm, overwrite=True, arm_override=arm)
    for name in ("events", "daily", "decisions", "conflicts"):
        a = manifests["control"]["files"][f"{name}.parquet"]["sha256"]
        b = manifests["treatment"]["files"][f"{name}.parquet"]["sha256"]
        assert a == b, name
    tc = analysis.load_tables(tmp_path / "control")
    tt = analysis.load_tables(tmp_path / "treatment")
    assert tc.agents.drop(columns=["arm"]).equals(tt.agents.drop(columns=["arm"]))
    assert tc.couples.drop(columns=["arm"]).equals(tt.couples.drop(columns=["arm"]))
    s = analysis.twins_summary(tmp_path, AnalysisSettings(n_boot=50, seed=1))
    assert s["identical_parameters"] is True and s["dynamics_hashes_equal"] is True
    assert all(p["mean_diff"] == 0.0 for p in s["paired"])


def test_real_twins_differ_only_through_the_intervention(defaults: dict, tmp_path: Path) -> None:
    exp = _exp("twins-real", 30, 40, defaults, treatment={"conflict_half_life_days": 90.0})
    cfg = build_engine_config(exp, defaults)
    for arm in ("control", "treatment"):
        eng.run_engine(cfg, tmp_path / arm, overwrite=True, arm_override=arm, name=f"twins-real-twins-{arm}")
    tc = analysis.load_tables(tmp_path / "control")
    tt = analysis.load_tables(tmp_path / "treatment")
    post = {
        "arm",
        "conflict_half_life_days",
        "repair_half_life_days",
        "positive_half_life_days",
        "load_saturation",
        "divorces_in_sim",
        "marriages_in_sim",
        "final_trust",
        "final_memory_size",
    }
    cols = [c for c in tc.agents.columns if c not in post]
    assert tc.agents[cols].equals(tt.agents[cols])
    assert (tc.agents["conflict_half_life_days"] != tt.agents["conflict_half_life_days"]).all()
    s = analysis.twins_summary(tmp_path, AnalysisSettings(n_boot=50, seed=1))
    assert s["identical_parameters"] is False
    assert s["experiment"]["name"] == "twins-real"


def test_assignment_is_balanced_and_independent_of_population(defaults: dict, tmp_path: Path) -> None:
    exp = _exp("balance", 400, 5, defaults, treatment={"conflict_half_life_days": 90.0})
    cfg = build_engine_config(exp, defaults)
    arms = eng.assign(cfg)
    assert arms.count("treatment") == 200 and arms.count("control") == 200
    cfg2 = json.loads(json.dumps(cfg))
    cfg2["seeds"]["population"] = 999
    cfg2["seeds"]["dynamics"] = 999
    assert eng.assign(cfg2) == arms
    cfg3 = json.loads(json.dumps(cfg))
    cfg3["seeds"]["assignment"] = 999
    assert eng.assign(cfg3) != arms
    out = tmp_path / "balance"
    eng.run_engine(cfg, out, overwrite=True)
    s = analysis.write_summary(out, AnalysisSettings(n_boot=10, n_perm=10, seed=1))
    assert len(s["balance"]) >= 10
    for b in s["balance"]:
        assert b["unit"] == "couple" and b["n_control"] == 200 and b["n_treatment"] == 200
    assert max(abs(b["smd"]) for b in s["balance"]) < 0.25, s["balance"]


def test_block_randomisation_uses_block_level_inference(defaults: dict, tmp_path: Path) -> None:
    exp = _exp(
        "blocks",
        200,
        30,
        defaults,
        treatment={"conflict_half_life_days": 90.0},
        engine={"assignment": {"mode": "block", "block_size": 10}},
    )
    cfg = build_engine_config(exp, defaults)
    arms = eng.assign(cfg)
    for b in range(20):
        assert len(set(arms[b * 10 : (b + 1) * 10])) == 1
    out = tmp_path / "blocks"
    eng.run_engine(cfg, out, overwrite=True)
    s = analysis.write_summary(out, AnalysisSettings(n_boot=100, n_perm=100, seed=1))
    assert s["analysis"]["inference_unit"] == "block of 10 couples" and s["analysis"]["n_clusters"] == 20
    by_name = {o["name"]: o for o in s["outcomes"]}
    assert by_name["mean_trust"]["ate"] is not None and by_name["mean_trust"]["ci_low"] is not None
    assert by_name["mean_trust"]["n_control"] == 100 and by_name["mean_trust"]["n_treatment"] == 100
    t = analysis.load_tables(out)
    df = analysis.couple_frame(t)
    assert (df["cluster"] == df.index // 10).all()


def test_balance_smd_is_null_when_an_arm_is_empty(smoke_results: Path) -> None:
    t = analysis.load_tables(smoke_results)
    rows = analysis.balance_table(t.agents[t.agents["arm"] == "control"])
    assert rows and all(r["smd"] is None and r["treatment_mean"] is None and r["n_treatment"] == 0 for r in rows)


def test_governance_linking_is_deterministic_and_verified(tmp_path: Path) -> None:
    root = tmp_path / "results"
    (root / "exp").mkdir(parents=True)
    exp_block = {"name": "exp", "seeds": {"population": 1, "assignment": 2, "dynamics": 3}, "days": 10, "n_couples": 5}
    summary = {"experiment": exp_block, "governance": {"placebo": None, "twins": None}}
    # A sibling with the right name but a different seed must not link.
    decoy = root / "exp-placebo"
    decoy.mkdir()
    wrong = {
        "experiment": {**exp_block, "name": "exp-placebo", "seeds": {"population": 9, "assignment": 2, "dynamics": 3}},
        "outcomes": [1],
    }
    (decoy / "summary.json").write_text(json.dumps(wrong))
    out = analysis.link_governance(root / "exp", json.loads(json.dumps(summary)))
    assert out["governance"]["placebo"] is None
    # The matching sibling links, and the result does not depend on directory listing order.
    right = {"experiment": {**exp_block, "name": "exp-placebo"}, "outcomes": [{"name": "divorce_rate"}]}
    (decoy / "summary.json").write_text(json.dumps(right))
    twins = root / "exp-twins"
    twins.mkdir()
    (twins / "summary.json").write_text(json.dumps({"experiment": exp_block, "paired": [{"name": "divorce_rate"}]}))
    a = analysis.link_governance(root / "exp", json.loads(json.dumps(summary)))
    b = analysis.link_governance(root / "exp", json.loads(json.dumps(summary)))
    assert a == b
    assert a["governance"]["placebo"]["outcomes"] == [{"name": "divorce_rate"}]
    assert a["governance"]["twins"]["paired"] == [{"name": "divorce_rate"}]
    # A twins sibling whose run length differs is ignored.
    (twins / "summary.json").write_text(
        json.dumps({"experiment": {**exp_block, "days": 11}, "paired": [{"name": "x"}]})
    )
    c = analysis.link_governance(root / "exp", json.loads(json.dumps(summary)))
    assert c["governance"]["twins"] is None


def test_sanitize_and_nan_free_json(tmp_path: Path) -> None:
    payload = {"a": float("nan"), "b": [1.0, float("inf"), {"c": float("-inf")}], "d": 2}
    out = analysis.write_json(tmp_path / "x.json", payload)
    assert out == {"a": None, "b": [1.0, None, {"c": None}], "d": 2}
    assert "NaN" not in (tmp_path / "x.json").read_text()


def test_interventions_are_logged_for_every_initial_agent(smoke_results: Path) -> None:
    t = analysis.load_tables(smoke_results)
    n_agents = len(t.agents)
    per_agent = t.interventions.groupby("agent_id").size()
    assert len(per_agent) == n_agents
    assert (per_agent == per_agent.iloc[0]).all()
    treated = t.interventions[
        (t.interventions["arm"] == "treatment") & (t.interventions["parameter"] == "conflict_half_life_days")
    ]
    assert (treated["applied_value"] == 90.0).all()
    assert (treated["control_value"] == t.config["memory"]["control"]["conflict_half_life_days"]).all()


@pytest.mark.parametrize("src", ["engine/src/policy.rs", "engine/src/dynamics.rs"])
def test_policy_and_dynamics_never_see_the_arm(src: str) -> None:
    text = (REPO / src).read_text()
    assert not re.search(r"\bArm\b", text), f"{src} references the Arm type"
    assert "arm_override" not in text

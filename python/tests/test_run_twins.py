"""Every run and fork started from the app also runs its twins: each couple under both arms on the same seeds.

The twins go through the same queued job as the run, so the run cap and the public rules cover them, and
the World page's "Same couples, both arms" view works for every run. A run with no intervention has
identical arms, so its twins never differ.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from loveworld import analysis, public, runner, translate
from loveworld.api import create_app
from loveworld.experiment import load_experiment

from .conftest import EXPERIMENTS
from .test_translate import JOB_ANSWER, FakeClient

NO_INTERVENTION = {
    "name": "same-rules",
    "n_couples": 1000,
    "days": 60,
    "control": {"conflict_half_life_days": 14},
    "treatment": {"conflict_half_life_days": 14},
    "analysis": {"n_boot": 50, "n_perm": 50},
}


def _client(root: Path) -> TestClient:
    return TestClient(create_app(root, frontend_dist=root / "no-dist"))


def test_a_run_with_no_intervention_brings_twins_where_no_couple_differs(tmp_path: Path, engine_ready: None) -> None:
    c = _client(tmp_path)
    r = c.post("/api/experiments/run?wait=true", json=NO_INTERVENTION)
    assert r.status_code == 200, r.text
    assert (tmp_path / "same-rules-twins" / "control" / "manifest.json").is_file()
    w = c.get("/api/twins/world", params={"experiment": "same-rules"}).json()
    assert w["available"] is True and w["path"] == "same-rules-twins"
    assert len(w["couples"]) == 1000 and w["days"] == 60
    assert w["diverged"] == [0] * 60
    assert w["states_control"] == w["states_treatment"]
    # The twins ran first, so the run's own summary links them, and says the arms were identical.
    twins = c.get("/api/experiment", params={"experiment": "same-rules"}).json()["summary"]["governance"]["twins"]
    assert twins["path"] == "same-rules-twins" and twins["identical_parameters"] is True
    assert twins["dynamics_hashes_equal"] is True
    for row in twins["paired"]:
        assert row["mean_diff"] == 0.0 and row["share_changed"] == 0.0 and row["n_pairs"] == 1000, row
    # Siblings are attached to their run, never listed as worlds of their own.
    assert [i["name"] for i in c.get("/api/experiments").json()["items"]] == ["same-rules"]


def test_a_fork_brings_its_own_twins(tmp_path: Path, defaults: dict) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    c = _client(tmp_path)
    shock = {"kind": "job_loss", "target": "treatment", "start_day": 5, "end_day": 40, "magnitude": 2.0}
    r = c.post("/api/experiments/fork?wait=true", json={"parent": "smoke", "name": "smoke-jolt", "shocks": [shock]})
    assert r.status_code == 200, r.text
    w = c.get("/api/twins/world", params={"experiment": "smoke-jolt"}).json()
    assert w["available"] is True and w["path"] == "smoke-jolt-twins" and len(w["couples"]) == 40
    # The twins carry the fork's own config: the parent's settings plus the appended shock.
    cfg = json.loads((tmp_path / "smoke-jolt-twins" / "treatment" / "config.json").read_text())
    parent = json.loads((tmp_path / "smoke" / "config.json").read_text())
    assert cfg["shocks"][-1]["kind"] == "job_loss" and cfg["memory"] == parent["memory"]
    assert not (tmp_path / "smoke-twins").exists()


def _hashes(root: Path, name: str) -> tuple[str, str, str]:
    """The determinism hashes of a run and its two twins, to tell whether anything was replaced."""

    def h(path: Path) -> str:
        return str(json.loads(path.read_text())["determinism_hash"])

    return (
        h(root / name / "manifest.json"),
        h(root / f"{name}-twins" / "control" / "manifest.json"),
        h(root / f"{name}-twins" / "treatment" / "manifest.json"),
    )


def test_a_run_that_fails_publishes_neither_it_nor_its_twins(
    tmp_path: Path, engine_ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("the analysis broke")

    monkeypatch.setattr(analysis, "write_summary", broken)
    c = _client(tmp_path)
    r = c.post("/api/experiments/run?wait=true", json={**NO_INTERVENTION, "n_couples": 20})
    assert r.status_code == 500 and "the analysis broke" in r.json()["detail"]
    assert sorted(p.name for p in tmp_path.iterdir()) == []


def test_a_failed_overwrite_keeps_the_earlier_run_and_its_own_twins(
    tmp_path: Path, engine_ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    c = _client(tmp_path)
    body = {**NO_INTERVENTION, "n_couples": 20}
    assert c.post("/api/experiments/run?wait=true", json=body).status_code == 200
    before = _hashes(tmp_path, "same-rules")
    changed = {**body, "treatment": {"conflict_half_life_days": 60}, "overwrite": True}

    def broken(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("the analysis broke")

    with monkeypatch.context() as m:
        m.setattr(analysis, "write_summary", broken)
        r = c.post("/api/experiments/run?wait=true", json=changed)
    assert r.status_code == 500
    assert _hashes(tmp_path, "same-rules") == before

    # A run that cannot be put in place after its twins were takes them out again and puts the earlier ones back.
    real = runner._swap_in

    def refuse(tmp: Path, target: Path) -> None:
        if target.name == "same-rules":
            raise OSError("the disk refused the rename")
        real(tmp, target)

    with monkeypatch.context() as m:
        m.setattr(runner, "_swap_in", refuse)
        r = c.post("/api/experiments/run?wait=true", json=changed)
    assert r.status_code == 500 and "refused the rename" in r.json()["detail"]
    assert _hashes(tmp_path, "same-rules") == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["same-rules", "same-rules-twins"]
    # And once nothing fails, the overwrite replaces both.
    assert c.post("/api/experiments/run?wait=true", json=changed).status_code == 200
    after = _hashes(tmp_path, "same-rules")
    assert after[0] != before[0] and after[1:] != before[1:]


def test_existing_twins_are_replaced_only_with_overwrite(tmp_path: Path, engine_ready: None) -> None:
    c = _client(tmp_path)
    body = {**NO_INTERVENTION, "n_couples": 20}
    (tmp_path / "same-rules-twins").mkdir()
    (tmp_path / "same-rules-twins" / "note.txt").write_text("someone else's")
    r = c.post("/api/experiments/run?wait=true", json=body)
    assert r.status_code == 409 and "same-rules-twins exists" in r.json()["detail"]
    assert (tmp_path / "same-rules-twins" / "note.txt").exists()
    assert c.post("/api/experiments/run?wait=true", json={**body, "name": "other"}).status_code == 200
    again = c.post("/api/experiments/run?wait=true", json={**body, "name": "other", "overwrite": True})
    assert again.status_code == 200, again.text
    assert c.get("/api/twins/world", params={"experiment": "other"}).json()["available"] is True


def _public_app(root: Path) -> Any:
    cfg = public.PublicConfig(enabled=True, session_secret="test-secret")
    fake = FakeClient({"job": JOB_ANSWER})
    return create_app(root, frontend_dist=root / "no-dist", public=cfg, translator=translate.Translator(lambda: fake))


def test_a_visitors_run_brings_twins_only_that_visitor_sees_and_the_sweeper_takes_both(
    tmp_path: Path, defaults: dict
) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    app = _public_app(tmp_path)
    alice, bob = TestClient(app), TestClient(app)
    alice.get("/api/health")
    bob.get("/api/health")
    body = {"n_couples": 20, "days": 20, "treatment": {"conflict_half_life_days": 60}}
    mine = alice.post("/api/experiments/run?wait=true", json=body).json()["name"]
    assert (tmp_path / f"{mine}-twins" / "treatment" / "manifest.json").is_file()
    assert alice.get("/api/twins/world", params={"experiment": mine}).json()["available"] is True
    assert bob.get("/api/twins/world", params={"experiment": mine}).status_code == 404
    # A day later the run and its twins leave together; the curated world's siblings stay.
    later = time.time() + 25 * 3600
    removed = public.sweep(tmp_path, 24, now=later, keep={"smoke"})
    assert sorted(removed) == sorted([mine, f"{mine}-twins"])
    assert (tmp_path / "smoke").exists()


def test_the_sweeper_ages_a_sibling_with_its_run_and_never_touches_a_curated_ones(tmp_path: Path) -> None:
    sid = "abcdef012345"
    young = tmp_path / f"v-{sid}-20260102-000000"
    curated = tmp_path / f"v-{sid}-20250101-000000"
    for d, age in ((young, 60), (curated, 9 * 86400)):
        d.mkdir()
        (d / "manifest.json").write_text(json.dumps({"generated_at_unix": time.time() - age}))
        twins = Path(f"{d}-twins")
        (twins / "control").mkdir(parents=True)
        # The twins' own stamp is old, but they belong to a run that is not.
        (twins / "control" / "manifest.json").write_text(json.dumps({"generated_at_unix": time.time() - 9 * 86400}))
    orphan = tmp_path / f"v-{sid}-20260101-000000-twins"
    (orphan / "control").mkdir(parents=True)
    (orphan / "control" / "manifest.json").write_text(json.dumps({"generated_at_unix": time.time() - 2 * 86400}))
    removed = public.sweep(tmp_path, 24, keep={curated.name})
    assert removed == [orphan.name]
    assert Path(f"{young}-twins").exists() and Path(f"{curated}-twins").exists()

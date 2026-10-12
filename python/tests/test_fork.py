"""Forked worlds: same couples and seeds as the parent, only appended shocks, compared couple by couple."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from loveworld import forking, runner
from loveworld.api import create_app
from loveworld.experiment import ExperimentError, load_experiment

from .conftest import EXPERIMENTS


@pytest.fixture
def root(tmp_path: Path, defaults: dict) -> Path:
    """A results root holding only the smoke experiment, so forks never disturb shared fixtures."""
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    return tmp_path


def _client(root: Path) -> TestClient:
    return TestClient(create_app(root, frontend_dist=root / "no-dist"))


def _job_loss(magnitude: float, target: str = "all", member: str = "random") -> dict[str, Any]:
    return {
        "kind": "job_loss",
        "target": target,
        "member": member,
        "start_day": 5,
        "end_day": 40,
        "magnitude": magnitude,
    }


def test_a_zero_magnitude_fork_differs_from_its_parent_in_nothing(root: Path) -> None:
    c = _client(root)
    r = c.post("/api/experiments/fork?wait=true", json={"parent": "smoke", "name": "calm", "shocks": [_job_loss(0.0)]})
    assert r.status_code == 200, r.text
    record = json.loads((root / "calm" / "parent.json").read_text())
    parent_manifest = json.loads((root / "smoke" / "manifest.json").read_text())
    assert record["parent"] == "smoke"
    assert record["parent_determinism_hash"] == parent_manifest["determinism_hash"]
    assert record["parent_engine_version"] == parent_manifest["engine_version"]
    comparison = record["comparison"]
    assert comparison["comparable"] is True and comparison["n_couples"] == 40
    for arm, rows in comparison["arms"].items():
        assert rows, arm
        for row in rows:
            assert row["mean_diff"] == 0.0 and row["share_changed"] == 0.0, (arm, row)
    # Everything but the name and the appended shock is the parent's own config.
    parent_cfg = json.loads((root / "smoke" / "config.json").read_text())
    child_cfg = json.loads((root / "calm" / "config.json").read_text())
    assert child_cfg["shocks"][-1]["magnitude"] == 0.0 and len(child_cfg["shocks"]) == len(parent_cfg["shocks"]) + 1
    for key in set(parent_cfg) - {"name", "shocks"}:
        assert child_cfg[key] == parent_cfg[key], key
    shown = c.get("/api/experiment", params={"experiment": "calm"}).json()
    assert shown["parent"]["parent"] == "smoke"
    listed = {i["name"]: i for i in c.get("/api/experiments").json()["items"]}
    assert listed["calm"]["parent"] == "smoke" and listed["smoke"]["parent"] is None


def test_a_real_shock_shows_up_in_the_treated_arm(root: Path) -> None:
    c = _client(root)
    body = {"parent": "smoke", "name": "hard-times", "shocks": [_job_loss(3.0, target="treatment")]}
    r = c.post("/api/experiments/fork?wait=true", json=body)
    assert r.status_code == 200, r.text
    comparison = json.loads((root / "hard-times" / "parent.json").read_text())["comparison"]
    arms = comparison["arms"]
    assert [row["n_pairs"] for row in arms["all"]][0] == 40
    assert arms["control"][0]["n_pairs"] == 20 and arms["treatment"][0]["n_pairs"] == 20
    assert any(row["share_changed"] for row in arms["treatment"]), arms["treatment"]


def test_a_queued_fork_answers_at_once_and_reports_through_its_job(root: Path) -> None:
    c = _client(root)
    r = c.post("/api/experiments/fork", json={"parent": "smoke", "name": "later", "shocks": [_job_loss(1.0)]})
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["state"] in ("queued", "running") and job["kind"] == "fork" and job["name"] == "later"
    app_jobs = c.app.state.jobs  # type: ignore[attr-defined]
    app_jobs.wait(app_jobs.get(job["job_id"]), 120)
    done = c.get(f"/api/jobs/{job['job_id']}").json()
    assert done["state"] == "done" and done["error"] is None
    assert "later" in c.get("/api/health").json()["experiments"]


def test_a_fork_changes_nothing_but_shocks(root: Path) -> None:
    c = _client(root)
    cases: list[tuple[dict[str, Any], int, str]] = [
        ({"parent": "smoke", "shocks": [_job_loss(1.0)], "seeds": {"dynamics": 1}}, 400, "seeds"),
        ({"parent": "nope", "shocks": [_job_loss(1.0)]}, 404, "nope"),
        ({"parent": "../smoke", "shocks": [_job_loss(1.0)]}, 404, "smoke"),
        ({"parent": "smoke", "shocks": []}, 400, "at least one shock"),
        ({"parent": "smoke", "shocks": [{"kind": "job_loss"}]}, 400, "target"),
        ({"parent": "smoke", "shocks": [_job_loss(1.0, target="control")]}, 400, "target"),
        ({"parent": "smoke", "shocks": [_job_loss(99.0)]}, 400, "magnitude"),
        ({"parent": "smoke", "name": "smoke", "shocks": [_job_loss(1.0)]}, 400, "own"),
        ({"parent": "smoke", "name": "x-twins", "shocks": [_job_loss(1.0)]}, 400, "twins"),
        (
            {
                "parent": "smoke",
                "shocks": [_job_loss(1.0)],
                "translations": [{"translation_id": "t", "shock_index": 4}],
            },
            400,
            "shock_index",
        ),
    ]
    for body, code, needle in cases:
        r = c.post("/api/experiments/fork?wait=true", json=body)
        assert r.status_code == code, (body, r.text)
        assert needle in r.json()["detail"], (body, r.text)
    ok = c.post("/api/experiments/fork?wait=true", json={"parent": "smoke", "name": "once", "shocks": [_job_loss(1.0)]})
    assert ok.status_code == 200, ok.text
    again = c.post(
        "/api/experiments/fork?wait=true", json={"parent": "smoke", "name": "once", "shocks": [_job_loss(1.0)]}
    )
    assert again.status_code == 409


def test_the_comparison_refuses_a_parent_that_changed_or_a_different_engine(root: Path) -> None:
    plan = forking.plan_fork("smoke", root / "smoke", [_job_loss(0.0)], "child")
    runner.run_config(plan.config, root / "child", plan.settings)
    plan.parent_manifest = dict(plan.parent_manifest, determinism_hash="0" * 64)
    moved = forking.compare_with_parent(root / "child", plan)
    assert moved["comparable"] is False and "run again" in moved["reason"]

    old = root / "old-engine"
    shutil.copytree(root / "smoke", old)
    manifest = json.loads((old / "manifest.json").read_text())
    manifest["engine_version"] = "0.0.1"
    (old / "manifest.json").write_text(json.dumps(manifest))
    plan2 = forking.plan_fork("old-engine", old, [_job_loss(0.0)], "child2")
    runner.run_config(plan2.config, root / "child2", plan2.settings)
    versions = forking.compare_with_parent(root / "child2", plan2)
    assert versions["comparable"] is False and "0.0.1" in versions["reason"]


def test_plan_fork_rejects_a_twins_half(root: Path) -> None:
    half = root / "half"
    shutil.copytree(root / "smoke", half)
    cfg = json.loads((half / "config.json").read_text())
    cfg["arm_override"] = "treatment"
    (half / "config.json").write_text(json.dumps(cfg))
    with pytest.raises(ExperimentError, match="twins"):
        forking.plan_fork("half", half, [_job_loss(1.0)], "nope")

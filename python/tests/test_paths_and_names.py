"""What the server stores and serves names a run by its directory name, never by a path on the server.

Names are checked in full, so a name with a trailing newline is refused everywhere a name is read.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from loveworld import public as pubmod
from loveworld import runner
from loveworld.api import ExperimentStore, create_app, scrub_paths
from loveworld.experiment import ExperimentError, load_experiment, parse_experiment

from .conftest import EXPERIMENTS


def _no_server_path(payload: Any, root: Path) -> None:
    text = json.dumps(payload)
    assert str(root) not in text
    assert str(Path.home()) not in text


def _client(root: Path) -> TestClient:
    return TestClient(create_app(root, frontend_dist=root / "no-dist"))


def test_a_summary_links_its_siblings_by_name(smoke_results: Path, results_root: Path) -> None:
    summary = json.loads((smoke_results / "summary.json").read_text())
    assert summary["governance"]["twins"]["path"] == "smoke-twins"
    _no_server_path(summary, results_root)


def test_a_finished_fork_answers_with_its_name(tmp_path: Path, defaults: dict) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    shock = {"kind": "job_loss", "target": "all", "member": "random", "start_day": 5, "end_day": 40, "magnitude": 1.0}
    body = {"parent": "smoke", "name": "forked", "shocks": [shock]}
    r = _client(tmp_path).post("/api/experiments/fork?wait=true", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["dir"] == "forked"
    _no_server_path(r.json(), tmp_path)


def test_the_api_serves_directory_names_not_server_paths(results_root: Path) -> None:
    c = _client(results_root)
    items = c.get("/api/experiments").json()["items"]
    assert {i["name"]: i["dir"] for i in items}["smoke"] == "smoke"
    world = c.get("/api/twins/world", params={"experiment": "smoke"}).json()
    assert world["available"] is True and world["path"] == "smoke-twins"
    missing = c.get("/api/twins/world", params={"experiment": "zeta"}).json()
    assert missing["available"] is False and "zeta" in missing["reason"]
    for payload in (items, world, missing):
        _no_server_path(payload, results_root)


def test_a_failed_run_reports_no_server_path(tmp_path: Path, defaults: dict) -> None:
    root = tmp_path / "root"
    (root / "blocker").mkdir(parents=True)
    (root / "blocker" / "keep.txt").write_text("not a results directory")
    body = {"name": "blocker", "n_couples": 10, "days": 10, "overwrite": True, "analysis": {"n_boot": 20, "n_perm": 20}}
    r = _client(root).post("/api/experiments/run?wait=true", json=body)
    assert r.status_code == 409, r.text
    assert "blocker" in r.json()["detail"]
    _no_server_path(r.json(), root)


def test_scrub_paths_says_paths_relative_to_the_results_root_and_home_as_tilde(tmp_path: Path) -> None:
    root = tmp_path / "results"
    message = f"{root / 'api-run'} exists and is not a directory; see {Path.home() / 'notes'}"
    out = scrub_paths(message, root)
    assert out.startswith("api-run exists and is not a directory")
    assert str(Path.home()) not in out and "~/notes" in out
    assert scrub_paths(f"cannot write {root}", root) == "cannot write results"


def test_names_with_a_trailing_newline_are_refused_everywhere(results_root: Path, defaults: dict) -> None:
    with pytest.raises(ExperimentError):
        parse_experiment({"name": "smoke\n", "n_couples": 20, "days": 100}, defaults)
    store = ExperimentStore(results_root)
    assert store.dir_for("smoke") is not None and store.dir_for("smoke\n") is None
    c = _client(results_root)
    run = {"name": "fresh\n", "n_couples": 10, "days": 10}
    assert c.post("/api/experiments/run?wait=true", json=run).status_code == 400
    assert c.get("/api/experiment", params={"experiment": "smoke\n"}).status_code == 404
    fork = {"parent": "smoke", "name": "child\n", "shocks": [{"kind": "anniversary", "target": "all", "start_day": 3}]}
    assert c.post("/api/experiments/fork?wait=true", json=fork).status_code == 400
    sid = "0123456789ab"
    assert pubmod.owner_of(f"{pubmod.VISITOR_PREFIX}{sid}-20261011-120000") == sid
    assert pubmod.owner_of(f"{pubmod.VISITOR_PREFIX}{sid}-20261011-120000\n") is None

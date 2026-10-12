"""The run queue: one run at a time, a short line, plain answers when it is full or a run fails."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from loveworld import jobs, runner
from loveworld.api import create_app, job_error
from loveworld.experiment import load_experiment

from .conftest import EXPERIMENTS


def _blocker(gate: threading.Event, log: list[str], name: str) -> Any:
    def work() -> dict[str, Any]:
        gate.wait(30)
        log.append(name)
        return {"name": name, "dir": f"/tmp/{name}"}

    return work


def test_jobs_run_one_at_a_time_in_order_and_the_line_is_bounded() -> None:
    q = jobs.JobQueue(max_queued=3)
    gate, log = threading.Event(), []
    first = q.submit("run", "a", _blocker(gate, log, "a"))
    for _ in range(100):
        if q.describe(first)["state"] == "running":
            break
        threading.Event().wait(0.01)
    waiting = [q.submit("run", n, _blocker(gate, log, n)) for n in ("b", "c", "d")]
    assert [q.describe(j)["position"] for j in waiting] == [1, 2, 3]
    with pytest.raises(jobs.QueueFull, match="busy"):
        q.submit("run", "e", _blocker(gate, log, "e"))
    with pytest.raises(jobs.NameBusy):
        q.submit("run", "b", _blocker(gate, log, "b"))
    gate.set()
    for j in [first, *waiting]:
        assert q.wait(j, 30)["name"] == j.name
    assert log == ["a", "b", "c", "d"]
    assert q.describe(first)["state"] == "done" and q.describe(first)["position"] is None


def test_a_failed_job_reports_its_message_and_status() -> None:
    q = jobs.JobQueue(max_queued=2, error_mapper=job_error)

    def taken() -> dict[str, Any]:
        raise runner.TargetError("results/x is not empty")

    job = q.submit("run", "x", taken)
    with pytest.raises(jobs.JobFailed) as e:
        q.wait(job, 30)
    assert e.value.status_code == 409 and "not empty" in str(e.value)
    assert q.describe(job)["state"] == "failed" and "not empty" in q.describe(job)["error"]


def test_waiting_too_long_is_a_timeout_not_a_hang() -> None:
    q = jobs.JobQueue(max_queued=2)
    gate = threading.Event()
    job = q.submit("run", "slow", _blocker(gate, [], "slow"))
    with pytest.raises(jobs.JobFailed) as e:
        q.wait(job, 0.05)
    assert e.value.status_code == 504
    gate.set()
    q.wait(job, 30)


def test_the_api_queues_runs_and_answers_busy_when_the_line_is_full(tmp_path: Path, defaults: dict) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    q = jobs.JobQueue(max_queued=1, error_mapper=job_error)
    c = TestClient(create_app(tmp_path, frontend_dist=tmp_path / "no-dist", queue=q))
    body = {"name": "queued-run", "n_couples": 20, "days": 20, "analysis": {"n_boot": 20, "n_perm": 20}}
    accepted = c.post("/api/experiments/run", json=body)
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    q.wait(q.get(job_id), 120)
    assert c.get(f"/api/jobs/{job_id}").json()["state"] == "done"
    assert "queued-run" in c.get("/api/health").json()["experiments"]
    assert c.get("/api/jobs/not-a-job").status_code == 404

    gate = threading.Event()
    q.submit("run", "holder", _blocker(gate, [], "holder"))
    for _ in range(100):
        if not [j for j in q._jobs.values() if j.state == "queued"]:
            break
        threading.Event().wait(0.01)
    q.submit("run", "waiting", _blocker(gate, [], "waiting"))
    busy = c.post("/api/experiments/run", json=dict(body, name="one-too-many"))
    assert busy.status_code == 429 and "busy" in busy.json()["detail"]
    gate.set()

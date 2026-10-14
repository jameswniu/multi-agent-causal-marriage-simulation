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


def test_a_run_or_fork_sent_without_a_name_gets_one_of_its_own_and_a_typed_name_that_is_taken_is_a_409(
    tmp_path: Path, defaults: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loveworld import api

    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    # Every request below happens in the same second.
    monkeypatch.setattr(api, "utc_stamp", lambda: "20261014-121530")
    q = jobs.JobQueue(max_queued=3, error_mapper=job_error)
    c = TestClient(create_app(tmp_path, frontend_dist=tmp_path / "no-dist", queue=q))
    body = {"n_couples": 20, "days": 20, "analysis": {"n_boot": 20, "n_perm": 20}}

    # While the worker is held, two runs without a name wait in line, and the second takes the next free name.
    gate = threading.Event()
    holder = q.submit("run", "holder", _blocker(gate, [], "holder"))
    for _ in range(100):
        if q.describe(holder)["state"] == "running":
            break
        threading.Event().wait(0.01)
    first = c.post("/api/experiments/run", json=body)
    second = c.post("/api/experiments/run", json=dict(body, name=""))
    assert (first.status_code, second.status_code) == (202, 202), (first.text, second.text)
    assert [first.json()["name"], second.json()["name"]] == ["exp-20261014-121530", "exp-20261014-121530-2"]
    # A name the visitor typed is never changed: one already queued is a 409.
    queued = c.post("/api/experiments/run", json=dict(body, name="exp-20261014-121530"))
    assert queued.status_code == 409 and "already queued or running" in queued.json()["detail"]
    gate.set()
    for r in (first, second):
        q.wait(q.get(r.json()["job_id"]), 120)
    assert {"exp-20261014-121530", "exp-20261014-121530-2"} <= set(c.get("/api/health").json()["experiments"])

    # Once they are on disk, a typed name that exists is the clear 409, and the next run without a name is -3.
    taken = c.post("/api/experiments/run?wait=true", json=dict(body, name="exp-20261014-121530"))
    assert taken.status_code == 409 and "exists; set overwrite to replace it" in taken.json()["detail"]
    third = c.post("/api/experiments/run?wait=true", json=body)
    assert third.status_code == 200 and third.json()["name"] == "exp-20261014-121530-3"

    # Forks sent without a name are named after their parent and the time, and never share a name either.
    shock = {"kind": "job_loss", "target": "all", "member": "random", "start_day": 5, "end_day": 40, "magnitude": 1.0}
    fork = {"parent": "smoke", "shocks": [shock]}
    names = [c.post("/api/experiments/fork?wait=true", json=fork).json()["name"] for _ in range(2)]
    assert names == ["smoke-fork-20261014-121530", "smoke-fork-20261014-121530-2"]
    typed = c.post("/api/experiments/fork?wait=true", json=dict(fork, name="smoke-fork-20261014-121530"))
    assert typed.status_code == 409 and "exists; pick another name" in typed.json()["detail"]


def test_a_lock_left_on_disk_is_a_409_for_a_typed_name_and_a_picked_name_steps_past_it(
    tmp_path: Path, defaults: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    from loveworld import api

    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    monkeypatch.setattr(api, "utc_stamp", lambda: "20261014-121530")
    q = jobs.JobQueue(max_queued=3, error_mapper=job_error)
    c = TestClient(create_app(tmp_path, frontend_dist=tmp_path / "no-dist", queue=q))
    body = {"n_couples": 20, "days": 20, "analysis": {"n_boot": 20, "n_perm": 20}}
    shock = {"kind": "job_loss", "target": "all", "member": "random", "start_day": 5, "end_day": 40, "magnitude": 1.0}
    fork = {"parent": "smoke", "name": "left-locked", "shocks": [shock]}
    # A run that stopped while publishing leaves its lock, or its twins' lock, behind. A typed name with one is a
    # 409 at once, overwrite or not, and nothing is queued for it.
    for lock in (".left-locked.lock", ".left-locked-twins.lock"):
        (tmp_path / lock).write_text("12345")
        run = dict(body, name="left-locked", overwrite=True)
        for path, sent in (("/api/experiments/run", run), ("/api/experiments/fork", fork)):
            r = c.post(path, json=sent)
            assert r.status_code == 409, r.text
            assert r.json()["detail"] == f"{lock} exists: another run is publishing this target (remove it if stale)"
        (tmp_path / lock).unlink()
    assert q._jobs == {}
    done = c.post("/api/experiments/run?wait=true", json=dict(body, name="left-locked"))
    assert done.status_code == 200 and done.json()["name"] == "left-locked"
    # A name the server picks steps past a name with either lock on disk.
    (tmp_path / ".exp-20261014-121530-twins.lock").write_text("12345")
    (tmp_path / ".exp-20261014-121530-2.lock").write_text("12345")
    picked = c.post("/api/experiments/run?wait=true", json=body)
    assert picked.status_code == 200 and picked.json()["name"] == "exp-20261014-121530-3"


def test_a_default_name_skips_every_name_a_run_could_not_take() -> None:
    from loveworld.api import default_name

    taken = {"exp-1", "exp-1-2", "exp-1-3"}
    assert default_name("exp-1", taken.__contains__) == "exp-1-4"
    assert default_name("exp-2", taken.__contains__) == "exp-2"

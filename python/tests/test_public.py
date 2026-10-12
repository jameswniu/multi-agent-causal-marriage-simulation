"""Public mode: curated worlds stay read-only, visitors get their own namespace, runs and translations are capped."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from loveworld import jobs, public, runner, translate
from loveworld.api import create_app, job_error
from loveworld.experiment import load_experiment

from .conftest import EXPERIMENTS
from .test_translate import JOB_ANSWER, FakeClient


@pytest.fixture
def root(tmp_path: Path, defaults: dict) -> Path:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    runner.run_experiment(exp, tmp_path / exp.name)
    return tmp_path


def _app(root: Path, **overrides: Any) -> Any:
    q = overrides.pop("queue", None)
    cfg = public.PublicConfig(enabled=True, session_secret="test-secret", **overrides)
    fake = FakeClient({"job": JOB_ANSWER, "loses": JOB_ANSWER})
    return create_app(
        root, frontend_dist=root / "no-dist", public=cfg, translator=translate.Translator(lambda: fake), queue=q
    )


def _visitor(app: Any) -> TestClient:
    c = TestClient(app)
    c.get("/api/health")
    return c


def _sid(c: TestClient) -> str:
    sid = public.Sessions(b"test-secret").verify(c.cookies.get(public.SESSION_COOKIE))
    assert sid is not None
    return sid


RUN = {
    "n_couples": 20,
    "days": 20,
    "treatment": {"conflict_half_life_days": 60},
    "analysis": {"n_boot": 20, "n_perm": 20},
}


def test_health_says_public_and_lists_only_curated_worlds(root: Path) -> None:
    c = _visitor(_app(root))
    h = c.get("/api/health").json()
    assert h["public"] is True and h["limits"] == {"max_couples": 1000, "max_days": 365}
    assert h["experiments"] == ["smoke"]
    assert c.cookies.get(public.SESSION_COOKIE)


def test_a_public_run_may_change_only_shocks_and_the_treatment_half_life(root: Path) -> None:
    c = _visitor(_app(root))
    for extra, needle in (
        ({"engine": {"policy": {}}}, "engine"),
        ({"seeds": {"dynamics": 1}}, "seeds"),
        ({"control": {"conflict_half_life_days": 5}}, "control"),
        ({"overwrite": True}, "overwrite"),
        ({"treatment": {"repair_half_life_days": 5}}, "repair_half_life_days"),
        ({"n_couples": 1500}, "n_couples"),
        ({"days": 400}, "days"),
    ):
        r = c.post("/api/experiments/run?wait=true", json={**RUN, **extra})
        assert r.status_code == 400 and needle in r.json()["detail"], (extra, r.text)
    ok = c.post("/api/experiments/run?wait=true", json={**RUN, "name": "my-own-name"})
    assert ok.status_code == 200, ok.text
    name = ok.json()["name"]
    assert name != "my-own-name" and public.owner_of(name) == _sid(c)


def test_visitors_see_only_their_own_runs_and_the_curated_worlds(root: Path) -> None:
    app = _app(root)
    alice, bob = _visitor(app), _visitor(app)
    mine = alice.post("/api/experiments/run?wait=true", json=RUN).json()["name"]
    assert mine in alice.get("/api/health").json()["experiments"]
    assert [i["name"] for i in alice.get("/api/experiments").json()["items"]] == sorted(["smoke", mine])
    assert bob.get("/api/health").json()["experiments"] == ["smoke"]
    assert bob.get("/api/experiment", params={"experiment": mine}).status_code == 404
    assert bob.get("/api/world", params={"experiment": mine}).status_code == 404
    assert alice.get("/api/experiment", params={"experiment": mine}).status_code == 200
    fork = {"parent": mine, "shocks": [{"kind": "job_loss", "target": "all", "start_day": 2, "magnitude": 1.0}]}
    assert bob.post("/api/experiments/fork?wait=true", json=fork).status_code == 404
    curated = bob.post("/api/experiments/fork?wait=true", json=dict(fork, parent="smoke", name="smoke-2"))
    assert curated.status_code == 200, curated.text
    assert public.owner_of(curated.json()["name"]) == _sid(bob)
    assert json.loads((root / "smoke" / "manifest.json").read_text())["name"] == "smoke"


def test_a_forged_or_missing_cookie_gets_a_fresh_namespace(root: Path) -> None:
    app = _app(root)
    alice = _visitor(app)
    mine = alice.post("/api/experiments/run?wait=true", json=RUN).json()["name"]
    forged = f"{public.SESSION_COOKIE}={_sid(alice)}.{'0' * 32}"
    r = TestClient(app).get("/api/experiment", params={"experiment": mine}, headers={"Cookie": forged})
    assert r.status_code == 404
    issued = public.Sessions(b"test-secret").verify(r.cookies.get(public.SESSION_COOKIE))
    assert issued is not None and issued != _sid(alice)


def test_one_run_at_a_time_per_visitor(root: Path) -> None:
    q = jobs.JobQueue(max_queued=3, error_mapper=job_error)
    c = _visitor(_app(root, queue=q))
    gate = threading.Event()

    def hold() -> dict[str, Any]:
        gate.wait(30)
        return {"name": "held", "dir": str(root / "held")}

    q.submit("run", "held", hold, owner=_sid(c))
    r = c.post("/api/experiments/run", json=RUN)
    assert r.status_code == 429 and "already have a run" in r.json()["detail"]
    gate.set()


def test_translation_caps_count_model_calls_per_client_and_overall_and_survive_a_restart(root: Path) -> None:
    c = _visitor(_app(root, translate_per_ip_day=2, translate_global_day=100))
    texts = ["He loses his job in May", "She loses her job in June", "He loses his job in July"]
    assert c.post("/api/shocks/translate", json={"text": texts[0]}).status_code == 200
    assert c.post("/api/shocks/translate", json={"text": texts[0].upper()}).status_code == 200, (
        "a cached answer is free"
    )
    assert c.post("/api/shocks/translate", json={"text": texts[1]}).status_code == 200
    third = c.post("/api/shocks/translate", json={"text": texts[2]})
    assert third.status_code == 429 and "today's 2 translations" in third.json()["detail"]
    restarted = _visitor(_app(root, translate_per_ip_day=2, translate_global_day=100))
    assert restarted.post("/api/shocks/translate", json={"text": "He loses his job in August"}).status_code == 429
    counts = json.loads((root / public.PUBLIC_DIR / "counters.json").read_text())
    assert counts["global"] == 2 and all(len(k) == 16 for k in counts["per_ip"]), "addresses are stored hashed"

    overall = _visitor(_app(root, translate_per_ip_day=50, translate_global_day=2))
    r = overall.post("/api/shocks/translate", json={"text": "He loses his job in September"})
    assert r.status_code == 429 and "LoveWorld has used today's translations" in r.json()["detail"]


def test_with_an_edge_secret_every_post_comes_through_the_proxy(root: Path) -> None:
    app = _app(root, edge_secret="edge-123", translate_per_ip_day=1, translate_global_day=100)
    c = _visitor(app)
    direct = c.post("/api/shocks/translate", json={"text": "He loses his job"})
    assert direct.status_code == 403
    via = {public.EDGE_HEADER: "edge-123"}
    one = c.post(
        "/api/shocks/translate", json={"text": "He loses his job"}, headers={**via, public.CLIENT_IP_HEADER: "1.1.1.1"}
    )
    assert one.status_code == 200, one.text
    again = c.post(
        "/api/shocks/translate", json={"text": "She loses her job"}, headers={**via, public.CLIENT_IP_HEADER: "1.1.1.1"}
    )
    assert again.status_code == 429
    other = c.post(
        "/api/shocks/translate", json={"text": "She loses her job"}, headers={**via, public.CLIENT_IP_HEADER: "2.2.2.2"}
    )
    assert other.status_code == 200, "each reported client has its own cap"
    spoof = c.post(
        "/api/shocks/translate",
        json={"text": "They lose their jobs"},
        headers={public.EDGE_HEADER: "wrong", public.CLIENT_IP_HEADER: "3.3.3.3"},
    )
    assert spoof.status_code == 403
    assert c.get("/api/health").status_code == 200, "reads need no proxy header"


def test_the_sweeper_removes_old_visitor_runs_only(root: Path) -> None:
    sid = "abcdef012345"
    old = root / f"v-{sid}-20260101-000000"
    fresh = root / f"v-{sid}-20260102-000000"
    curated_lookalike = root / f"v-{sid}-20250101-000000"
    for d, age in ((old, 2 * 86400), (fresh, 60), (curated_lookalike, 9 * 86400)):
        d.mkdir()
        (d / "manifest.json").write_text(json.dumps({"generated_at_unix": time.time() - age}))
    removed = public.sweep(root, 24, keep={curated_lookalike.name})
    assert removed == [old.name]
    assert not old.exists() and fresh.exists() and curated_lookalike.exists() and (root / "smoke").exists()


def test_public_mode_needs_a_results_root(root: Path) -> None:
    with pytest.raises(ValueError, match="results root"):
        create_app(
            root / "smoke", frontend_dist=root / "no-dist", public=public.PublicConfig(enabled=True, session_secret="s")
        )


def test_the_signing_secret_is_created_once_with_owner_only_permissions(root: Path) -> None:
    app = create_app(root, frontend_dist=root / "no-dist", public=public.PublicConfig(enabled=True))
    path = root / public.PUBLIC_DIR / "secret"
    assert path.exists() and (os.stat(path).st_mode & 0o777) == 0o600
    first = path.read_bytes()
    create_app(root, frontend_dist=root / "no-dist", public=public.PublicConfig(enabled=True))
    assert path.read_bytes() == first and app is not None


def test_the_caps_hold_when_the_body_leaves_couples_and_days_to_their_defaults(root: Path) -> None:
    c = _visitor(_app(root, max_couples=30, max_days=20))
    body = {"treatment": {"conflict_half_life_days": 60}, "analysis": {"n_boot": 20, "n_perm": 20}}
    r = c.post("/api/experiments/run?wait=true", json=body)
    assert r.status_code == 400 and "n_couples is at most 30" in r.json()["detail"], r.text
    r = c.post("/api/experiments/run?wait=true", json={**body, "n_couples": 20})
    assert r.status_code == 400 and "days is at most 20" in r.json()["detail"], r.text
    ok = c.post("/api/experiments/run?wait=true", json={**body, "n_couples": 20, "days": 20})
    assert ok.status_code == 200, ok.text


def test_a_second_process_reads_the_secret_the_first_one_is_still_writing(tmp_path: Path) -> None:
    d = tmp_path / public.PUBLIC_DIR
    d.mkdir()
    path = d / "secret"
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)

    def finish() -> None:
        time.sleep(0.1)
        os.write(fd, b"from-the-first-process")
        os.close(fd)

    writer = threading.Thread(target=finish)
    writer.start()
    assert public._secret_file(tmp_path) == b"from-the-first-process"
    writer.join()


def _take_many(args: tuple[str, int]) -> int:
    root, n = args
    counters = public.Counters(Path(root), per_ip=1000, global_cap=10)
    ok = 0
    for _ in range(n):
        try:
            counters.take("same-client")
            ok += 1
        except public.QuotaExceeded:
            pass
    return ok


def test_processes_sharing_the_counters_never_exceed_the_cap(tmp_path: Path) -> None:
    import multiprocessing as mp

    with mp.get_context("spawn").Pool(4) as pool:
        granted = pool.map(_take_many, [(str(tmp_path), 6)] * 4)
    assert sum(granted) == 10, granted
    assert json.loads((tmp_path / public.PUBLIC_DIR / "counters.json").read_text())["global"] == 10
    assert not list((tmp_path / public.PUBLIC_DIR).glob(".counters.*.tmp"))


def test_a_public_run_is_analysed_with_the_server_settings_whatever_the_client_sends(root: Path) -> None:
    c = _visitor(_app(root))
    body = {**RUN, "analysis": {"n_boot": 0, "n_perm": 0, "seed": 99, "ci_level": 0.5}}
    r = c.post("/api/experiments/run?wait=true", json=body)
    assert r.status_code == 200, r.text
    analysis = r.json()["summary"]["analysis"]
    assert (analysis["n_boot"], analysis["n_perm"], analysis["seed"], analysis["ci_level"]) == (500, 500, 7, 0.95)


def test_with_no_curated_world_there_is_no_default_to_land_on_someone_elses_run(tmp_path: Path) -> None:
    app = _app(tmp_path)
    alice, bob = _visitor(app), _visitor(app)
    mine = alice.post("/api/experiments/run?wait=true", json=RUN)
    assert mine.status_code == 200, mine.text
    assert bob.get("/api/experiment").status_code == 404
    assert bob.get("/api/world").status_code == 404
    listing = bob.get("/api/experiments").json()
    assert listing["default"] is None and listing["items"] == []


def test_a_public_run_takes_a_bounded_number_of_shocks_and_a_bounded_body(root: Path) -> None:
    c = _visitor(_app(root))
    shock = {"kind": "job_loss", "start_day": 2, "magnitude": 1.0}
    many = {
        **RUN,
        "treatment": {"conflict_half_life_days": 60, "shocks": [shock] * 10},
        "world": {"shocks": [shock] * 7},
    }
    r = c.post("/api/experiments/run?wait=true", json=many)
    assert r.status_code == 400 and "at most 16 shocks" in r.json()["detail"], r.text
    huge = c.post(
        "/api/shocks/translate",
        content=b'{"text": "' + b"x" * (70 * 1024) + b'"}',
        headers={"content-type": "application/json"},
    )
    assert huge.status_code == 413

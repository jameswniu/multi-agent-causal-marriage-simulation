from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from loveworld.api import create_app


@pytest.fixture(scope="module")
def client(results_root: Path) -> TestClient:
    return TestClient(create_app(results_root, frontend_dist=results_root / "no-dist"))


def _no_nan(obj: Any) -> None:
    if isinstance(obj, float):
        assert not math.isnan(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _no_nan(v)
    elif isinstance(obj, list):
        for v in obj:
            _no_nan(v)


def test_health_experiments_and_default(client: TestClient) -> None:
    h = client.get("/api/health").json()
    assert h["ok"] is True and h["experiments"] == ["smoke", "zeta"]
    listing = client.get("/api/experiments").json()
    assert listing["default"] == "smoke"
    names = [i["name"] for i in listing["items"]]
    assert names == ["smoke", "zeta"]
    smoke = listing["items"][0]
    assert set(smoke) >= {
        "name",
        "dir",
        "n_couples",
        "days",
        "seeds",
        "intervention",
        "divorce_control",
        "divorce_treatment",
        "generated_at_unix",
    }
    assert smoke["intervention"] == {"memory": {"conflict_half_life_days": [14.0, 90.0]}, "shocks": []}
    assert smoke["has_twins"] is True and smoke["days"] == 60
    assert listing["items"][1]["days"] == 30
    assert client.get("/api/experiment", params={"experiment": "zeta"}).json()["manifest"]["days"] == 30
    assert client.get("/api/experiment").json()["manifest"]["days"] == 60
    assert client.get("/api/experiment", params={"experiment": "nope"}).status_code == 404
    assert client.get("/api/experiment", params={"experiment": "smoke-twins"}).status_code == 404


def test_experiment_and_summary_endpoints(client: TestClient) -> None:
    r = client.get("/api/experiment", params={"experiment": "smoke"})
    assert r.status_code == 200
    body = r.json()
    assert body["manifest"]["evidence_class"] == "simulation"
    assert body["summary"]["evidence_class"] == "simulation"
    _no_nan(json.loads(r.text))
    ate = client.get("/api/ate").json()
    assert isinstance(ate, list) and ate[0]["name"] == "divorce_rate"
    curves = client.get("/api/curves").json()
    assert set(curves) == {"survival", "trust", "in_conflict", "neg_load"}
    dist = client.get("/api/distributions").json()
    assert set(dist) == {"recovery_days", "conflicts_per_couple"}
    policy = client.get("/api/policy").json()
    assert "weights" in policy and "contexts" in policy


def test_shock_catalog(client: TestClient) -> None:
    kinds = client.get("/api/shocks/catalog").json()["kinds"]
    names = [k["kind"] for k in kinds]
    assert {
        "job_loss",
        "financial_crisis",
        "temptation",
        "intimacy_mismatch",
        "daily_texts",
        "anniversary",
        "date_nights",
    } <= set(names)
    assert "trait_shift" in names
    for k in kinds:
        assert set(k) == {
            "kind",
            "label",
            "blurb",
            "member_applies",
            "magnitude",
            "default_start_day",
            "default_end_day",
            "default_length_days",
            "traits",
        }
        assert set(k["magnitude"]) == {"min", "max", "default", "unit"}
        if k["kind"] == "trait_shift":
            assert "neuroticism" in k["traits"]


def test_couples_listing_and_detail(client: TestClient) -> None:
    r = client.get("/api/couples", params={"limit": 5, "offset": 0, "sort": "couple_id"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 40 and len(body["items"]) == 5
    assert [c["couple_id"] for c in body["items"]] == [0, 1, 2, 3, 4]
    filtered = client.get("/api/couples", params={"arm": "treatment", "origin": "initial"}).json()
    assert filtered["total"] == 20 and all(c["arm"] == "treatment" for c in filtered["items"])
    assert client.get("/api/couples", params={"sort": "nope"}).status_code == 400
    detail = client.get("/api/couples/0")
    assert detail.status_code == 200
    d = detail.json()
    assert set(d) == {"couple", "agents", "daily", "events", "conflicts", "decisions", "episodes", "legacies"}
    assert d["couple"]["couple_id"] == 0
    assert [a["agent_id"] for a in d["agents"]] == [d["couple"]["agent_a"], d["couple"]["agent_b"]]
    assert len(d["daily"]) >= 1 and d["daily"][0]["day"] == 0
    assert all(row["couple_id"] == 0 for row in d["daily"] + d["events"] + d["conflicts"] + d["decisions"])
    assert any(e["kind"] == "intervention_applied" for e in d["events"])
    assert isinstance(d["episodes"], list)
    _no_nan(json.loads(detail.text))
    assert client.get("/api/couples/999999").status_code == 404
    assert client.get("/api/couples/0", params={"experiment": "zeta"}).json()["daily"][-1]["day"] <= 29


def test_agent_detail(client: TestClient) -> None:
    r = client.get("/api/agents/1")
    assert r.status_code == 200
    a = r.json()
    assert set(a) == {"agent", "couples", "events", "daily", "episodes", "legacies"}
    assert a["agent"]["agent_id"] == 1
    assert a["couples"][0]["couple_id"] == 0
    assert len(a["daily"]) >= 1
    expected_daily = {
        "day",
        "trust",
        "affect",
        "neg",
        "pos",
        "stress",
        "state",
        "couple_id",
        "satisfaction",
        "orphan_days",
    }
    assert expected_daily <= set(a["daily"][0])
    assert isinstance(a["legacies"], list)
    assert all(e["agent_id"] == 1 for e in a["events"])
    _no_nan(json.loads(r.text))
    assert client.get("/api/agents/999999").status_code == 404


def test_episodes_table_is_served_when_present(lonely_results: Path, tmp_path: Path) -> None:
    copy = tmp_path / "with-episodes"
    shutil.copytree(lonely_results, copy)
    table = pa.table(
        {
            "day": pa.array([-30, 3, 3], pa.int32()),
            "couple_id": pa.array([0, 0, 1], pa.int64()),
            "agent_id": pa.array([0, 1, 2], pa.int64()),
            "partner_id": pa.array([1, 0, 3], pa.int64()),
            "kind": ["positive", "conflict", "conflict"],
            "intensity": [0.1, 0.4, 0.5],
            "source": ["history", "conflict", "conflict"],
            "amplified": [False, False, True],
        }
    )
    pq.write_table(table, copy / "episodes.parquet")
    c = TestClient(create_app(copy, frontend_dist=copy / "no-dist"))
    d = c.get("/api/couples/0").json()
    assert [(e["day"], e["agent_id"], e["source"]) for e in d["episodes"]] == [(-30, 0, "history"), (3, 1, "conflict")]
    a = c.get("/api/agents/2").json()
    assert a["episodes"] == [
        {
            "day": 3,
            "couple_id": 1,
            "agent_id": 2,
            "partner_id": 3,
            "kind": "conflict",
            "intensity": 0.5,
            "source": "conflict",
            "amplified": True,
        }
    ]
    assert c.get("/api/couples/5").json()["episodes"] == []


def test_world_replay(client: TestClient) -> None:
    r = client.get("/api/world")
    assert r.status_code == 200
    w = r.json()
    assert set(w) == {"days", "couples", "arms", "origin", "states", "legend", "counts"}
    assert w["days"] == 60 and len(w["states"]) == 60 and len(w["counts"]) == 60
    n = len(w["couples"])
    assert len(w["arms"]) == n == len(w["origin"])
    assert all(len(s) == n for s in w["states"])
    assert w["couples"][:40] == list(range(40)) and all(o == "initial" for o in w["origin"][:40])
    assert all(a in ("control", "treatment") for a in w["arms"][:40])
    assert all(a is None for a in w["arms"][40:])
    assert set("".join(w["states"])) <= set(w["legend"])
    assert set(w["states"][0][:40]) <= {"M", "C"}
    assert set(w["states"][0][40:]) <= {"-"}
    c0 = w["counts"][0]
    assert c0["day"] == 0 and set(c0) == {"day", "control", "treatment", "remarriage"}
    assert c0["control"]["married"] + c0["control"]["conflict"] == w["arms"][:40].count("control")
    couples = client.get("/api/couples", params={"state": "divorced", "origin": "initial"}).json()["items"]
    for c in couples:
        j = w["couples"].index(c["couple_id"])
        assert w["states"][59][j] == "D"
        assert w["states"][int(c["ended_day"])][j] == "D"
    assert client.get("/api/world", params={"experiment": "zeta"}).json()["days"] == 30


def test_events_by_day_and_range(client: TestClient) -> None:
    r = client.get("/api/events", params={"day": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["day"] == 0 and len(body["items"]) >= 1
    assert [e["seq"] for e in body["items"]] == sorted(e["seq"] for e in body["items"])
    assert all(e["day"] == 0 for e in body["items"])
    rng = client.get("/api/events", params={"from": 0, "to": 5}).json()
    assert set(rng) == {"from", "to", "items", "truncated"}
    assert all(0 <= e["day"] <= 5 for e in rng["items"]) and rng["truncated"] is False
    assert len(rng["items"]) <= 5000
    assert client.get("/api/events").status_code == 400
    _no_nan(rng)


def test_twins_world_available(client: TestClient, results_root: Path) -> None:
    r = client.get("/api/twins/world")
    assert r.status_code == 200
    w = r.json()
    assert w["available"] is True
    assert set(w) == {
        "available",
        "days",
        "couples",
        "states_control",
        "states_treatment",
        "diverged",
        "counts_control",
        "counts_treatment",
        "legend",
        "paired",
        "path",
    }
    assert w["days"] == 60 and w["couples"] == list(range(40))
    assert len(w["states_control"]) == 60 == len(w["states_treatment"]) == len(w["diverged"])
    assert all(len(a) == 40 == len(b) for a, b in zip(w["states_control"], w["states_treatment"], strict=True))
    assert set("".join(w["states_control"] + w["states_treatment"])) <= set("MCSDTB")
    for day, (a, b) in enumerate(zip(w["states_control"], w["states_treatment"], strict=True)):
        assert w["diverged"][day] == sum(x != y for x, y in zip(a, b, strict=True))
    assert set(w["counts_control"][0]) == {"married", "conflict", "separated", "divorced"}
    assert w["counts_control"][0]["married"] + w["counts_control"][0]["conflict"] == 40
    assert w["paired"][0]["name"] == "divorce_rate"
    assert (Path(w["path"]) / "control" / "manifest.json").exists()
    _no_nan(w)
    sub = TestClient(create_app(Path(w["path"]) / "treatment", frontend_dist=results_root / "no-dist"))
    own = sub.get("/api/world").json()
    assert [s[:40] for s in own["states"]] == w["states_treatment"]
    assert client.get("/api/twins/world", params={"experiment": "zeta"}).json()["available"] is False


def test_twins_couple_detail(client: TestClient) -> None:
    r = client.get("/api/twins/couples/3")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"control", "treatment"}
    for arm in ("control", "treatment"):
        detail_keys = {"couple", "agents", "daily", "events", "conflicts", "decisions", "episodes", "legacies"}
        assert set(body[arm]) == detail_keys
        assert body[arm]["couple"]["couple_id"] == 3
        assert body[arm]["couple"]["arm"] == arm
    ca, ta = body["control"]["agents"], body["treatment"]["agents"]
    assert [a["agent_id"] for a in ca] == [a["agent_id"] for a in ta]
    assert ca[0]["neuroticism"] == ta[0]["neuroticism"]
    assert ca[0]["conflict_half_life_days"] != ta[0]["conflict_half_life_days"]
    _no_nan(body)
    assert client.get("/api/twins/couples/999999").status_code == 404
    assert client.get("/api/twins/couples/3", params={"experiment": "zeta"}).status_code == 404


def test_twins_absent_in_single_mode(lonely_results: Path) -> None:
    lonely = TestClient(create_app(lonely_results, frontend_dist=lonely_results / "no-dist"))
    assert lonely.get("/api/health").json()["experiments"] == ["smoke"]
    r = lonely.get("/api/twins/world")
    assert r.status_code == 200
    assert r.json()["available"] is False and "reason" in r.json()
    assert lonely.get("/api/twins/couples/0").status_code == 404


def test_run_endpoint_validation_conflict_and_success(client: TestClient, results_root: Path) -> None:
    bad = client.post("/api/experiments/run", json={"name": "x", "n_couples": 10, "days": 10, "bogus": 1})
    assert bad.status_code == 400 and "bogus" in bad.json()["detail"]
    bad = client.post("/api/experiments/run", json={"name": "x", "n_couples": 10, "days": 10, "analysis": {"seed": -1}})
    assert bad.status_code == 400 and "analysis.seed" in bad.json()["detail"]
    bad = client.post("/api/experiments/run", json={"name": "x", "n_couples": 10, "days": 10, "overwrite": "yes"})
    assert bad.status_code == 400
    bad = client.post("/api/experiments/run", json={"name": "x", "n_couples": 10, "days": 10, "engine": {"shocks": []}})
    assert bad.status_code == 400 and "engine.shocks" in bad.json()["detail"]
    bad = client.post("/api/experiments/run", json={"name": "bad name", "n_couples": 10, "days": 10})
    assert bad.status_code == 400
    bad = client.post("/api/experiments/run", json={"name": "x", "n_couples": 5000, "days": 10})
    assert bad.status_code == 400 and "n_couples" in bad.json()["detail"]
    bad = client.post(
        "/api/experiments/run", json={"name": "x", "n_couples": 10, "days": 10, "engine": {"memory": {"capacity": 5}}}
    )
    assert bad.status_code == 400 and "engine.memory" in bad.json()["detail"]
    bad = client.post(
        "/api/experiments/run", json={"name": "x", "n_couples": 10, "days": 10, "analysis": {"n_boot": 900}}
    )
    assert bad.status_code == 400
    assert client.post("/api/experiments/run", json={"name": "smoke", "n_couples": 10, "days": 10}).status_code == 409
    body = {
        "name": "api-run",
        "n_couples": 20,
        "days": 20,
        "seeds": {"population": 1, "assignment": 2, "dynamics": 3},
        "treatment": {
            "conflict_half_life_days": 60,
            "shocks": [{"kind": "job_loss", "member": "a", "start_day": 2, "end_day": 10}],
        },
        "world": {"shocks": [{"kind": "date_nights", "start_day": 1}]},
        "analysis": {"n_boot": 50, "n_perm": 50},
    }
    ok = client.post("/api/experiments/run", json=body)
    assert ok.status_code == 200, ok.text
    out = ok.json()
    assert out["name"] == "api-run" and Path(out["dir"]) == results_root / "api-run"
    assert out["summary"]["experiment"]["treatment"]["treatment_value"] == 60.0
    assert [s["target"] for s in out["summary"]["experiment"]["shocks"]] == ["treatment", "all"]
    assert (results_root / "api-run" / "config.json").exists()
    cfg = json.loads((results_root / "api-run" / "config.json").read_text())
    assert cfg["shocks"][0]["kind"] == "job_loss" and cfg["shocks"][0]["target"] == "treatment"
    _no_nan(out)
    names = [i["name"] for i in client.get("/api/experiments").json()["items"]]
    assert names == ["api-run", "smoke", "zeta"]
    assert client.get("/api/experiment", params={"experiment": "api-run"}).json()["manifest"]["days"] == 20
    assert client.post("/api/experiments/run", json={**body, "overwrite": True}).status_code == 200


def test_dashboard_fallback_reads_index_per_request(lonely_results: Path, tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>v1</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    c = TestClient(create_app(lonely_results, frontend_dist=dist))
    assert c.get("/").text == "<html>v1</html>"
    assert c.get("/couples/3").text == "<html>v1</html>"
    assert c.get("/assets/app.js").text == "console.log(1)"
    (dist / "index.html").write_text("<html>v2</html>")
    assert c.get("/").text == "<html>v2</html>"
    assert c.get("/world").text == "<html>v2</html>"
    assert c.get("/api/nope").status_code == 404
    assert c.get("/api/health").status_code == 200
    assert c.get("/../pyproject.toml").text == "<html>v2</html>"


def test_root_discovery_skips_symlinks_and_outside_dirs(
    results_root: Path, lonely_results: Path, tmp_path: Path
) -> None:
    root = tmp_path / "root"
    root.mkdir()
    shutil.copytree(results_root / "smoke", root / "smoke")
    (root / "linked").symlink_to(lonely_results, target_is_directory=True)
    c = TestClient(create_app(root, frontend_dist=root / "no-dist"))
    assert c.get("/api/health").json()["experiments"] == ["smoke"]
    assert c.get("/api/experiment", params={"experiment": "linked"}).status_code == 404
    assert c.get("/api/experiment", params={"experiment": "../smoke"}).status_code == 404
    assert c.get("/api/experiment", params={"experiment": "smoke"}).status_code == 200
    alias = tmp_path / "alias"
    alias.symlink_to(root, target_is_directory=True)
    c2 = TestClient(create_app(alias, frontend_dist=root / "no-dist"))
    assert c2.get("/api/health").json()["experiments"] == ["smoke"]


def test_stored_governance_paths_are_never_followed(results_root: Path, tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    shutil.copytree(results_root / "smoke", root / "smoke")
    summary = json.loads((root / "smoke" / "summary.json").read_text())
    summary["governance"]["twins"] = {"path": str(results_root / "smoke-twins"), "paired": [{"name": "divorce_rate"}]}
    (root / "smoke" / "summary.json").write_text(json.dumps(summary))
    c = TestClient(create_app(root, frontend_dist=root / "no-dist"))
    assert c.get("/api/twins/world").json()["available"] is False
    item = c.get("/api/experiments").json()["items"][0]
    assert item["has_twins"] is False and item["has_placebo"] is False
    (root / "smoke-twins").symlink_to(results_root / "smoke-twins", target_is_directory=True)
    c = TestClient(create_app(root, frontend_dist=root / "no-dist"))
    assert c.get("/api/twins/world").json()["available"] is False
    (root / "smoke-twins").unlink()
    shutil.copytree(results_root / "smoke-twins", root / "smoke-twins")
    c = TestClient(create_app(root, frontend_dist=root / "no-dist"))
    assert c.get("/api/twins/world").json()["available"] is True
    assert c.get("/api/experiments").json()["items"][0]["has_twins"] is True


def test_symlinked_index_outside_dist_is_refused(lonely_results: Path, tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    outside = tmp_path / "secret.html"
    outside.write_text("<html>secret</html>")
    (dist / "index.html").symlink_to(outside)
    c = TestClient(create_app(lonely_results, frontend_dist=dist))
    assert c.get("/").status_code == 404
    assert c.get("/world").status_code == 404
    assert c.get("/api/health").status_code == 200


def test_root_mode_startup_recovers_a_stranded_swap(results_root: Path, tmp_path: Path) -> None:
    """Results left hidden by a run that died mid-publication are listed again after startup."""
    from loveworld import runner

    shutil.copytree(results_root / "smoke", tmp_path / "smoke")
    old = tmp_path / ".smoke.old-4242"
    (tmp_path / "smoke" / runner.SWAP_MARKER).write_text(json.dumps({"target": "smoke", "pid": 4242}))
    (tmp_path / "smoke").rename(old)
    app = create_app(tmp_path, frontend_dist=tmp_path / "no-dist")
    assert TestClient(app).get("/api/health").json()["experiments"] == ["smoke"]
    assert not old.exists() and not (tmp_path / "smoke" / runner.SWAP_MARKER).exists()


def test_legacies_and_orphan_days_are_tolerated_when_absent_and_served_when_present(
    lonely_results: Path, tmp_path: Path
) -> None:
    """A run from an older engine has neither; a newer one has both, and each reaches the detail payloads."""
    old = tmp_path / "older-engine"
    shutil.copytree(lonely_results, old)
    (old / "legacies.parquet").unlink(missing_ok=True)
    daily = pq.read_table(old / "daily.parquet")
    if "orphan_days" in daily.column_names:
        pq.write_table(daily.drop(["orphan_days"]), old / "daily.parquet")
    c = TestClient(create_app(old, frontend_dist=old / "no-dist"))
    d = c.get("/api/couples/0").json()
    assert d["legacies"] == [] and all(row["orphan_days"] == 0 for row in d["daily"])
    assert all(row["orphan_days"] == 0 for row in c.get("/api/agents/0").json()["daily"])

    new = tmp_path / "newer-engine"
    shutil.copytree(old, new)
    table = pa.table(
        {
            "day": pa.array([40, 40], pa.int32()),
            "couple_id": pa.array([0, 0], pa.int64()),
            "agent_id": pa.array([0, 1], pa.int64()),
            "partner_id": pa.array([1, 0], pa.int64()),
            "ended_by": ["self", "partner"],
            "conflicts": pa.array([5, 5], pa.int32()),
            "reconciled": pa.array([2, 2], pa.int32()),
            "final_trust": [0.21, 0.33],
            "final_neg_load": [0.9, 0.7],
            "final_pos_load": [0.1, 0.2],
            "match_quality": [0.71, 0.71],
            "commitment_shift": [0.3, 0.3],
            "trust_prior": [0.4, 0.45],
        }
    )
    pq.write_table(table, new / "legacies.parquet")
    c = TestClient(create_app(new, frontend_dist=new / "no-dist"))
    d = c.get("/api/couples/0").json()
    assert [(row["agent_id"], row["ended_by"]) for row in d["legacies"]] == [(0, "self"), (1, "partner")]
    a = c.get("/api/agents/1").json()
    assert [row["trust_prior"] for row in a["legacies"]] == [0.45]
    assert c.get("/api/agents/2").json()["legacies"] == []

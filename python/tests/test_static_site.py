"""The read-only demo's exporter: every file it writes, inflated, is exactly what the API answers."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from loveworld import demo, runner, static_site
from loveworld.api import create_app
from loveworld.experiment import load_experiment

from .conftest import EXPERIMENTS
from .test_demo import _job_loss_demo, _write


@pytest.fixture
def built(tmp_path: Path, defaults: dict) -> dict[str, Any]:
    """A results root with the smoke world, its twins, a demo world forked from it, and a world the demo leaves out."""
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    root = tmp_path / "results"
    runner.run_twins(exp, root / "smoke-twins")
    runner.run_experiment(exp, root / "smoke")
    other = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    other.name, other.days = "other", 20
    runner.run_experiment(other, root / "other")
    demo_dir = tmp_path / "demo"
    d = demo.load_demo(_write(demo_dir, "hard-times", _job_loss_demo("demo-hard-times")))
    demo.build_demo(d, root)
    site = tmp_path / "site"
    lines: list[str] = []
    report = static_site.export_site(root, site, default="smoke", demo_dir=demo_dir, log=lines.append)
    return {"root": root, "site": site, "report": report, "lines": lines, "demo_dir": demo_dir, "tmp": tmp_path}


def _inflate(path: Path) -> bytes:
    return gzip.decompress(path.read_bytes())


def _client(b: dict[str, Any]) -> TestClient:
    """The API over a root of exactly the exported worlds, as a server for the demo would be."""
    check = b["tmp"] / "check"
    static_site.stage_root(b["root"], ["smoke", "demo-hard-times"], check)
    app = create_app(check, frontend_dist=check / "no-dist")
    app.state.store.preferred_default = "smoke"
    return TestClient(app)


def _request_for(rel: str) -> tuple[str, dict[str, Any]]:
    """The API read a data file answers, from its path under data/."""
    parts = rel.removesuffix(".gz").split("/")
    if len(parts) == 1:
        return static_site.GLOBAL_READS[parts[0].removesuffix(".json")], {}
    assert parts[0] == "w"
    world, rest = parts[1], parts[2:]
    q: dict[str, Any] = {"experiment": world}
    if len(rest) == 1 and rest[0] == "couples.json":
        return "/api/couples", {**q, "limit": static_site.COUPLES_PAGE, "offset": 0}
    if len(rest) == 1:
        return static_site.WORLD_READS[rest[0].removesuffix(".json")], q
    kind, name = rest
    if kind == "couples":
        return f"/api/couples/{name.removesuffix('.json')}", q
    if kind == "agents":
        return f"/api/agents/{name.removesuffix('.json')}", q
    if kind == "lens":
        return f"/api/lens/{name.removesuffix('.bin')}", q
    raise AssertionError(f"unexpected data file {rel}")


def test_every_file_inflated_is_the_api_response_byte_for_byte(built: dict[str, Any]) -> None:
    data = built["site"] / "data"
    client = _client(built)
    index = json.loads(_inflate(data / "index.json.gz"))
    files = sorted(p for p in data.rglob("*") if p.is_file())
    assert built["report"].files == len(files)
    assert built["report"].bytes == sum(p.stat().st_size for p in files)
    checked = 0
    for path in files:
        rel = path.relative_to(data).as_posix()
        if rel == "index.json.gz":
            continue
        raw = _inflate(path)
        if "/events/" in rel:
            world, k = rel.split("/")[1], int(path.name.split(".")[0])
            start = k * static_site.EVENT_CHUNK_DAYS
            days = next(w["days"] for w in index["worlds"] if w["name"] == world)
            end = min(days, start + static_site.EVENT_CHUNK_DAYS) - 1
            parts = [
                client.get("/api/events", params={"experiment": world, "day": d}).content for d in range(start, end + 1)
            ]
            assert raw == b'{"from":%d,"to":%d,"days":[' % (start, end) + b",".join(parts) + b"]}", rel
            checked += 1
            continue
        path_, params = _request_for(rel)
        r = client.get(path_, params=params)
        assert r.status_code == 200, (rel, r.text)
        assert raw == r.content, rel
        if "/lens/" in rel:
            world, lens = rel.split("/")[1], path.name.split(".")[0]
            headers = next(w for w in index["worlds"] if w["name"] == world)["lenses"][lens]["headers"]
            assert headers == {h: r.headers[h] for h in headers}
        checked += 1
    assert checked == len(files) - 1


def test_the_site_holds_every_couple_agent_day_and_lens_of_each_world(built: dict[str, Any]) -> None:
    data = built["site"] / "data"
    index = json.loads(_inflate(data / "index.json.gz"))
    assert index["default"] == "smoke"
    assert [w["name"] for w in index["worlds"]] == ["smoke", "demo-hard-times"]
    listing = json.loads(_inflate(data / "experiments.json.gz"))
    # Only the worlds the demo shows are listed, with its default, so the page never offers a world with no files.
    assert listing["default"] == "smoke" and sorted(i["name"] for i in listing["items"]) == ["demo-hard-times", "smoke"]
    for w in index["worlds"]:
        base = data / "w" / w["name"]
        couples = json.loads(_inflate(base / "couples.json.gz"))
        assert couples["total"] == w["couples"] == len(couples["items"])
        assert {p.name for p in (base / "couples").iterdir()} == {f"{c['couple_id']}.json.gz" for c in couples["items"]}
        assert len(list((base / "agents").iterdir())) == w["agents"] == 80
        chunks = -(-w["days"] // static_site.EVENT_CHUNK_DAYS)
        assert sorted(p.name for p in (base / "events").iterdir()) == sorted(f"{k}.json.gz" for k in range(chunks))
        for lens, entry in w["lenses"].items():
            assert (base / "lens" / f"{lens}.bin.gz").is_file() == ("headers" in entry)
        assert w["couples_columns"][0] == "couple_id"
    card = index["demos"][0]
    assert card["name"] == "demo-hard-times" and card["typed"] is True and card["hits"] == "treatment"
    assert card["translation"]["model"] == "claude-haiku-5-5"
    assert (
        card["shocks"] == json.loads((built["root"] / "demo-hard-times" / "parent.json").read_text())["appended_shocks"]
    )
    # Gzipped with no timestamp, so exporting the same worlds twice writes the same bytes.
    assert all(p.read_bytes()[4:8] == b"\0\0\0\0" for p in data.rglob("*.gz"))
    assert any("MB gzipped" in line for line in built["lines"])


def test_the_site_holds_nothing_secret_and_no_way_to_reach_a_model(built: dict[str, Any]) -> None:
    # No key, no way to a model, and no path on the machine that built it (the site is public).
    local = str(built["tmp"].resolve()).encode()
    for path in (built["site"] / "data").rglob("*.gz"):
        text = _inflate(path)
        for needle in (b"sk-ant", b"ANTHROPIC_API_KEY", b"x-api-key", b"/.translations", local, b".static-export-"):
            assert needle not in text, (path, needle)


def test_a_stale_demo_world_or_a_site_too_large_stops_the_export(built: dict[str, Any], defaults: dict) -> None:
    before = (built["site"] / "data" / "index.json.gz").read_bytes()
    with pytest.raises(static_site.StaticExportError, match="over the"):
        static_site.export_site(
            built["root"], built["site"], default="smoke", demo_dir=built["demo_dir"], fail_mb=0.001, log=lambda _: None
        )
    # The data already in the site stays as it was.
    assert (built["site"] / "data" / "index.json.gz").read_bytes() == before
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    exp.seeds = {**exp.seeds, "dynamics": 34}
    runner.run_experiment(exp, built["root"] / "smoke", overwrite=True)
    with pytest.raises(demo.DemoError, match="run make demo"):
        static_site.export_site(
            built["root"], built["site"], default="smoke", demo_dir=built["demo_dir"], log=lambda _: None
        )
    # Nothing is left behind in the results root or the site folder by a refused export.
    assert not list(built["root"].glob(".static-export-*")) and not list(built["site"].glob(".data-*"))

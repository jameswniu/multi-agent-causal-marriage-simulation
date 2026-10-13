"""The read-only demo's pre-run shocks: the committed files, the checks on them, and the worlds the builder makes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from loveworld import demo, runner, translate
from loveworld.api import create_app
from loveworld.experiment import load_experiment
from loveworld.forking import parse_fork_shocks

from .conftest import EXPERIMENTS

EXAMPLE_DAYS = int(yaml.safe_load((EXPERIMENTS / "example.yaml").read_text())["days"])


def _write(directory: Path, name: str, data: dict[str, Any]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.json"
    path.write_text(json.dumps(data, indent=2))
    return path


def _committed(stem: str) -> dict[str, Any]:
    return dict(json.loads((demo.DEMO_DIR / f"{stem}.json").read_text()))


def test_the_committed_demo_shocks_are_valid_for_the_example_and_show_range() -> None:
    items = demo.load_demos()
    assert 3 <= len(items) <= 4
    assert [d.order for d in items] == sorted(d.order for d in items)
    for d in items:
        assert d.parent == "example" and d.name.startswith("demo-")
        shocks = demo.check_demo(d, EXAMPLE_DAYS)
        assert [s.to_engine() for s in shocks] == d.shocks
    assert {d.hits for d in items} == {"treatment", "all"}
    kinds = {s["kind"] for d in items for s in d.shocks}
    assert "custom" in kinds and kinds - {"custom"}
    assert any(d.translation is None for d in items) and any(d.translation is not None for d in items)
    mother = next(d for d in items if d.name == "demo-mother-moves-in")
    # The sentence as the README's recording shows it typed. It hashes to the translation record's text_sha256,
    # which is taken over the text lowercased with its spacing collapsed, so the hash alone cannot check case.
    assert mother.typed and mother.words == "his mother moves in for two months starting in month four"
    assert mother.record is not None and translate.text_sha256(mother.words) == mother.record["text_sha256"]
    for d in items:
        if not d.typed and d.record is not None:
            assert translate.text_sha256(d.words) != d.record["text_sha256"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.update(words=d["words"] + " again"), "typed words must hash"),
        (lambda d: d["shocks"][0].pop("end_day"), "not in the form the app runs"),
        (lambda d: d.update(hits="all"), "hits must be 'treatment'"),
        (
            lambda d: d["translation"]["record"]["spec"]["effects"][0].update(amount=0.9),
            "differs from the shock as translated",
        ),
        (lambda d: d.update(colour="pink"), "keys must be exactly"),
        (lambda d: d.update(name="mother"), "name must start with 'demo-'"),
        (lambda d: d.update(translation=None), "typed words need the translation record"),
        (lambda d: d["translation"].update(shock_index=3), "shock_index must point at one of the shocks"),
    ],
)
def test_a_demo_file_that_does_not_hold_what_ran_is_refused(tmp_path: Path, change: Any, message: str) -> None:
    data = _committed("mother-moves-in")
    change(data)
    with pytest.raises(demo.DemoError, match=message):
        demo.check_demo(demo.load_demo(_write(tmp_path, "mother", data)), EXAMPLE_DAYS)


def test_two_demo_files_may_not_share_a_name(tmp_path: Path) -> None:
    _write(tmp_path, "a", _committed("layoff"))
    _write(tmp_path, "b", {**_committed("layoff"), "order": 9})
    with pytest.raises(demo.DemoError, match="share the name"):
        demo.load_demos(tmp_path)


@pytest.fixture
def smoke_root(tmp_path: Path, defaults: dict) -> Path:
    """A results root holding the smoke experiment and its twins, as make placebo twins example leaves the example."""
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    root = tmp_path / "results"
    runner.run_twins(exp, root / "smoke-twins")
    runner.run_experiment(exp, root / "smoke")
    return root


def _job_loss_demo(name: str, typed: bool = True) -> dict[str, Any]:
    """A demo file for the smoke world: a translated job loss in the treatment arm, as the app runs it."""
    words = "He loses his job on day five for five weeks"
    shock = parse_fork_shocks(
        [
            {
                "kind": "job_loss",
                "target": "treatment",
                "member": "random",
                "start_day": 5,
                "end_day": 40,
                "magnitude": 3.0,
            }
        ],
        60,
    )[0]
    record = {
        "translation_id": "0123456789abcdef0123456789abcdef",
        "status": "ok",
        "spec": translate.spec_of(shock),
        "words": "One partner loses their job (a random partner, treatment arm), days 5 to 40, magnitude 3 (stress)",
        "rationale": "Day five for five weeks ends on day 40.",
        "model": "claude-haiku-5-5",
        "text_sha256": translate.text_sha256(words if typed else "something else"),
        "days": 60,
        "errors": [],
        "message": None,
    }
    return {
        "name": name,
        "order": 1,
        "title": "He loses his job",
        "words": words,
        "typed": typed,
        "parent": "smoke",
        "hits": "treatment",
        "shocks": [shock.to_engine()],
        "translation": {"shock_index": 0, "recorded": "2026-10-12T01:33:33-07:00", "record": record},
        "note": "A test shock.",
    }


def test_the_builder_makes_exactly_the_world_the_fork_endpoint_makes(
    smoke_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No model is ever asked for: a translator that tried to reach one would fail the test.
    def no_model(self: translate.Translator) -> None:
        raise AssertionError("the demo builder must never call a model")

    monkeypatch.setattr(translate.Translator, "_get_client", no_model)
    data = _job_loss_demo("demo-hard-times")
    d = demo.load_demo(_write(tmp_path / "demo", "hard-times", data))
    summary = demo.build_demo(d, smoke_root)
    child = smoke_root / "demo-hard-times"
    assert summary["experiment"]["name"] == "demo-hard-times"
    assert runner.is_twins_dir(smoke_root / "demo-hard-times-twins")
    record = json.loads((child / "parent.json").read_text())
    parent_manifest = json.loads((smoke_root / "smoke" / "manifest.json").read_text())
    assert record["parent"] == "smoke" and record["appended_shocks"] == data["shocks"]
    assert record["parent_determinism_hash"] == parent_manifest["determinism_hash"]
    assert record["comparison"]["comparable"] is True
    provenance = json.loads((child / "translation.json").read_text())["translations"]
    assert provenance == [
        {
            "shock_index": 0,
            "translation_id": data["translation"]["record"]["translation_id"],
            "verified": True,
            "text_sha256": data["translation"]["record"]["text_sha256"],
            "model": "claude-haiku-5-5",
            "status_when_translated": "ok",
            "spec_as_translated": data["translation"]["record"]["spec"],
            "spec_as_run": data["translation"]["record"]["spec"],
            "edited": False,
        }
    ]
    demo.check_built(d, smoke_root)
    # The same request through POST /api/experiments/fork writes the very same tables and records.
    records = smoke_root / ".translations"
    records.mkdir()
    rec = data["translation"]["record"]
    (records / f"{rec['translation_id']}.json").write_text(json.dumps(rec))
    client = TestClient(create_app(smoke_root, frontend_dist=tmp_path / "no-dist"))
    body = {
        "parent": "smoke",
        "name": "endpoint-hard-times",
        "shocks": data["shocks"],
        "translations": [{"translation_id": rec["translation_id"], "shock_index": 0}],
    }
    r = client.post("/api/experiments/fork?wait=true", json=body)
    assert r.status_code == 200, r.text
    endpoint = smoke_root / "endpoint-hard-times"
    for name in ("parent.json", "translation.json"):
        assert json.loads((endpoint / name).read_text()) == json.loads((child / name).read_text()), name
    built, served = (json.loads((p / "manifest.json").read_text()) for p in (child, endpoint))
    assert built["files"] == served["files"] and built["determinism_hash"] == served["determinism_hash"]
    twin = smoke_root / "demo-hard-times-twins" / "treatment" / "manifest.json"
    twin_served = smoke_root / "endpoint-hard-times-twins" / "treatment" / "manifest.json"
    assert json.loads(twin.read_text())["files"] == json.loads(twin_served.read_text())["files"]


def test_building_again_replaces_the_demo_world_with_the_same_one(smoke_root: Path, tmp_path: Path) -> None:
    d = demo.load_demo(_write(tmp_path / "demo", "hard-times", _job_loss_demo("demo-hard-times", typed=False)))
    demo.build_demo(d, smoke_root)
    first = json.loads((smoke_root / "demo-hard-times" / "manifest.json").read_text())["determinism_hash"]
    demo.build_demo(d, smoke_root)
    again = json.loads((smoke_root / "demo-hard-times" / "manifest.json").read_text())["determinism_hash"]
    assert first == again
    assert not list(smoke_root.glob(".demo-hard-times*"))


def test_a_demo_world_made_before_its_parent_was_run_again_is_stale(
    smoke_root: Path, tmp_path: Path, defaults: dict
) -> None:
    d = demo.load_demo(_write(tmp_path / "demo", "hard-times", _job_loss_demo("demo-hard-times")))
    demo.build_demo(d, smoke_root)
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    exp.seeds = {**exp.seeds, "dynamics": 34}
    runner.run_experiment(exp, smoke_root / "smoke", overwrite=True)
    with pytest.raises(demo.DemoError, match="run make demo"):
        demo.check_built(d, smoke_root)


def test_a_missing_parent_or_demo_world_is_named(tmp_path: Path, smoke_root: Path) -> None:
    d = demo.load_demo(_write(tmp_path / "demo", "hard-times", _job_loss_demo("demo-hard-times")))
    with pytest.raises(demo.DemoError, match="parent world 'smoke' is not in"):
        demo.build_demo(d, tmp_path / "empty")
    with pytest.raises(demo.DemoError, match="parent world 'smoke' is not in"):
        demo.check_built(d, tmp_path / "empty")
    with pytest.raises(demo.DemoError, match="demo-hard-times is not in .*; run make demo"):
        demo.check_built(d, smoke_root)

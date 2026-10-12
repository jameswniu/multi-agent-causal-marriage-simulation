"""The engine wrapper: timeouts that stop and clean up, and configs the engine accepts as sent."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from loveworld import engine as eng
from loveworld import runner
from loveworld.engine import EngineError
from loveworld.experiment import build_engine_config, load_experiment

from .conftest import EXPERIMENTS

# Big enough that the engine is still working well after the timeout used below.
_SLOW = {"n_couples": 2000, "days": 730}


def _leftovers(parent: Path, name: str) -> list[str]:
    return sorted(p.name for p in parent.iterdir() if p.name.startswith(f".{name}."))


def test_a_run_past_its_timeout_is_stopped_and_leaves_nothing_behind(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    cfg = {**build_engine_config(exp), **_SLOW}
    out = tmp_path / "slow"
    with pytest.raises(EngineError, match="timed out after 0.5 s"):
        eng.run_engine(cfg, out, timeout=0.5)
    assert not out.exists()
    assert _leftovers(tmp_path, "slow") == [], "the stopped engine's staging dir and lock are removed"


def test_the_runner_honours_the_timeout_setting(
    defaults: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    exp.n_couples, exp.days = _SLOW["n_couples"], _SLOW["days"]
    monkeypatch.setenv("LOVEWORLD_ENGINE_TIMEOUT", "0.5")
    target = tmp_path / "smoke"
    with pytest.raises(EngineError, match="timed out"):
        runner.run_experiment(exp, target)
    assert not target.exists()
    assert _leftovers(tmp_path, "smoke") == [], "staging and lock are gone after a timeout"


@pytest.mark.parametrize(("raw", "expected"), [("5", 5.0), ("0.25", 0.25), ("abc", 120.0), ("-1", 120.0), ("0", 120.0)])
def test_the_timeout_setting_falls_back_to_the_default_when_unusable(
    raw: str, expected: float, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOVEWORLD_ENGINE_TIMEOUT", raw)
    assert eng.engine_timeout() == expected


def test_a_run_inside_its_timeout_is_untouched(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    manifest = eng.run_engine(build_engine_config(exp), tmp_path / "quick", timeout=60)
    assert manifest["engine"] == "loveworld-engine"


@pytest.mark.parametrize("path", sorted(EXPERIMENTS.glob("*.yaml")), ids=lambda p: p.stem)
def test_every_experiment_builds_a_config_the_engine_accepts_key_for_key(defaults: dict, path: Path) -> None:
    """The engine rejects unknown keys, so every config Python builds must use known keys only."""
    exp = load_experiment(path, defaults)
    for placebo in (False, True):
        arms = eng.assign(build_engine_config(exp, placebo=placebo))
        assert len(arms) == exp.n_couples


def test_a_replay_past_its_timeout_leaves_nothing_beside_its_output(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    results = tmp_path / "big"
    results.mkdir()
    (results / "manifest.json").write_text(json.dumps({"config": {**build_engine_config(exp), **_SLOW}}))
    out = tmp_path / "replayed"
    with pytest.raises(EngineError, match="replay timed out"):
        eng.replay(results, out, timeout=0.5)
    assert _leftovers(tmp_path, "replayed") == [], "the stopped replay's staging dir and lock are removed"


def test_cleanup_after_a_stop_restores_results_renamed_aside_and_only_its_own(tmp_path: Path) -> None:
    out = tmp_path / "r"
    aside = tmp_path / ".r.old-4242-0"
    aside.mkdir()
    (aside / "manifest.json").write_text("{}")
    (aside / eng.SWAP_MARKER).write_text("{}")
    other = tmp_path / ".r.tmp-777-0"
    other.mkdir()
    (tmp_path / ".r.lock").write_text("777")
    eng._clean_after_stopped_run(out, 4242)
    assert (out / "manifest.json").exists() and not (out / eng.SWAP_MARKER).exists(), "renamed back"
    assert other.exists() and (tmp_path / ".r.lock").exists(), "another process's files are left alone"

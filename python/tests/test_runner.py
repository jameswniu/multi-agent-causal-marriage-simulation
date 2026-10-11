from __future__ import annotations

import json
from pathlib import Path

import pytest

from loveworld import runner
from loveworld.engine import EngineError
from loveworld.experiment import load_experiment

from .conftest import EXPERIMENTS


def test_refuses_foreign_non_empty_target(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    target = tmp_path / "mine"
    target.mkdir()
    (target / "precious.txt").write_text("do not delete")
    with pytest.raises(runner.TargetError):
        runner.run_experiment(exp, target, overwrite=True)
    assert (target / "precious.txt").read_text() == "do not delete"
    assert not list(tmp_path.glob(".mine.tmp-*"))


def test_refuses_existing_results_without_overwrite_and_replaces_atomically(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    target = tmp_path / "smoke"
    runner.run_experiment(exp, target)
    first = json.loads((target / "manifest.json").read_text())["determinism_hash"]
    with pytest.raises(runner.TargetError):
        runner.run_experiment(exp, target)
    exp.days = 20
    runner.run_experiment(exp, target, overwrite=True)
    second = json.loads((target / "manifest.json").read_text())
    assert second["days"] == 20 and second["determinism_hash"] != first
    assert not list(tmp_path.glob(".smoke.*"))


def test_empty_dir_is_fine_and_file_target_is_not(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    empty = tmp_path / "empty"
    empty.mkdir()
    runner.run_experiment(exp, empty)
    assert (empty / "summary.json").exists()
    f = tmp_path / "file"
    f.write_text("x")
    with pytest.raises(runner.TargetError):
        runner.run_experiment(exp, f)


def test_bad_config_fails_before_touching_the_target(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    exp.engine = {"dynamics": {"onset_intercept": "not a number"}}
    target = tmp_path / "smoke"
    with pytest.raises(EngineError):
        runner.run_experiment(exp, target)
    assert not target.exists()
    assert not list(tmp_path.glob(".smoke.*"))


def test_interrupted_swap_leaves_a_marker_and_recovers(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    target = tmp_path / "smoke"
    runner.run_experiment(exp, target)
    manifest = (target / "manifest.json").read_text()
    old = tmp_path / ".smoke.old-12345"
    marker = {"state": "replacing", "target": "smoke", "staging": "x", "pid": 12345}
    (target / runner.SWAP_MARKER).write_text(json.dumps(marker))
    target.rename(old)
    assert not target.exists()
    assert runner.recover_swaps(tmp_path) == [target]
    assert (target / "manifest.json").read_text() == manifest
    assert not (target / runner.SWAP_MARKER).exists() and not old.exists()
    stale = tmp_path / ".smoke.old-777"
    stale.mkdir()
    (stale / runner.SWAP_MARKER).write_text(json.dumps({"target": "smoke"}))
    assert runner.recover_swaps(tmp_path) == [target]
    assert not stale.exists() and target.exists()
    bad = tmp_path / ".evil.old-1"
    bad.mkdir()
    (bad / runner.SWAP_MARKER).write_text(json.dumps({"target": "../evil"}))
    assert runner.recover_swaps(tmp_path) == []
    assert bad.exists()


def test_successful_overwrite_leaves_no_marker_or_old_dir(defaults: dict, tmp_path: Path) -> None:
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    target = tmp_path / "smoke"
    runner.run_experiment(exp, target)
    runner.run_experiment(exp, target, overwrite=True)
    assert not (target / runner.SWAP_MARKER).exists()
    assert not list(tmp_path.glob(".smoke.*"))
    assert runner.recover_swaps(tmp_path) == []


def test_target_lock_refuses_a_concurrent_run(tmp_path) -> None:
    """A second run on the same target while the first holds the lock is refused, not merged."""
    from loveworld.runner import TargetError, _TargetLock

    target = tmp_path / "shared"
    with _TargetLock(target):
        assert (tmp_path / ".shared.lock").exists()
        with pytest.raises(TargetError):
            with _TargetLock(target):
                pass
    assert not (tmp_path / ".shared.lock").exists()


def _strand(target: Path, pid: int = 12345) -> Path:
    """Simulate a crash between the two publication renames: marker written, target renamed aside."""
    old = target.parent / f".{target.name}.old-{pid}"
    marker = {"state": "replacing", "target": target.name, "staging": "x", "pid": pid}
    (target / runner.SWAP_MARKER).write_text(json.dumps(marker))
    target.rename(old)
    return old


def test_run_recovers_a_stranded_swap_before_validating(defaults: dict, tmp_path: Path) -> None:
    """A later run restores the stranded results first, then applies the overwrite rule to them."""
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    target = tmp_path / "smoke"
    runner.run_experiment(exp, target)
    manifest = (target / "manifest.json").read_text()
    old = _strand(target)
    assert not target.exists()
    with pytest.raises(runner.TargetError, match="pass overwrite"):
        runner.run_experiment(exp, target)
    assert (target / "manifest.json").read_text() == manifest, "the stranded results came back"
    assert not old.exists() and not (target / runner.SWAP_MARKER).exists()
    _strand(target, pid=777)
    exp.days = 20
    runner.run_experiment(exp, target, overwrite=True)
    assert json.loads((target / "manifest.json").read_text())["days"] == 20
    assert not list(tmp_path.glob(".smoke.*"))


def test_recover_swaps_respects_locks_and_the_name_filter(tmp_path: Path) -> None:
    for name in ("a", "b"):
        old = tmp_path / f".{name}.old-1"
        old.mkdir()
        (old / runner.SWAP_MARKER).write_text(json.dumps({"target": name}))
    lock = tmp_path / ".a.lock"
    lock.write_text("1")
    assert runner.recover_swaps(tmp_path, "a") == [], "a locked target is mid-swap, not stranded"
    assert (tmp_path / ".a.old-1").exists()
    assert runner.recover_swaps(tmp_path, "b") == [tmp_path / "b"]
    assert (tmp_path / "b").is_dir() and not (tmp_path / "b" / runner.SWAP_MARKER).exists()
    lock.unlink()
    assert runner.recover_swaps(tmp_path) == [tmp_path / "a"]
    mismatch = tmp_path / ".c.old-1"
    mismatch.mkdir()
    (mismatch / runner.SWAP_MARKER).write_text(json.dumps({"target": "d"}))
    assert runner.recover_swaps(tmp_path, "c") == [], "the marker's target must match the name asked for"
    assert mismatch.exists()


def test_swap_in_never_deletes_an_existing_old_dir(tmp_path: Path) -> None:
    """An occupied `.old-` name is skipped, so a stranded copy survives the swap untouched."""
    target = tmp_path / "smoke"
    target.mkdir()
    (target / "manifest.json").write_text("{}")
    foreign = tmp_path / f".smoke.old-{__import__('os').getpid()}"
    foreign.mkdir()
    (foreign / "keep.txt").write_text("the only copy")
    tmp = tmp_path / ".smoke.tmp-x"
    tmp.mkdir()
    (tmp / "manifest.json").write_text('{"new": true}')
    runner._swap_in(tmp, target)
    assert json.loads((target / "manifest.json").read_text()) == {"new": True}
    assert (foreign / "keep.txt").read_text() == "the only copy"
    assert runner.recover_swaps(tmp_path) == [], "no marker, so recovery leaves it alone too"
    assert foreign.exists()
    assert sorted(p.name for p in tmp_path.glob(".smoke.*")) == [foreign.name]

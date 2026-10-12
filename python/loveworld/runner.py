"""Run an experiment into a results directory, safely, the same way from the CLI and the API.

Every run first repairs any swap an earlier run left interrupted next to its target, then
validates the target: it must be missing, empty, or an existing LoveWorld results directory
(then `overwrite` must be true). The engine runs into a sibling temporary directory and the
result is swapped into place only on success, under a per-target lock.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from loveworld import analysis
from loveworld import engine as eng
from loveworld.experiment import AnalysisSettings, Experiment, build_engine_config


class TargetError(ValueError):
    """The results directory cannot be used."""


def is_results_dir(path: Path) -> bool:
    """Tell whether the directory holds a LoveWorld engine manifest."""
    manifest = path / "manifest.json"
    if not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text())
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("engine") == "loveworld-engine"


def is_twins_dir(path: Path) -> bool:
    """Tell whether the directory holds a twins run (control and treatment children)."""
    return is_results_dir(path / "control") and is_results_dir(path / "treatment")


def check_target(target: Path, overwrite: bool) -> None:
    """Refuse targets that are not ours to replace."""
    if target.exists() and not target.is_dir():
        raise TargetError(f"{target} exists and is not a directory")
    if not target.exists():
        return
    if any(p.name != SWAP_MARKER for p in target.iterdir()):
        if not (is_results_dir(target) or is_twins_dir(target)):
            raise TargetError(f"{target} is not empty and is not a LoveWorld results directory; refusing to touch it")
        if not overwrite:
            raise TargetError(f"{target} exists; pass overwrite to replace it")


SWAP_MARKER = eng.SWAP_MARKER


def _swap_in(tmp: Path, target: Path) -> None:
    """Replace `target` with `tmp` in two renames, leaving a recoverable trail.

    A directory cannot be replaced in one atomic rename on POSIX, so the sequence is:
    write a marker (`SWAP_MARKER`, naming the target and the staging dir) into the current
    target, rename the target to a free hidden `.<name>.old-<pid>[-<n>]` sibling, rename the
    staging dir into place, then delete that sibling. A crash between the two renames leaves
    the sibling with its marker and no live target; `recover_swaps` renames it back. A crash
    after the second rename leaves a sibling next to a live target, which `recover_swaps`
    deletes. Nothing that already exists is ever deleted here: an occupied `.old-` name is
    skipped, not reused, so a stranded copy of earlier results survives until it is reconciled.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        os.rename(tmp, target)
        return
    old = _free_sibling(target, f".{target.name}.old-{os.getpid()}")
    marker = {"state": "replacing", "target": target.name, "staging": str(tmp), "pid": os.getpid()}
    (target / SWAP_MARKER).write_text(json.dumps(marker))
    os.rename(target, old)
    try:
        os.rename(tmp, target)
    except OSError:
        os.rename(old, target)
        (target / SWAP_MARKER).unlink(missing_ok=True)
        raise
    shutil.rmtree(old, ignore_errors=True)


def _swap_in_pair(first_tmp: Path, first: Path, second_tmp: Path, second: Path) -> None:
    """Publish two staged directories together: `first` (the twins), then `second` (the run).

    The earlier `first` is kept aside, marked the way `_swap_in` marks it, until `second` is in place,
    so a failure while publishing `second` takes the new `first` out and puts the earlier one back, and
    both targets stay as they were.
    """
    first.parent.mkdir(parents=True, exist_ok=True)
    kept: Path | None = None
    if first.exists():
        kept = _free_sibling(first, f".{first.name}.old-{os.getpid()}")
        marker = {"state": "replacing", "target": first.name, "staging": str(first_tmp), "pid": os.getpid()}
        (first / SWAP_MARKER).write_text(json.dumps(marker))
        os.rename(first, kept)

    def put_back() -> None:
        if kept is not None:
            os.rename(kept, first)
            (first / SWAP_MARKER).unlink(missing_ok=True)

    try:
        os.rename(first_tmp, first)
    except OSError:
        put_back()
        raise
    try:
        _swap_in(second_tmp, second)
    except BaseException:
        shutil.rmtree(first, ignore_errors=True)
        put_back()
        raise
    if kept is not None:
        shutil.rmtree(kept, ignore_errors=True)


def _free_sibling(target: Path, stem: str) -> Path:
    """Return the first of `stem`, `stem-1`, `stem-2`, ... that does not exist next to `target`."""
    candidate = target.parent / stem
    n = 0
    while candidate.exists() or candidate.is_symlink():
        n += 1
        candidate = target.parent / f"{stem}-{n}"
    return candidate


def _lock_path(target: Path) -> Path:
    return target.parent / f".{target.name}.lock"


def recover_swaps(root: Path, name: str | None = None) -> list[Path]:
    """Repair interrupted swaps under `root`; return the targets restored or cleaned.

    Only hidden `.<name>.old-*` directories carrying our marker are touched, and only when no
    run holds that target's lock (a locked name is mid-swap, not stranded). With `name`, only
    that target's leftovers are reconciled. A leftover whose target is missing is renamed back
    into place; one whose target exists again is a superseded copy and is removed.
    """
    touched: list[Path] = []
    pattern = f".{name}.old-*" if name else ".*.old-*"
    for old in sorted(Path(root).glob(pattern)):
        marker_path = old / SWAP_MARKER
        if not old.is_dir() or old.is_symlink() or not marker_path.is_file():
            continue
        try:
            marker = json.loads(marker_path.read_text())
        except (OSError, ValueError):
            continue
        target_name = str(marker.get("target") or "")
        if not target_name or "/" in target_name or target_name.startswith("."):
            continue
        if name is not None and target_name != name:
            continue
        target = Path(root) / target_name
        if _lock_path(target).exists():
            continue
        try:
            if target.exists():
                shutil.rmtree(old)
            else:
                os.rename(old, target)
                (target / SWAP_MARKER).unlink(missing_ok=True)
        except OSError:
            continue
        touched.append(target)
    return touched


class _TargetLock:
    """An exclusive per-target lock held from validation through publication.

    Two concurrent runs with the same name could otherwise both pass `check_target` and then
    swap their staging directories one after the other, the second silently replacing the
    first. The lock is a sibling file created with O_EXCL; a stale lock from a crashed process
    is reported rather than stolen.
    """

    def __init__(self, target: Path) -> None:
        self.path = _lock_path(target)
        self.fd: int | None = None

    def __enter__(self) -> _TargetLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError as exc:
            raise TargetError(
                f"{self.path.name} exists: another run is publishing this target (remove it if stale)"
            ) from exc
        os.write(self.fd, str(os.getpid()).encode())
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.path.unlink(missing_ok=True)


def _staging_dir(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=target.parent))


def run_experiment(
    exp: Experiment,
    target: Path,
    overwrite: bool = False,
    placebo: bool = False,
    extra_files: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the engine and the analysis for an experiment into `target`; return the summary.

    `extra_files` maps a file name to a JSON value written beside summary.json before publication,
    so a record such as translation.json appears with the run or not at all.
    """
    cfg = build_engine_config(exp, placebo=placebo)
    return run_config(cfg, target, exp.analysis, overwrite=overwrite, extra_files=extra_files)


ExtraFromRun = Callable[[Path], dict[str, Any]]


def run_config(
    cfg: dict[str, Any],
    target: Path,
    settings: AnalysisSettings,
    overwrite: bool = False,
    extra_files: dict[str, Any] | None = None,
    extra_from_run: ExtraFromRun | None = None,
) -> dict[str, Any]:
    """Run a complete engine config and its analysis into `target`, published only on success.

    `extra_from_run` is called with the finished but unpublished run directory and returns more
    files to write beside summary.json, for records computed from the run itself (a forked world's
    comparison with its parent). Every extra file lands with the run or not at all.
    """
    eng.require_engine()
    recover_swaps(target.parent)
    with _TargetLock(target):
        recover_swaps(target.parent, target.name)
        check_target(target, overwrite)
        staging = _staging_dir(target)
        try:
            run_dir = staging / "run"
            eng.run_engine(cfg, run_dir, overwrite=True)
            summary = analysis.write_summary(run_dir, settings, link_from=target)
            _write_extra_files(run_dir, extra_files, extra_from_run)
            _swap_in(run_dir, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return summary


def _write_extra_files(run_dir: Path, extra_files: dict[str, Any] | None, extra_from_run: ExtraFromRun | None) -> None:
    """Write the extra records beside summary.json in the unpublished run, so they land with it or not at all."""
    files = dict(extra_files or {})
    if extra_from_run is not None:
        files.update(extra_from_run(run_dir))
    for file_name, value in files.items():
        reserved = ("manifest.json", "config.json", "summary.json")
        if "/" in file_name or file_name.startswith(".") or file_name in reserved:
            raise ValueError(f"extra file name {file_name!r} is not allowed")
        (run_dir / file_name).write_text(json.dumps(value, indent=2, sort_keys=True))


def twins_dir_for(target: Path) -> Path:
    """Where a run's twins live: the `<name>-twins` sibling that the API and the summary look for."""
    return target.parent / f"{target.name}-twins"


def run_twins(exp: Experiment, target: Path, overwrite: bool = False) -> dict[str, Any]:
    """Run every couple under both arms on identical seeds into `target`/{control,treatment}."""
    eng.require_engine()
    cfg = build_engine_config(exp)
    recover_swaps(target.parent)
    with _TargetLock(target):
        recover_swaps(target.parent, target.name)
        check_target(target, overwrite)
        staging = _staging_dir(target)
        try:
            run_dir = staging / "run"
            for arm in ("control", "treatment"):
                eng.run_engine(cfg, run_dir / arm, overwrite=True, arm_override=arm, name=f"{exp.name}-twins-{arm}")
            summary = analysis.twins_summary(run_dir, exp.analysis)
            _swap_in(run_dir, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return summary


def _twins_link(dir_name: str, twins: dict[str, Any]) -> dict[str, Any]:
    """Return the `governance.twins` block for twins published as `dir_name`, shaped as link_governance writes it."""
    return {
        "path": dir_name,
        "paired": twins.get("paired", []),
        "runs": twins.get("runs", {}),
        "identical_parameters": twins.get("identical_parameters"),
        "dynamics_hashes_equal": twins.get("dynamics_hashes_equal"),
    }


def run_with_twins(
    cfg: dict[str, Any],
    target: Path,
    settings: AnalysisSettings,
    overwrite: bool = False,
    extra_files: dict[str, Any] | None = None,
    extra_from_run: ExtraFromRun | None = None,
) -> dict[str, Any]:
    """Run a config and its twins, and publish both or neither; return the run's summary.

    The twins (every couple under both arms on the run's own seeds) and the run are simulated and
    analysed side by side in one staging directory, under both targets' locks, and the run's summary
    links these twins. Only when everything has succeeded are the two published together (twins first,
    then the run), and a failure at any step leaves both targets as they were, so an overwrite that
    fails keeps the earlier run with its own twins.
    """
    eng.require_engine()
    twins = twins_dir_for(target)
    name = str(cfg.get("name") or target.name)
    recover_swaps(target.parent)
    with _TargetLock(target), _TargetLock(twins):
        recover_swaps(target.parent, target.name)
        recover_swaps(target.parent, twins.name)
        check_target(target, overwrite)
        check_target(twins, overwrite)
        staging = _staging_dir(target)
        try:
            twins_dir = staging / "twins"
            for arm in ("control", "treatment"):
                eng.run_engine(cfg, twins_dir / arm, overwrite=True, arm_override=arm, name=f"{name}-twins-{arm}")
            twins_summary = analysis.twins_summary(twins_dir, settings)
            run_dir = staging / "run"
            eng.run_engine(cfg, run_dir, overwrite=True)
            summary = analysis.write_summary(run_dir, settings, link_from=target)
            # The twins are not in place yet, so the summary links these ones, not whatever sits there now.
            summary["governance"]["twins"] = _twins_link(twins.name, twins_summary)
            summary = analysis.write_json(run_dir / "summary.json", summary)
            _write_extra_files(run_dir, extra_files, extra_from_run)
            _swap_in_pair(twins_dir, twins, run_dir, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return summary

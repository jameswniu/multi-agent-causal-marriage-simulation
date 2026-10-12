"""Locate and drive the Rust simulation engine."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


class EngineError(RuntimeError):
    """The engine binary is missing or a command failed."""


def engine_path() -> Path:
    """Return the engine binary path (env LOVEWORLD_ENGINE overrides the default)."""
    override = os.environ.get("LOVEWORLD_ENGINE")
    if override:
        return Path(override)
    return REPO_ROOT / "target" / "release" / "loveworld-engine"


def require_engine() -> Path:
    """Return the engine path or raise with a build hint."""
    path = engine_path()
    if not path.exists():
        raise EngineError(f"engine binary not found at {path}; run `loveworld build-engine` (cargo build --release)")
    return path


def build_engine() -> Path:
    """Build the engine with cargo and return the binary path."""
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / "cargo")
    subprocess.run([cargo, "build", "--release"], cwd=REPO_ROOT, check=True)
    return require_engine()


DEFAULT_TIMEOUT_S = 120.0
"""Seconds an engine command may run before it is stopped (env LOVEWORLD_ENGINE_TIMEOUT overrides)."""


def engine_timeout() -> float:
    """Return the engine timeout in seconds: LOVEWORLD_ENGINE_TIMEOUT when set and positive, else the default."""
    raw = os.environ.get("LOVEWORLD_ENGINE_TIMEOUT")
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = 0.0
        if value > 0:
            return value
    return DEFAULT_TIMEOUT_S


def _run(
    args: list[str],
    stdin: str | None = None,
    timeout: float | None = None,
    out_dir: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run one engine command; stop it, clean up after it and raise if it outlives the timeout.

    A stopped engine cannot remove its own staging directory or its target lock, so both are
    removed here, and only the ones named with the stopped process's id.
    """
    limit = engine_timeout() if timeout is None else timeout
    cmd = [str(require_engine()), *args]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, stderr = proc.communicate(input=stdin, timeout=limit)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        if out_dir is not None:
            _clean_after_stopped_run(Path(out_dir), proc.pid)
        raise EngineError(f"loveworld-engine {args[0]} timed out after {limit:g} s and was stopped") from None
    if proc.returncode != 0:
        raise EngineError(f"loveworld-engine {' '.join(args)} failed ({proc.returncode}):\n{stderr.strip()}")
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


SWAP_MARKER = ".loveworld-swap.json"
"""Marker a results directory carries while it is renamed aside; shared with the runner and the engine."""


def _clean_after_stopped_run(out_dir: Path, pid: int) -> None:
    """Undo what a stopped engine process left beside `out_dir`, touching only names carrying its pid.

    Its staging directories go, its lock goes when the lock holds its pid, and results it had
    renamed aside mid-publication are put back when nothing replaced them, or removed when the
    new run had already landed.
    """
    parent, name = out_dir.parent, out_dir.name
    for tmp in parent.glob(f".{name}.tmp-{pid}-*"):
        if tmp.is_dir() and not tmp.is_symlink():
            shutil.rmtree(tmp, ignore_errors=True)
    for old in sorted(parent.glob(f".{name}.old-{pid}-*")):
        if not old.is_dir() or old.is_symlink() or not (old / SWAP_MARKER).is_file():
            continue
        try:
            if out_dir.exists():
                shutil.rmtree(old)
            else:
                os.rename(old, out_dir)
                (out_dir / SWAP_MARKER).unlink(missing_ok=True)
        except OSError:
            continue
    lock = parent / f".{name}.lock"
    try:
        if lock.is_file() and lock.read_text().strip() == str(pid):
            lock.unlink()
    except OSError:
        pass


def default_config() -> dict[str, Any]:
    """Return the engine's default config with every parameter."""
    return dict(json.loads(_run(["default-config"]).stdout))


def policy_spec(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the policy weights and formulas for a config (defaults when None)."""
    if config is None:
        return dict(json.loads(_run(["policy-spec"]).stdout))
    return dict(json.loads(_run(["policy-spec", "--config", "-"], stdin=json.dumps(config)).stdout))


def shock_catalog() -> list[dict[str, Any]]:
    """Return the engine's shock kinds with their bounds, defaults and default lengths."""
    return list(json.loads(_run(["shock-catalog"]).stdout))


def effect_catalog() -> dict[str, Any]:
    """Return the engine's effect channels for custom shocks, with their bounds per cadence."""
    return dict(json.loads(_run(["effect-catalog"]).stdout))


def assign(config: dict[str, Any]) -> list[str]:
    """Arm per couple id for a config, straight from the engine."""
    return list(json.loads(_run(["assign", "--config", "-"], stdin=json.dumps(config)).stdout))


def run_engine(
    config: dict[str, Any],
    out_dir: Path,
    overwrite: bool = False,
    arm_override: str | None = None,
    name: str | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Run one simulation and return its manifest; the run is stopped after `timeout` seconds."""
    args = ["run", "--config", "-", "--out", str(out_dir)]
    if overwrite:
        args.append("--overwrite")
    if arm_override:
        args += ["--arm-override", arm_override]
    if name:
        args += ["--name", name]
    _run(args, stdin=json.dumps(config), timeout=timeout, out_dir=Path(out_dir))
    return dict(json.loads((Path(out_dir) / "manifest.json").read_text()))


def replay(results_dir: Path, out_dir: Path | None = None, timeout: float | None = None) -> bool:
    """Re-run a results directory's manifest and report whether every table hash matched.

    A replay that outlives the timeout is stopped, what it left beside its output is cleaned up,
    and it raises, since a stopped replay says nothing about the hashes.
    """
    manifest = Path(results_dir) / "manifest.json"
    if not manifest.exists():
        raise EngineError(f"no manifest.json in {results_dir}")
    target = Path(out_dir) if out_dir else Path(tempfile.mkdtemp(prefix="loveworld-replay-"))
    limit = engine_timeout() if timeout is None else timeout
    proc = subprocess.Popen(
        [str(require_engine()), "replay", "--manifest", str(manifest), "--out", str(target)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        proc.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        _clean_after_stopped_run(target, proc.pid)
        raise EngineError(f"loveworld-engine replay timed out after {limit:g} s and was stopped") from None
    finally:
        if out_dir is None:
            shutil.rmtree(target, ignore_errors=True)
    return proc.returncode == 0

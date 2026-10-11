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


def _run(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run([str(require_engine()), *args], input=stdin, capture_output=True, text=True)
    if proc.returncode != 0:
        raise EngineError(f"loveworld-engine {' '.join(args)} failed ({proc.returncode}):\n{proc.stderr.strip()}")
    return proc


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


def assign(config: dict[str, Any]) -> list[str]:
    """Arm per couple id for a config, straight from the engine."""
    return list(json.loads(_run(["assign", "--config", "-"], stdin=json.dumps(config)).stdout))


def run_engine(
    config: dict[str, Any],
    out_dir: Path,
    overwrite: bool = False,
    arm_override: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Run one simulation and return its manifest."""
    args = ["run", "--config", "-", "--out", str(out_dir)]
    if overwrite:
        args.append("--overwrite")
    if arm_override:
        args += ["--arm-override", arm_override]
    if name:
        args += ["--name", name]
    _run(args, stdin=json.dumps(config))
    return dict(json.loads((Path(out_dir) / "manifest.json").read_text()))


def replay(results_dir: Path, out_dir: Path | None = None) -> bool:
    """Re-run a results directory's manifest and report whether every table hash matched."""
    manifest = Path(results_dir) / "manifest.json"
    if not manifest.exists():
        raise EngineError(f"no manifest.json in {results_dir}")
    target = Path(out_dir) if out_dir else Path(tempfile.mkdtemp(prefix="loveworld-replay-"))
    proc = subprocess.run(
        [str(require_engine()), "replay", "--manifest", str(manifest), "--out", str(target)],
        capture_output=True,
        text=True,
    )
    if out_dir is None:
        shutil.rmtree(target, ignore_errors=True)
    return proc.returncode == 0

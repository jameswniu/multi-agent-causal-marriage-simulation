from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from loveworld import analysis, runner
from loveworld import engine as eng
from loveworld.experiment import load_experiment

REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = REPO / "experiments"


def _require_engine() -> None:
    if not eng.engine_path().exists():
        pytest.skip(f"engine binary missing at {eng.engine_path()}; run `loveworld build-engine`")


@pytest.fixture(scope="session")
def engine_ready() -> None:
    _require_engine()


@pytest.fixture(scope="session")
def defaults(engine_ready: None) -> dict:
    return eng.default_config()


@pytest.fixture(scope="session")
def results_root(tmp_path_factory: pytest.TempPathFactory, engine_ready: None, defaults: dict) -> Path:
    """A results root holding the smoke experiment, its twins run, and a second tiny experiment."""
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    root = tmp_path_factory.mktemp("results")
    runner.run_twins(exp, root / f"{exp.name}-twins")
    runner.run_experiment(exp, root / exp.name)
    second = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    second.name = "zeta"
    second.days = 30
    runner.run_experiment(second, root / "zeta")
    return root


@pytest.fixture(scope="session")
def smoke_results(results_root: Path) -> Path:
    """The smoke experiment's results dir (twins run next to it, governance linked)."""
    return results_root / "smoke"


@pytest.fixture(scope="session")
def lonely_results(tmp_path_factory: pytest.TempPathFactory, engine_ready: None, defaults: dict) -> Path:
    """A results dir with no twins run next to it."""
    exp = load_experiment(EXPERIMENTS / "smoke.yaml", defaults)
    out = tmp_path_factory.mktemp("lonely") / exp.name
    runner.run_experiment(exp, out)
    assert analysis.load_tables(out).manifest["name"] == "smoke"
    return out


@pytest.fixture
def fresh_dir(tmp_path: Path) -> Path:
    d = tmp_path / "r"
    if d.exists():
        shutil.rmtree(d)
    return d

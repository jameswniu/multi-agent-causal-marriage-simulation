from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from loveworld.cli import app

from .conftest import EXPERIMENTS

runner = CliRunner()


def test_cli_run_replay_analyze(engine_ready: None, tmp_path: Path) -> None:
    out = tmp_path / "smoke"
    r = runner.invoke(app, ["run", str(EXPERIMENTS / "smoke.yaml"), "--out", str(out)])
    assert r.exit_code == 0, r.output
    assert "Outcome" in r.output and "divorce_rate" in r.output and "simulation" in r.output
    assert "Inference unit: couple" in r.output
    assert (out / "summary.json").exists()
    r = runner.invoke(app, ["run", str(EXPERIMENTS / "smoke.yaml"), "--out", str(out)])
    assert r.exit_code != 0
    r = runner.invoke(app, ["run", str(EXPERIMENTS / "smoke.yaml"), "--out", str(out), "--overwrite"])
    assert r.exit_code == 0, r.output
    r = runner.invoke(app, ["replay", str(out)])
    assert r.exit_code == 0 and "PASS" in r.output
    r = runner.invoke(app, ["analyze", str(out), "--n-boot", "50", "--n-perm", "50"])
    assert r.exit_code == 0, r.output
    assert json.loads((out / "summary.json").read_text())["analysis"]["n_boot"] == 50
    r = runner.invoke(app, ["analyze", str(out), "--n-boot", "-1"])
    assert r.exit_code != 0


def test_cli_placebo_and_twins_link_into_governance(engine_ready: None, tmp_path: Path) -> None:
    base = tmp_path / "smoke"
    r = runner.invoke(app, ["placebo", str(EXPERIMENTS / "smoke.yaml"), "--out", str(tmp_path / "smoke-placebo")])
    assert r.exit_code == 0, r.output
    assert "Intervention: none" in r.output
    r = runner.invoke(app, ["twins", str(EXPERIMENTS / "smoke.yaml"), "--out", str(tmp_path / "smoke-twins")])
    assert r.exit_code == 0, r.output
    assert "Identical parameters: False" in r.output
    r = runner.invoke(app, ["run", str(EXPERIMENTS / "smoke.yaml"), "--out", str(base)])
    assert r.exit_code == 0, r.output
    s = json.loads((base / "summary.json").read_text())
    assert s["governance"]["placebo"] is not None and s["governance"]["twins"] is not None
    assert s["governance"]["twins"]["paired"][0]["name"] == "divorce_rate"
    assert s["governance"]["placebo"]["outcomes"][0]["name"] == "divorce_rate"


def test_cli_rejects_bad_experiment(engine_ready: None, tmp_path: Path) -> None:
    p = tmp_path / "bad.yaml"
    p.write_text("name: bad\nn_couples: 5\ndays: 5\nengine:\n  shocks: []\n")
    r = runner.invoke(app, ["run", str(p), "--out", str(tmp_path / "bad")])
    assert r.exit_code != 0 and "engine.shocks" in r.output


def test_cli_policy_spec(engine_ready: None) -> None:
    r = runner.invoke(app, ["policy-spec"])
    assert r.exit_code == 0, r.output
    assert "never_sees" in r.output


def test_cli_demo_and_static_build_the_read_only_site(engine_ready: None, tmp_path: Path) -> None:
    from .test_demo import _job_loss_demo, _write

    root = tmp_path / "results"
    for args in (
        ["twins", str(EXPERIMENTS / "smoke.yaml"), "--out", str(root / "smoke-twins")],
        ["run", str(EXPERIMENTS / "smoke.yaml"), "--out", str(root / "smoke")],
    ):
        r = runner.invoke(app, args)
        assert r.exit_code == 0, r.output
    demo_dir = tmp_path / "demo"
    _write(demo_dir, "hard-times", _job_loss_demo("demo-hard-times"))
    site = tmp_path / "site"
    # Exporting before the demo world exists says to make it.
    r = runner.invoke(
        app, ["static", str(root), "--site", str(site), "--default", "smoke", "--demo-dir", str(demo_dir)]
    )
    assert r.exit_code == 1 and "run make demo" in r.output
    r = runner.invoke(app, ["demo", str(root), "--demo-dir", str(demo_dir)])
    assert r.exit_code == 0, r.output
    assert "demo-hard-times: forked from smoke, hits treatment" in r.output
    r = runner.invoke(app, ["demo", str(root), "--demo-dir", str(demo_dir), "--only", "demo-nope"])
    assert r.exit_code != 0 and "no demo file names demo-nope" in r.output
    r = runner.invoke(
        app, ["static", str(root), "--site", str(site), "--default", "smoke", "--demo-dir", str(demo_dir)]
    )
    assert r.exit_code == 0, r.output
    assert "MB gzipped" in r.output and (site / "data" / "index.json.gz").is_file()

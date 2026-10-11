"""Command line interface: run, analyze, placebo, twins, replay, serve, build-engine, policy-spec."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from loveworld import analysis, runner
from loveworld import engine as eng
from loveworld.experiment import (
    AnalysisSettings,
    ExperimentError,
    build_engine_config,
    default_results_dir,
    load_experiment,
)

app = typer.Typer(
    help="LoveWorld experiments: run the engine, estimate effects, serve the dashboard.", no_args_is_help=True
)


def _fmt(x: Any, digits: int = 3) -> str:
    if x is None:
        return "n/a"
    if isinstance(x, float):
        return f"{x:.{digits}f}"
    return str(x)


def print_outcomes(summary: dict[str, Any]) -> None:
    """Print the outcomes table in a compact fixed-width layout."""
    exp = summary.get("experiment", {})
    tr = exp.get("treatment", {})
    scale = f"{exp.get('n_couples')} couples x {exp.get('days')} days"
    typer.echo(f"Experiment {exp.get('name')}: {scale}; evidence class {summary.get('evidence_class')}")
    if tr.get("parameter") in (None, "none"):
        typer.echo("Intervention: none (arms share every memory parameter)")
    else:
        control, treatment = tr.get("control_value"), tr.get("treatment_value")
        typer.echo(f"Intervention: {tr.get('parameter')} control {control} vs treatment {treatment}")
    for shock in exp.get("shocks") or []:
        end = shock.get("end_day")
        window = f"day {shock.get('start_day')} to {end if end is not None else 'end'}"
        who = f"{shock.get('kind')} on {shock.get('target')} ({shock.get('member')})"
        typer.echo(f"Shock: {who}, {window}, magnitude {shock.get('magnitude')}")
    unit = summary.get("analysis", {}).get("inference_unit")
    if unit:
        typer.echo(f"Inference unit: {unit}")
    header = f"{'Outcome':<26} {'Control':>9} {'Treatment':>10} {'ATE':>9} {'95% CI':>19} {'P':>7}  {'Note':<12}"
    typer.echo(header)
    typer.echo("-" * len(header))
    for o in summary.get("outcomes", []):
        ci = f"[{_fmt(o['ci_low'])}, {_fmt(o['ci_high'])}]"
        note = "Conditional" if o.get("conditional_on_post_treatment") else ""
        cells = [
            f"{o['name']:<26}",
            f"{_fmt(o['control_mean']):>9}",
            f"{_fmt(o['treatment_mean']):>10}",
            f"{_fmt(o['ate']):>9}",
            f"{ci:>19}",
            f"{_fmt(o['p_permutation']):>7}",
            f" {note:<12}",
        ]
        typer.echo(" ".join(cells))
    typer.echo(summary.get("disclaimer", ""))


def _load(experiment: Path) -> Any:
    try:
        return load_experiment(experiment)
    except ExperimentError as e:
        raise typer.BadParameter(str(e)) from e


@app.command()
def run(
    experiment: Path = typer.Argument(..., help="Experiment YAML"),
    out: Path | None = typer.Option(None, help="Results directory (default results/<name>)"),
    overwrite: bool = typer.Option(False, help="Replace an existing results directory"),
) -> None:
    """Run the engine for an experiment, then analyse the results."""
    exp = _load(experiment)
    target = out or default_results_dir(exp)
    try:
        summary = runner.run_experiment(exp, target, overwrite=overwrite)
    except runner.TargetError as e:
        raise typer.BadParameter(str(e)) from e
    print_outcomes(summary)
    typer.echo(f"Results: {target}")


@app.command()
def analyze(
    results_dir: Path = typer.Argument(..., help="A results directory written by `run`"),
    n_boot: int = typer.Option(2000),
    n_perm: int = typer.Option(2000),
    seed: int = typer.Option(7),
) -> None:
    """Write summary.json for a results directory and print the outcomes table."""
    try:
        settings = AnalysisSettings(n_boot=n_boot, n_perm=n_perm, seed=seed)
    except ExperimentError as e:
        raise typer.BadParameter(str(e)) from e
    summary = analysis.write_summary(results_dir, settings)
    print_outcomes(summary)


@app.command()
def placebo(
    experiment: Path = typer.Argument(..., help="Experiment YAML"),
    out: Path | None = typer.Option(None, help="Results directory (default results/<name>-placebo)"),
    overwrite: bool = typer.Option(False),
) -> None:
    """Run the experiment with the intervention removed (the effect should be null)."""
    exp = _load(experiment)
    target = out or default_results_dir(exp, "-placebo")
    try:
        summary = runner.run_experiment(exp, target, overwrite=overwrite, placebo=True)
    except runner.TargetError as e:
        raise typer.BadParameter(str(e)) from e
    print_outcomes(summary)
    typer.echo(f"Results: {target}")


@app.command()
def twins(
    experiment: Path = typer.Argument(..., help="Experiment YAML"),
    out: Path | None = typer.Option(None, help="Results directory (default results/<name>-twins)"),
    overwrite: bool = typer.Option(False),
) -> None:
    """Simulate every couple under both arms on identical seeds and report paired effects."""
    exp = _load(experiment)
    target = out or default_results_dir(exp, "-twins")
    try:
        summary = runner.run_twins(exp, target, overwrite=overwrite)
    except runner.TargetError as e:
        raise typer.BadParameter(str(e)) from e
    typer.echo(f"{'Outcome':<20} {'Mean diff':>10} {'95% CI':>21} {'Pairs':>6} {'Changed':>8}")
    for p in summary["paired"]:
        ci = f"[{_fmt(p['ci_low'])}, {_fmt(p['ci_high'])}]"
        typer.echo(
            f"{p['name']:<20} {_fmt(p['mean_diff']):>10} {ci:>21} {p['n_pairs']:>6} {_fmt(p['share_changed']):>8}"
        )
    typer.echo(
        f"Identical parameters: {summary['identical_parameters']}; "
        f"dynamics tables identical: {summary['dynamics_hashes_equal']}"
    )
    typer.echo(f"Results: {target}")


@app.command()
def replay(results_dir: Path = typer.Argument(..., help="A results directory with manifest.json")) -> None:
    """Re-run a results directory's config and verify every table hash (exit 1 on mismatch)."""
    ok = eng.replay(results_dir)
    typer.echo(f"Replay {'PASS' if ok else 'FAIL'}: {results_dir}")
    if not ok:
        raise typer.Exit(code=1)


@app.command()
def serve(
    results_dir: Path = typer.Argument(..., help="A results directory, or a directory of them"),
    host: str = typer.Option("127.0.0.1"),
    port: int = typer.Option(8765),
) -> None:
    """Serve the API and the built dashboard for one experiment or a whole results root."""
    import uvicorn

    from loveworld.api import create_app

    uvicorn.run(create_app(results_dir), host=host, port=port)


@app.command("build-engine")
def build_engine() -> None:
    """Build the Rust engine (cargo build --release)."""
    path = eng.build_engine()
    typer.echo(f"Engine: {path}")


@app.command("policy-spec")
def policy_spec_cmd(experiment: Path | None = typer.Argument(None, help="Experiment YAML (optional)")) -> None:
    """Print the decision policy's weights and formulas."""
    cfg = build_engine_config(_load(experiment)) if experiment else None
    typer.echo(json.dumps(eng.policy_spec(cfg), indent=2))


if __name__ == "__main__":
    app()

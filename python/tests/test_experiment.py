from __future__ import annotations

from pathlib import Path

import pytest

from loveworld.experiment import (
    AnalysisSettings,
    ExperimentError,
    build_engine_config,
    load_experiment,
    parse_experiment,
)
from loveworld.schema import SHOCK_CATALOG

from .conftest import EXPERIMENTS


def _raw(**over: object) -> dict:
    base: dict = {"name": "t", "n_couples": 20, "days": 100, "treatment": {"conflict_half_life_days": 90}}
    base.update(over)
    return base


def test_example_and_smoke_parse(defaults: dict) -> None:
    for name in ("example.yaml", "smoke.yaml"):
        exp = load_experiment(EXPERIMENTS / name, defaults)
        cfg = build_engine_config(exp, defaults)
        assert cfg["memory"]["treatment"]["conflict_half_life_days"] == 90.0
        assert cfg["shocks"] == []


@pytest.mark.parametrize(
    "raw, needle",
    [
        (_raw(bogus=1), "experiment.bogus"),
        (_raw(seeds={"population": 1, "dynamic": 2}), "seeds.dynamic"),
        (_raw(analysis={"n_boot": 10, "boots": 2}), "analysis.boots"),
        (_raw(control={"half_life": 3}), "control.half_life"),
        (_raw(treatment={"conflict_half_life_days": 90, "nope": 1}), "treatment.nope"),
        (_raw(world={"shock": []}), "world.shock"),
        (_raw(engine={"dynamics": {"onset_intercept": -4, "onset_intercpt": 1}}), "engine.dynamics.onset_intercpt"),
        (_raw(engine={"polcy": {}}), "engine.polcy"),
        (_raw(engine={"memory": {"control": {"conflict_half_life_days": 5}}}), "engine.memory"),
        (_raw(engine={"memory": {"prune_threshold": 0.5}}), "engine.memory"),
        (_raw(analysis={"seed": -1}), "analysis.seed"),
        (_raw(engine={"shocks": []}), "engine.shocks"),
        (_raw(engine={"arm_override": "control"}), "engine.arm_override"),
        (_raw(name="bad name!"), "name"),
        (_raw(analysis={"ci_level": 1.0}), "ci_level"),
        (_raw(analysis={"n_boot": -1}), "n_boot"),
        (_raw(n_couples=0), "n_couples"),
    ],
)
def test_unknown_or_invalid_keys_raise_with_path(defaults: dict, raw: dict, needle: str) -> None:
    with pytest.raises(ExperimentError) as err:
        parse_experiment(raw, defaults)
    assert needle in str(err.value)


def test_engine_overrides_must_match_default_shape(defaults: dict) -> None:
    with pytest.raises(ExperimentError):
        parse_experiment(_raw(engine={"dynamics": 3}), defaults)
    with pytest.raises(ExperimentError):
        parse_experiment(_raw(engine={"n_couples": {"a": 1}}), defaults)
    exp = parse_experiment(
        _raw(engine={"assignment": {"mode": "block", "block_size": 5}, "policy": {"leave_network": 1.0}}), defaults
    )
    cfg = build_engine_config(exp, defaults)
    assert cfg["assignment"]["mode"] == "block" and cfg["policy"]["leave_network"] == 1.0


def test_shocks_are_validated_and_targeted(defaults: dict) -> None:
    raw = _raw(
        treatment={"shocks": [{"kind": "job_loss", "member": "a", "start_day": 10, "end_day": 50, "magnitude": 1.5}]},
        world={"shocks": [{"kind": "anniversary", "start_day": 20}, {"kind": "temptation"}]},
    )
    exp = parse_experiment(raw, defaults)
    assert [s.target for s in exp.shocks] == ["treatment", "all", "all"]
    cfg = build_engine_config(exp, defaults)
    assert cfg["shocks"][0] == {
        "kind": "job_loss",
        "target": "treatment",
        "member": "a",
        "start_day": 10,
        "end_day": 50,
        "magnitude": 1.5,
    }
    assert (
        cfg["shocks"][1]["kind"] == "anniversary"
        and cfg["shocks"][1]["end_day"] is None
        and cfg["shocks"][1]["magnitude"] == 1.0
    )
    assert (
        cfg["shocks"][2]["start_day"] == 90 and cfg["shocks"][2]["end_day"] == 99
    )  # capped defaults inside a 100-day run
    # The memory intervention is empty here: a shock-only experiment is allowed.
    assert cfg["memory"]["treatment"] == cfg["memory"]["control"]
    placebo = build_engine_config(exp, defaults, placebo=True)
    assert [s["target"] for s in placebo["shocks"]] == ["all", "all"]


@pytest.mark.parametrize(
    "shock, needle",
    [
        ({"kind": "earthquake"}, "kind"),
        ({"kind": "job_loss", "member": "c"}, "member"),
        ({"kind": "job_loss", "start_day": 100}, "start_day"),
        ({"kind": "job_loss", "start_day": 50, "end_day": 40}, "end_day"),
        ({"kind": "job_loss", "start_day": 50, "end_day": 100}, "end_day"),
        ({"kind": "temptation", "magnitude": 1.5}, "magnitude"),
        ({"kind": "job_loss", "target": "control"}, "target"),
        ({"kind": "job_loss", "strength": 2}, "strength"),
    ],
)
def test_bad_shocks_raise(defaults: dict, shock: dict, needle: str) -> None:
    with pytest.raises(ExperimentError) as err:
        parse_experiment(_raw(treatment={"shocks": [shock]}), defaults)
    assert needle in str(err.value) and "treatment.shocks[0]" in str(err.value)


def test_default_end_day_is_start_plus_catalog_length_clipped_to_the_run(defaults: dict) -> None:
    exp = parse_experiment(_raw(days=100, world={"shocks": [{"kind": "job_loss"}]}), defaults)
    assert exp.shocks[0].start_day == 90 and exp.shocks[0].end_day == 99
    exp = parse_experiment(_raw(days=400, world={"shocks": [{"kind": "job_loss", "start_day": 200}]}), defaults)
    assert exp.shocks[0].end_day == 320
    exp = parse_experiment(_raw(days=400, world={"shocks": [{"kind": "financial_crisis", "start_day": 300}]}), defaults)
    assert exp.shocks[0].end_day == 399
    exp = parse_experiment(_raw(days=400, world={"shocks": [{"kind": "daily_texts", "start_day": 200}]}), defaults)
    assert exp.shocks[0].end_day is None
    exp = parse_experiment(
        _raw(days=400, world={"shocks": [{"kind": "temptation", "start_day": 10, "end_day": None}]}), defaults
    )
    assert exp.shocks[0].end_day is None  # an explicit null means to the end of the run


def test_trait_shift_requires_a_trait_and_other_kinds_forbid_it(defaults: dict) -> None:
    with pytest.raises(ExperimentError) as err:
        parse_experiment(_raw(world={"shocks": [{"kind": "trait_shift"}]}), defaults)
    assert "trait" in str(err.value)
    with pytest.raises(ExperimentError):
        parse_experiment(_raw(world={"shocks": [{"kind": "trait_shift", "trait": "charm"}]}), defaults)
    with pytest.raises(ExperimentError):
        parse_experiment(_raw(world={"shocks": [{"kind": "job_loss", "trait": "openness"}]}), defaults)
    exp = parse_experiment(
        _raw(world={"shocks": [{"kind": "trait_shift", "trait": "openness", "magnitude": -0.2}]}), defaults
    )
    assert build_engine_config(exp, defaults)["shocks"][0]["trait"] == "openness"
    plain = parse_experiment(_raw(world={"shocks": [{"kind": "job_loss"}]}), defaults)
    assert "trait" not in build_engine_config(plain, defaults)["shocks"][0]


def test_python_catalog_matches_engine_catalog(engine_ready: None) -> None:
    from loveworld import engine as eng

    theirs = {k["kind"]: k for k in eng.shock_catalog()}
    ours = {k["kind"]: k for k in SHOCK_CATALOG}
    assert set(theirs) == set(ours)
    for kind, spec in theirs.items():
        mine = ours[kind]
        assert mine["magnitude"]["min"] == spec["min"], kind
        assert mine["magnitude"]["max"] == spec["max"], kind
        assert mine["magnitude"]["default"] == spec["default"], kind
        assert mine["default_length_days"] == spec["default_length_days"], kind
        assert mine["traits"] == list(spec.get("traits") or []), kind


def test_catalog_defaults_are_within_their_own_bounds() -> None:
    for spec in SHOCK_CATALOG:
        m = spec["magnitude"]
        assert m["min"] <= m["default"] <= m["max"]
        assert spec["default_end_day"] is None or spec["default_end_day"] >= spec["default_start_day"]


def test_analysis_settings_validation() -> None:
    with pytest.raises(ExperimentError):
        AnalysisSettings(ci_level=0.0)
    with pytest.raises(ExperimentError):
        AnalysisSettings(n_perm=-1)
    assert AnalysisSettings(ci_level=0.9).ci_level == 0.9


def test_yaml_file_round_trip(defaults: dict, tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    p.write_text("n_couples: 5\ndays: 10\nworld:\n  shocks:\n    - kind: date_nights\n      start_day: 2\n")
    exp = load_experiment(p, defaults)
    assert exp.name == "x" and exp.shocks[0].kind == "date_nights" and exp.shocks[0].target == "all"


def test_trait_shift_requires_a_known_trait() -> None:
    """trait_shift carries a trait; other kinds must not."""
    from loveworld.experiment import ExperimentError, parse_shock

    ok = parse_shock(
        {"kind": "trait_shift", "trait": "neuroticism", "magnitude": 0.3, "start_day": 0}, "treatment", 100, "t"
    )
    assert ok.to_engine()["trait"] == "neuroticism"
    import pytest

    with pytest.raises(ExperimentError):
        parse_shock({"kind": "trait_shift", "start_day": 0}, "treatment", 100, "t")
    with pytest.raises(ExperimentError):
        parse_shock({"kind": "trait_shift", "trait": "charm", "start_day": 0}, "treatment", 100, "t")
    with pytest.raises(ExperimentError):
        parse_shock({"kind": "job_loss", "trait": "neuroticism", "start_day": 0}, "treatment", 100, "t")
    assert "job_loss" not in ok.to_engine()["kind"]

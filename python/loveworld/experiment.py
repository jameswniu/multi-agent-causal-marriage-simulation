"""Experiment definition: YAML or request body, strict validation, engine config construction.

An experiment names ONE memory intervention plus optional shocks. The control arm's memory
parameters are the engine defaults merged with `control:`; the treatment arm's are the control
arm's merged with `treatment:`, so the arms differ in exactly the keys the experiment names.
`treatment.shocks` hit the treatment arm only, `world.shocks` hit everyone, and both flow into
the engine config's `shocks` list. `engine:` deep-merges over any other engine key, checked
against the engine's own default config so a misspelt key cannot be silently ignored.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from loveworld import engine as eng
from loveworld.schema import (
    ANALYSIS_KEYS,
    EXPERIMENT_KEYS,
    MEMORY_PARAMS,
    SAFE_NAME,
    SEED_KEYS,
    SHOCK_KEYS,
    SHOCK_KINDS,
    SHOCK_MEMBERS,
)


class ExperimentError(ValueError):
    """The experiment definition is invalid; the message names the offending key path."""


@dataclass
class AnalysisSettings:
    """Resampling settings for the analysis."""

    n_boot: int = 2000
    n_perm: int = 2000
    seed: int = 7
    ci_level: float = 0.95

    def __post_init__(self) -> None:
        """Reject impossible settings."""
        if not 0.0 < self.ci_level < 1.0:
            raise ExperimentError(f"analysis.ci_level must be strictly between 0 and 1, got {self.ci_level}")
        if self.n_boot < 0 or self.n_perm < 0:
            raise ExperimentError(
                f"analysis.n_boot and analysis.n_perm must not be negative, got {self.n_boot}, {self.n_perm}"
            )


@dataclass
class Shock:
    """One scheduled stressor, validated against the catalog and the run length."""

    kind: str
    target: str
    member: str
    start_day: int
    end_day: int | None
    magnitude: float
    trait: str | None = None

    def to_engine(self) -> dict[str, Any]:
        """Engine config entry."""
        out: dict[str, Any] = {
            "kind": self.kind,
            "target": self.target,
            "member": self.member,
            "start_day": self.start_day,
            "end_day": self.end_day,
            "magnitude": self.magnitude,
        }
        if self.trait is not None:
            out["trait"] = self.trait
        return out


@dataclass
class Experiment:
    """A parsed experiment."""

    name: str
    n_couples: int
    days: int
    seeds: dict[str, int]
    treatment: dict[str, float] = field(default_factory=dict)
    control: dict[str, float] = field(default_factory=dict)
    engine: dict[str, Any] = field(default_factory=dict)
    shocks: list[Shock] = field(default_factory=list)
    analysis: AnalysisSettings = field(default_factory=AnalysisSettings)
    source: Path | None = None

    @property
    def intervention(self) -> dict[str, float]:
        """The memory parameters the treatment arm changes."""
        return dict(self.treatment)


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Return base with override merged in recursively (override wins on leaves)."""
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _mapping(value: Any, path: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ExperimentError(f"{path} must be a mapping")
    return dict(value)


def _check_keys(section: dict[str, Any], allowed: tuple[str, ...], path: str) -> None:
    unknown = sorted(set(section) - set(allowed))
    if unknown:
        raise ExperimentError(f"unknown key {path}.{unknown[0]} (known: {', '.join(allowed)})")


def _int(value: Any, path: str, lo: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or int(value) != value:
        raise ExperimentError(f"{path} must be an integer, got {value!r}")
    v = int(value)
    if lo is not None and v < lo:
        raise ExperimentError(f"{path} must be at least {lo}, got {v}")
    return v


def _float(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ExperimentError(f"{path} must be a number, got {value!r}")
    return float(value)


def _memory_section(raw: Any, path: str) -> dict[str, float]:
    section = _mapping(raw, path)
    _check_keys(section, MEMORY_PARAMS, path)
    out = {}
    for k, v in section.items():
        out[k] = _float(v, f"{path}.{k}")
        if out[k] <= 0 and k != "load_saturation":
            raise ExperimentError(f"{path}.{k} must be positive, got {out[k]}")
    return out


def _check_engine_overrides(section: dict[str, Any], defaults: dict[str, Any], path: str) -> None:
    """Every key under engine: must exist in the engine's default config at the same depth."""
    for key, value in section.items():
        here = f"{path}.{key}"
        if key not in defaults:
            raise ExperimentError(f"unknown engine key {here} (not in `loveworld-engine default-config`)")
        if isinstance(value, dict):
            if not isinstance(defaults[key], dict):
                raise ExperimentError(f"{here} must be a scalar, not a mapping")
            _check_engine_overrides(value, defaults[key], here)
        elif isinstance(defaults[key], dict):
            raise ExperimentError(f"{here} must be a mapping")


def parse_shock(raw: Any, target: str, days: int, path: str) -> Shock:
    """Validate one shock entry from `treatment.shocks` or `world.shocks`."""
    entry = _mapping(raw, path)
    if "target" in entry:
        raise ExperimentError(f"{path}.target is set by the section it sits in; remove it")
    _check_keys(entry, SHOCK_KEYS, path)
    kind = entry.get("kind")
    if kind not in SHOCK_KINDS:
        raise ExperimentError(f"{path}.kind must be one of {sorted(SHOCK_KINDS)}, got {kind!r}")
    spec = SHOCK_KINDS[str(kind)]
    member = str(entry.get("member", "random"))
    if member not in SHOCK_MEMBERS:
        raise ExperimentError(f"{path}.member must be one of {list(SHOCK_MEMBERS)}, got {member!r}")
    start = _int(entry.get("start_day", spec["default_start_day"]), f"{path}.start_day", lo=0)
    if start >= days:
        raise ExperimentError(f"{path}.start_day must be below days ({days}), got {start}")
    end: int | None = None
    if "end_day" in entry:
        if entry["end_day"] is not None:
            end = _int(entry["end_day"], f"{path}.end_day", lo=0)
            if end < start or end >= days:
                raise ExperimentError(f"{path}.end_day must lie in [{start}, {days - 1}], got {end}")
    elif spec["default_length_days"] is not None:
        # A finite-duration kind ends a catalog length after its start, clipped to the run.
        end = min(start + int(spec["default_length_days"]), days - 1)
    bounds = spec["magnitude"]
    magnitude = _float(entry.get("magnitude", bounds["default"]), f"{path}.magnitude")
    if not bounds["min"] <= magnitude <= bounds["max"]:
        raise ExperimentError(f"{path}.magnitude must lie in [{bounds['min']}, {bounds['max']}], got {magnitude}")
    trait = entry.get("trait")
    if spec["traits"]:
        if trait not in spec["traits"]:
            raise ExperimentError(f"{path}.trait must be one of {spec['traits']} for {kind}, got {trait!r}")
    elif trait is not None:
        raise ExperimentError(f"{path}.trait is only valid for trait_shift")
    return Shock(
        kind=str(kind),
        target=target,
        member=member,
        start_day=start,
        end_day=end,
        magnitude=magnitude,
        trait=str(trait) if trait is not None else None,
    )


def parse_experiment(raw: Any, defaults: dict[str, Any] | None = None, source: Path | None = None) -> Experiment:
    """Build an Experiment from a YAML mapping or a request body, validating every key."""
    top = _mapping(raw, "experiment")
    _check_keys(top, EXPERIMENT_KEYS, "experiment")
    defaults = defaults if defaults is not None else eng.default_config()
    name = str(top.get("name") or (source.stem if source else "experiment"))
    if not SAFE_NAME.match(name):
        raise ExperimentError(f"name must match {SAFE_NAME.pattern}, got {name!r}")
    n_couples = _int(top.get("n_couples", defaults.get("n_couples", 1000)), "n_couples", lo=1)
    days = _int(top.get("days", defaults.get("days", 365)), "days", lo=1)

    seeds_raw = _mapping(top.get("seeds"), "seeds")
    _check_keys(seeds_raw, SEED_KEYS, "seeds")
    seeds = {k: _int(v, f"seeds.{k}", lo=0) for k, v in seeds_raw.items()}

    analysis_raw = _mapping(top.get("analysis"), "analysis")
    _check_keys(analysis_raw, ANALYSIS_KEYS, "analysis")
    analysis = AnalysisSettings(
        n_boot=_int(analysis_raw.get("n_boot", 2000), "analysis.n_boot"),
        n_perm=_int(analysis_raw.get("n_perm", 2000), "analysis.n_perm"),
        seed=_int(analysis_raw.get("seed", 7), "analysis.seed", lo=0),
        ci_level=_float(analysis_raw.get("ci_level", 0.95), "analysis.ci_level"),
    )

    control = _memory_section(top.get("control"), "control")
    treatment_raw = _mapping(top.get("treatment"), "treatment")
    _check_keys(treatment_raw, MEMORY_PARAMS + ("shocks",), "treatment")
    treatment = _memory_section({k: v for k, v in treatment_raw.items() if k != "shocks"}, "treatment")

    shocks: list[Shock] = []
    for section, target in (("treatment", "treatment"), ("world", "all")):
        block = _mapping(top.get(section), section)
        if section == "world":
            _check_keys(block, ("shocks",), "world")
        entries = block.get("shocks") or []
        if not isinstance(entries, list):
            raise ExperimentError(f"{section}.shocks must be a list")
        for i, entry in enumerate(entries):
            shocks.append(parse_shock(entry, target, days, f"{section}.shocks[{i}]"))

    engine_raw = _mapping(top.get("engine"), "engine")
    if "shocks" in engine_raw:
        raise ExperimentError("engine.shocks is not allowed; use treatment.shocks or world.shocks")
    if "memory" in engine_raw:
        raise ExperimentError("engine.memory is not allowed; arm memory values come only from control: and treatment:")
    _check_engine_overrides(engine_raw, defaults, "engine")
    if "arm_override" in engine_raw:
        raise ExperimentError("engine.arm_override is not allowed; twins runs set it")

    return Experiment(
        name=name,
        n_couples=n_couples,
        days=days,
        seeds=seeds,
        treatment=treatment,
        control=control,
        engine=engine_raw,
        shocks=shocks,
        analysis=analysis,
        source=source,
    )


def load_experiment(path: str | Path, defaults: dict[str, Any] | None = None) -> Experiment:
    """Parse an experiment YAML file."""
    p = Path(path)
    raw = yaml.safe_load(p.read_text()) or {}
    return parse_experiment(raw, defaults, source=p)


def build_engine_config(
    exp: Experiment, defaults: dict[str, Any] | None = None, placebo: bool = False
) -> dict[str, Any]:
    """Build the full engine config for an experiment (or its placebo twin, which drops the intervention)."""
    base = copy.deepcopy(defaults) if defaults is not None else eng.default_config()
    cfg = deep_merge(base, exp.engine)
    cfg["name"] = exp.name + ("-placebo" if placebo else "")
    cfg["n_couples"] = exp.n_couples
    cfg["days"] = exp.days
    cfg["seeds"] = deep_merge(dict(cfg.get("seeds", {})), exp.seeds)
    control = deep_merge(dict(base["memory"]["control"]), exp.control)
    treatment = deep_merge(control, {} if placebo else exp.treatment)
    cfg["memory"]["control"] = control
    cfg["memory"]["treatment"] = treatment
    cfg["arm_override"] = None
    shocks = [s for s in exp.shocks if not (placebo and s.target == "treatment")]
    cfg["shocks"] = [s.to_engine() for s in shocks]
    return cfg


def intervention_summary(cfg: dict[str, Any]) -> dict[str, Any]:
    """Describe which memory parameters differ between arms in a config."""
    control = cfg["memory"]["control"]
    treatment = cfg["memory"]["treatment"]
    changed = [k for k in MEMORY_PARAMS if control.get(k) != treatment.get(k)]
    if len(changed) == 1:
        k = changed[0]
        return {"parameter": k, "control_value": control[k], "treatment_value": treatment[k]}
    return {
        "parameter": ",".join(changed) if changed else "none",
        "control_value": {k: control[k] for k in changed} if changed else None,
        "treatment_value": {k: treatment[k] for k in changed} if changed else None,
    }


def shocks_summary(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the shocks list of a config (empty for configs written before shocks existed)."""
    return [dict(s) for s in cfg.get("shocks") or []]


def default_results_dir(exp: Experiment, suffix: str = "") -> Path:
    """results/<name><suffix> under the repository root."""
    return eng.REPO_ROOT / "results" / f"{exp.name}{suffix}"

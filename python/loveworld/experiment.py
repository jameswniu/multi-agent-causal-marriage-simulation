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
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from loveworld import engine as eng
from loveworld.schema import (
    ANALYSIS_KEYS,
    CUSTOM_SHOCK_KEYS,
    DESCRIPTION_MAX_CHARS,
    EFFECT_CHANNELS,
    EFFECT_KEYS,
    EXPERIMENT_KEYS,
    LABEL_MAX_CHARS,
    MAX_EFFECTS,
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
    label: str | None = None
    description: str | None = None
    effects: list[dict[str, Any]] | None = None

    def to_engine(self) -> dict[str, Any]:
        """Engine config entry."""
        out: dict[str, Any] = {
            "kind": self.kind,
            "target": self.target,
            "member": self.member,
            "start_day": self.start_day,
            "end_day": self.end_day,
        }
        if self.kind == "custom":
            out["label"] = self.label
            if self.description is not None:
                out["description"] = self.description
            out["effects"] = [dict(e) for e in self.effects or []]
            return out
        out["magnitude"] = self.magnitude
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
    if kind == "custom":
        return _parse_custom(entry, target, days, path)
    if kind not in SHOCK_KINDS:
        raise ExperimentError(f"{path}.kind must be one of {sorted(SHOCK_KINDS) + ['custom']}, got {kind!r}")
    for key in CUSTOM_SHOCK_KEYS:
        if key in entry:
            raise ExperimentError(f"{path}.{key} is only valid for a custom shock")
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


_LABEL_CHARS = re.compile(r"^[A-Za-z0-9 _'-]+$")


def label_slug(label: str) -> str:
    """Return the name a custom shock carries in the logs, exactly as the engine derives it.

    Lowercase letters and digits are kept, every run of other characters becomes one underscore, and
    leading or trailing underscores are dropped ("Mother's move-in" becomes "mother_s_move_in").
    """
    out = ""
    for ch in label.lower():
        if ch.isascii() and ch.isalnum():
            out += ch
        elif out and not out.endswith("_"):
            out += "_"
    return out.rstrip("_") or "custom"


def _parse_custom(entry: dict[str, Any], target: str, days: int, path: str) -> Shock:
    """Validate a custom shock: a label, an optional description and 1 to MAX_EFFECTS effects."""
    for key in ("magnitude", "trait"):
        if key in entry:
            raise ExperimentError(f"{path}.{key} goes on the effects of a custom shock, not the shock")
    member = str(entry.get("member", "random"))
    if member not in SHOCK_MEMBERS:
        raise ExperimentError(f"{path}.member must be one of {list(SHOCK_MEMBERS)}, got {member!r}")
    start = _int(entry.get("start_day", 0), f"{path}.start_day", lo=0)
    if start >= days:
        raise ExperimentError(f"{path}.start_day must be below days ({days}), got {start}")
    end: int | None = None
    if entry.get("end_day") is not None:
        end = _int(entry["end_day"], f"{path}.end_day", lo=0)
        if end < start or end >= days:
            raise ExperimentError(f"{path}.end_day must lie in [{start}, {days - 1}], got {end}")
    last = end if end is not None else days - 1
    label = entry.get("label")
    if (
        not isinstance(label, str)
        or not label.strip()
        or len(label) > LABEL_MAX_CHARS
        or not _LABEL_CHARS.fullmatch(label)
    ):
        raise ExperimentError(
            f"{path}.label must be 1 to {LABEL_MAX_CHARS} letters, digits, spaces, hyphens, underscores or apostrophes"
        )
    description = entry.get("description")
    if description is not None:
        if (
            not isinstance(description, str)
            or len(description) > DESCRIPTION_MAX_CHARS
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in description)
        ):
            raise ExperimentError(f"{path}.description must be text of at most {DESCRIPTION_MAX_CHARS} characters")
    raw_effects = entry.get("effects")
    if not isinstance(raw_effects, list) or not 1 <= len(raw_effects) <= MAX_EFFECTS:
        raise ExperimentError(f"{path}.effects must be a list of 1 to {MAX_EFFECTS} effects")
    effects = [_parse_effect(e, start, last, f"{path}.effects[{j}]") for j, e in enumerate(raw_effects)]
    return Shock(
        kind="custom",
        target=target,
        member=member,
        start_day=start,
        end_day=end,
        magnitude=0.0,
        label=label,
        description=description,
        effects=effects,
    )


def _parse_effect(raw: Any, shock_start: int, shock_last: int, path: str) -> dict[str, Any]:
    """Validate one effect against the channel catalog and the shock's window."""
    e = _mapping(raw, path)
    _check_keys(e, EFFECT_KEYS, path)
    channel = e.get("channel")
    if channel not in EFFECT_CHANNELS:
        raise ExperimentError(f"{path}.channel must be one of {list(EFFECT_CHANNELS)}, got {channel!r}")
    spec = EFFECT_CHANNELS[str(channel)]
    op = e.get("op", spec["op"])
    if op != spec["op"]:
        raise ExperimentError(f"{path}.op must be {spec['op']!r} for the {channel} channel, got {op!r}")
    cadence = e.get("cadence")
    if cadence not in spec["cadences"]:
        raise ExperimentError(f"{path}.cadence must be one of {list(spec['cadences'])} for {channel}, got {cadence!r}")
    lo, hi, _ = spec["cadences"][str(cadence)]
    amount = _float(e.get("amount"), f"{path}.amount")
    if not lo <= amount <= hi:
        raise ExperimentError(f"{path}.amount must lie in [{lo}, {hi}] for {channel} {cadence}, got {amount}")
    who = str(e.get("who", "member"))
    if who not in spec["who"]:
        raise ExperimentError(f"{path}.who must be one of {list(spec['who'])} for {channel}, got {who!r}")
    out: dict[str, Any] = {"channel": channel, "op": op, "amount": amount, "cadence": cadence, "who": who}
    cls = e.get("class")
    if spec["classes"]:
        if cls not in spec["classes"]:
            raise ExperimentError(f"{path}.class must be one of {list(spec['classes'])}, got {cls!r}")
        out["class"] = cls
    elif cls is not None:
        raise ExperimentError(f"{path}.class is only valid for the episode channel")
    trait = e.get("trait")
    if spec["traits"]:
        if trait not in spec["traits"]:
            raise ExperimentError(f"{path}.trait must be one of {list(spec['traits'])}, got {trait!r}")
        out["trait"] = trait
    elif trait is not None:
        raise ExperimentError(f"{path}.trait is only valid for the trait channel")
    es = shock_start
    if e.get("start_day") is not None:
        es = _int(e["start_day"], f"{path}.start_day", lo=0)
        if not shock_start <= es <= shock_last:
            raise ExperimentError(
                f"{path}.start_day must lie in the shock's window [{shock_start}, {shock_last}], got {es}"
            )
        out["start_day"] = es
    if e.get("end_day") is not None:
        el = _int(e["end_day"], f"{path}.end_day", lo=0)
        if not es <= el <= shock_last:
            raise ExperimentError(f"{path}.end_day must lie in [{es}, {shock_last}], got {el}")
        out["end_day"] = el
    return out


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
    custom_names: dict[str, str] = {}
    for section, target in (("treatment", "treatment"), ("world", "all")):
        block = _mapping(top.get(section), section)
        if section == "world":
            _check_keys(block, ("shocks",), "world")
        entries = block.get("shocks") or []
        if not isinstance(entries, list):
            raise ExperimentError(f"{section}.shocks must be a list")
        for i, entry in enumerate(entries):
            shocks.append(parse_shock(entry, target, days, f"{section}.shocks[{i}]"))
            if shocks[-1].kind == "custom":
                slug = label_slug(shocks[-1].label or "")
                if slug in custom_names:
                    raise ExperimentError(
                        f"{section}.shocks[{i}]: the custom shock name {shocks[-1].label!r} is logged as {slug!r}, "
                        f"the same as {custom_names[slug]}; give each custom shock its own name"
                    )
                custom_names[slug] = f"{section}.shocks[{i}]"

    engine_raw = _mapping(top.get("engine"), "engine")
    if "shocks" in engine_raw:
        raise ExperimentError("engine.shocks is not allowed; use treatment.shocks or world.shocks")
    if "memory" in engine_raw:
        raise ExperimentError("engine.memory is not allowed; arm memory values come only from control: and treatment:")
    _check_engine_overrides(engine_raw, defaults, "engine")
    if "arm_override" in engine_raw:
        raise ExperimentError(
            "engine.arm_override is not allowed; only twins runs (every couple run under each arm "
            "on the same random streams) set it"
        )

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

"""Fork a finished world: copy its effective engine config, append shocks, run, compare with the parent.

A fork changes nothing but the shocks. The child runs on the parent's exact engine config (seeds,
assignment, memory, policy and every engine setting) read from the parent's config.json, with the
new shocks appended, so the same couples meet the same random numbers and the per-couple difference
between child and parent is the shocks' effect on identical couples. The child records its parent's
name, determinism hash and engine version in parent.json, together with that comparison by arm.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loveworld.analysis import couple_frame, load_tables, paired_effects
from loveworld.experiment import AnalysisSettings, ExperimentError, Shock, parse_shock
from loveworld.schema import MAX_RESAMPLES

SHOCK_TARGETS = ("treatment", "all")
MAX_FORK_SHOCKS = 16
ARM_SUBSETS = ("all", "control", "treatment")


@dataclass
class ForkPlan:
    """Everything a fork run needs, decided before it is queued."""

    parent: str
    parent_dir: Path
    name: str
    config: dict[str, Any]
    settings: AnalysisSettings
    shocks: list[Shock]
    parent_manifest: dict[str, Any]

    @property
    def n_couples(self) -> int:
        """Couples in the parent, and so in the child."""
        return int(self.config.get("n_couples", 0))

    @property
    def days(self) -> int:
        """Days in the parent, and so in the child."""
        return int(self.config.get("days", 0))


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise ExperimentError(f"cannot read {path.name} of the parent world: {e}") from e
    if not isinstance(data, dict):
        raise ExperimentError(f"{path.name} of the parent world is not a JSON object")
    return data


def parse_fork_shocks(raw: Any, days: int) -> list[Shock]:
    """Validate the shocks a fork appends; each names its own target, treatment or all."""
    if not isinstance(raw, list) or not raw:
        raise ExperimentError("shocks must be a non-empty list: a fork appends at least one shock")
    if len(raw) > MAX_FORK_SHOCKS:
        raise ExperimentError(f"a fork appends at most {MAX_FORK_SHOCKS} shocks, got {len(raw)}")
    shocks = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ExperimentError(f"shocks[{i}] must be a mapping")
        target = entry.get("target")
        if target not in SHOCK_TARGETS:
            raise ExperimentError(f"shocks[{i}].target must be one of {list(SHOCK_TARGETS)}, got {target!r}")
        rest = {k: v for k, v in entry.items() if k != "target"}
        shocks.append(parse_shock(rest, str(target), days, f"shocks[{i}]"))
    return shocks


def _settings_from(summary: dict[str, Any]) -> AnalysisSettings:
    """Return the parent's analysis settings, with resamples capped as for any run started from the API."""
    a = summary.get("analysis") or {}
    try:
        return AnalysisSettings(
            n_boot=min(int(a.get("n_boot", 300)), MAX_RESAMPLES),
            n_perm=min(int(a.get("n_perm", 300)), MAX_RESAMPLES),
            seed=int(a.get("seed", 7)),
            ci_level=float(a.get("ci_level", 0.95)),
        )
    except (TypeError, ValueError) as e:
        raise ExperimentError(f"the parent world's analysis settings are unreadable: {e}") from e


def plan_fork(parent: str, parent_dir: Path, raw_shocks: Any, name: str) -> ForkPlan:
    """Build the child's engine config from the parent's own config.json plus the new shocks."""
    cfg = _read_json(parent_dir / "config.json")
    manifest = _read_json(parent_dir / "manifest.json")
    summary_path = parent_dir / "summary.json"
    summary = _read_json(summary_path) if summary_path.exists() else {}
    if cfg.get("arm_override") is not None:
        raise ExperimentError("the parent is one half of a twins run; fork the experiment itself")
    days = cfg.get("days")
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        raise ExperimentError("the parent world's config has no usable days")
    shocks = parse_fork_shocks(raw_shocks, days)
    child = copy.deepcopy(cfg)
    child["name"] = name
    child["arm_override"] = None
    child["shocks"] = [dict(s) for s in cfg.get("shocks") or []] + [s.to_engine() for s in shocks]
    return ForkPlan(
        parent=parent,
        parent_dir=parent_dir,
        name=name,
        config=child,
        settings=_settings_from(summary),
        shocks=shocks,
        parent_manifest=manifest,
    )


def compare_with_parent(child_dir: Path, plan: ForkPlan) -> dict[str, Any]:
    """Per-outcome child minus parent on identical couples, for all couples and for each arm.

    Comparable only when the parent is still the run the fork was planned from, and both runs came
    from the same engine version on the same couples and seeds; otherwise the difference would mix
    the added shocks with a re-run parent or with changes to the simulation itself.
    """
    parent = load_tables(plan.parent_dir)
    child = load_tables(child_dir)
    planned = plan.parent_manifest.get("determinism_hash")
    if parent.manifest.get("determinism_hash") != planned:
        reason = "the parent was run again while this fork waited, so they no longer share a start"
        return {"comparable": False, "reason": reason}
    pv, cv = parent.manifest.get("engine_version"), child.manifest.get("engine_version")
    if pv != cv:
        return {
            "comparable": False,
            "reason": f"the parent was written by engine {pv} and this run by engine {cv}, so the difference "
            "would mix the added shocks with changes to the simulation; run the parent again to compare",
        }
    same = all(parent.config.get(k) == child.config.get(k) for k in ("seeds", "n_couples", "days"))
    if not same:
        return {"comparable": False, "reason": "the parent and this run differ in seeds, couples or days"}
    fp, fc = couple_frame(parent), couple_frame(child)
    ids = fp.index.intersection(fc.index)
    arms: dict[str, list[dict[str, Any]]] = {}
    for arm in ARM_SUBSETS:
        sub = ids if arm == "all" else ids[(fp.loc[ids, "arm"] == arm).to_numpy()]
        arms[arm] = paired_effects(fp, fc, sub, plan.settings)
    return {"comparable": True, "n_couples": int(len(ids)), "arms": arms}


def parent_record(plan: ForkPlan, comparison: dict[str, Any]) -> dict[str, Any]:
    """Build the child's parent.json, saying where it came from, what it added and how it differs."""
    return {
        "parent": plan.parent,
        "parent_determinism_hash": plan.parent_manifest.get("determinism_hash"),
        "parent_engine_version": plan.parent_manifest.get("engine_version"),
        "appended_shocks": [s.to_engine() for s in plan.shocks],
        "comparison": comparison,
    }

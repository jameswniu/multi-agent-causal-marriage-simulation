"""FastAPI layer over one results directory or a results root, serving the built dashboard.

Every endpoint takes `?experiment=<name>`; the default is the single experiment or the first by
name. Tables are loaded once per experiment and indexed by couple and agent so detail endpoints
slice instead of scanning.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from loveworld import runner
from loveworld.analysis import Tables, load_tables, sanitize, sibling_dir
from loveworld.engine import REPO_ROOT, EngineError
from loveworld.experiment import ExperimentError, parse_experiment
from loveworld.schema import (
    EXPERIMENT_KEYS,
    MAX_COUPLES,
    MAX_DAYS,
    MAX_RESAMPLES,
    MEMORY_PARAMS,
    SAFE_NAME,
    SHOCK_CATALOG,
)

FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
EVENTS_CAP = 5000

STATE_LETTER = {"married": "M", "separated": "S", "divorced": "D", "dating": "T", "broken_up": "B"}
LEGEND = {
    "M": "married",
    "C": "married, in conflict",
    "S": "separated",
    "D": "divorced",
    "T": "dating",
    "B": "broken up",
    "-": "not formed yet",
}
ARM_LETTERS = {"married": b"M", "conflict": b"C", "separated": b"S", "divorced": b"D"}
GOVERNANCE_SUFFIXES = ("-placebo", "-twins")


def records(df: pd.DataFrame | None) -> list[dict[str, Any]]:
    """Rows as JSON-safe dicts (NaN becomes null, numpy scalars become plain numbers)."""
    if df is None or len(df) == 0:
        return []
    return list(json.loads(df.to_json(orient="records")))


def _summary(results_dir: Path) -> dict[str, Any] | None:
    p = results_dir / "summary.json"
    return dict(json.loads(p.read_text())) if p.exists() else None


def _index(df: pd.DataFrame, key: str) -> dict[int, pd.DataFrame]:
    """Split a table into per-id frames (rows with a null key are dropped)."""
    if df is None or len(df) == 0 or key not in df.columns:
        return {}
    sub = df.dropna(subset=[key])
    return {int(k): g for k, g in sub.groupby(key, sort=False)}


# ---------------------------------------------------------------------------- world replay


def state_grid(tables: Tables, ordered: pd.DataFrame) -> np.ndarray:
    """Letters per (day, couple) for the couples in `ordered`, same rules for every caller.

    `C` is married and in conflict, otherwise the state's letter; `-` before a couple is formed;
    the terminal letter (`D` or `B`) is kept after the couple ends.
    """
    days = tables.days
    ids = ordered["couple_id"].to_numpy(dtype=np.int64)
    col = {int(c): i for i, c in enumerate(ids)}
    n = len(ids)
    grid = np.full((days, n), b"-", dtype="S1")
    d = tables.daily[tables.daily["couple_id"].isin(ids)] if n else tables.daily.iloc[0:0]
    if len(d) and n:
        letters = d["state"].map(STATE_LETTER).fillna("-").to_numpy().astype("S1")
        conflict = (d["state"] == "married").to_numpy() & d["in_conflict"].to_numpy(dtype=bool)
        letters = np.where(conflict, b"C", letters)
        rows = d["day"].to_numpy(dtype=np.int64)
        cols = d["couple_id"].map(col).to_numpy(dtype=np.int64)
        keep = (rows >= 0) & (rows < days)
        grid[rows[keep], cols[keep]] = letters[keep]
    for _, c in ordered.iterrows():
        ended = c["ended_day"]
        if pd.notna(ended) and c["final_state"] in ("divorced", "broken_up"):
            start = int(ended) + 1
            if start < days:
                grid[start:, col[int(c["couple_id"])]] = STATE_LETTER[c["final_state"]].encode()
    return grid


def grid_counts(grid: np.ndarray, mask: np.ndarray, letters: dict[str, bytes]) -> list[dict[str, int]]:
    """Per-day counts of each letter over the masked columns."""
    days = grid.shape[0]
    if not mask.any():
        return [{k: 0 for k in letters} for _ in range(days)]
    sub = grid[:, mask]
    cols = {k: (sub == v).sum(axis=1) for k, v in letters.items()}
    return [{k: int(v[day]) for k, v in cols.items()} for day in range(days)]


def build_world(tables: Tables) -> dict[str, Any]:
    """Per-day state strings for every couple (initial first, then remarriage), with counts."""
    days = tables.days
    cp = tables.couples
    initial = cp[cp["origin"] == "initial"].sort_values("couple_id")
    remarriage = cp[cp["origin"] != "initial"].sort_values("couple_id")
    ordered = pd.concat([initial, remarriage])
    grid = state_grid(tables, ordered)
    states = [grid[day].tobytes().decode("ascii") for day in range(days)]
    arms = [None if pd.isna(a) else str(a) for a in ordered["arm"].tolist()]
    origin = [str(o) for o in ordered["origin"].tolist()]
    arm_arr = np.array([a or "" for a in arms])
    per_arm = {arm: grid_counts(grid, arm_arr == arm, ARM_LETTERS) for arm in ("control", "treatment")}
    rem_mask = np.array([o == "remarriage" for o in origin])
    rem_raw = grid_counts(grid, rem_mask, {"dating": b"T", "married": b"M", "conflict": b"C"})
    counts = [
        {
            "day": day,
            "control": per_arm["control"][day],
            "treatment": per_arm["treatment"][day],
            "remarriage": {
                "dating": rem_raw[day]["dating"],
                "married": rem_raw[day]["married"] + rem_raw[day]["conflict"],
            },
        }
        for day in range(days)
    ]
    return {
        "days": days,
        "couples": [int(i) for i in ordered["couple_id"].tolist()],
        "arms": arms,
        "origin": origin,
        "states": states,
        "legend": LEGEND,
        "counts": counts,
    }


# ---------------------------------------------------------------------------- loaded experiments


class Loaded:
    """One experiment's tables, indexes, world replay and twins, loaded once."""

    def __init__(self, results_dir: Path) -> None:
        """Read every table and build the per-id indexes."""
        self.dir = results_dir
        self.tables = load_tables(results_dir)
        t = self.tables
        self.daily_by_couple = _index(t.daily, "couple_id")
        self.events_by_couple = _index(t.events, "couple_id")
        self.events_by_agent = _index(t.events, "agent_id")
        self.conflicts_by_couple = _index(t.conflicts, "couple_id")
        self.decisions_by_couple = _index(t.decisions, "couple_id")
        self.episodes_by_couple = _index(t.episodes, "couple_id")
        self.episodes_by_agent = _index(t.episodes, "agent_id")
        self.legacies_by_couple = _index(t.legacies, "couple_id")
        self.legacies_by_agent = _index(t.legacies, "agent_id")
        self.couples_by_id = {int(r["couple_id"]): i for i, r in t.couples.reset_index(drop=True).iterrows()}
        self.events_sorted = t.events.sort_values(["day", "seq"], kind="stable")
        self.world = build_world(t)
        self.twins = TwinsCache(results_dir)

    @property
    def summary(self) -> dict[str, Any] | None:
        """The current summary.json (re-read so a later analyze is picked up)."""
        return _summary(self.dir)

    def couple_detail(self, couple_id: int) -> dict[str, Any] | None:
        """Return the /api/couples/{id} payload, or None when unknown."""
        return couple_detail(self, couple_id)


def couple_detail(loaded: Loaded, couple_id: int) -> dict[str, Any] | None:
    """Build the /api/couples/{id} payload from the indexes, or None when the id is unknown."""
    t = loaded.tables
    pos = loaded.couples_by_id.get(couple_id)
    if pos is None:
        return None
    c = records(t.couples.iloc[[pos]])[0]
    agents = t.agents[t.agents["agent_id"].isin([c["agent_a"], c["agent_b"]])]
    agents = agents.set_index("agent_id").reindex([c["agent_a"], c["agent_b"]]).reset_index()
    empty = pd.DataFrame()
    return {
        "couple": c,
        "agents": records(agents.dropna(subset=["couple_id"])),
        "daily": records(
            loaded.daily_by_couple.get(couple_id, empty).sort_values("day")
            if couple_id in loaded.daily_by_couple
            else empty
        ),
        "events": records(
            loaded.events_by_couple.get(couple_id, empty).sort_values(["day", "seq"])
            if couple_id in loaded.events_by_couple
            else empty
        ),
        "conflicts": records(
            loaded.conflicts_by_couple.get(couple_id, empty).sort_values("started_day")
            if couple_id in loaded.conflicts_by_couple
            else empty
        ),
        "decisions": records(
            loaded.decisions_by_couple.get(couple_id, empty).sort_values(["day", "agent_id"])
            if couple_id in loaded.decisions_by_couple
            else empty
        ),
        "episodes": records(
            loaded.episodes_by_couple.get(couple_id, empty).sort_values(["day", "agent_id"])
            if couple_id in loaded.episodes_by_couple
            else empty
        ),
        "legacies": records(
            loaded.legacies_by_couple.get(couple_id, empty).sort_values(["day", "agent_id"])
            if couple_id in loaded.legacies_by_couple
            else empty
        ),
    }


def agent_detail(loaded: Loaded, agent_id: int) -> dict[str, Any] | None:
    """Build the /api/agents/{id} payload, or None when the id is unknown."""
    t = loaded.tables
    row = t.agents[t.agents["agent_id"] == agent_id]
    if len(row) == 0:
        return None
    mine = t.couples[(t.couples["agent_a"] == agent_id) | (t.couples["agent_b"] == agent_id)]
    daily_parts = []
    for _, cp in mine.iterrows():
        side = "a" if int(cp["agent_a"]) == agent_id else "b"
        dd = loaded.daily_by_couple.get(int(cp["couple_id"]))
        if dd is None or len(dd) == 0:
            continue
        daily_parts.append(
            pd.DataFrame(
                {
                    "day": dd["day"],
                    "couple_id": dd["couple_id"],
                    "trust": dd[f"trust_{side}"],
                    "affect": dd[f"affect_{side}"],
                    "satisfaction": dd[f"satisfaction_{side}"],
                    "neg": dd[f"neg_{side}"],
                    "pos": dd[f"pos_{side}"],
                    "stress": dd[f"stress_{side}"],
                    "state": dd["state"],
                    "orphan_days": dd["orphan_days"] if "orphan_days" in dd.columns else 0,
                }
            )
        )
    daily = pd.concat(daily_parts).sort_values("day") if daily_parts else pd.DataFrame()
    empty = pd.DataFrame()
    return {
        "agent": records(row)[0],
        "couples": records(mine.sort_values("formed_day")),
        "events": records(
            loaded.events_by_agent.get(agent_id, empty).sort_values(["day", "seq"])
            if agent_id in loaded.events_by_agent
            else empty
        ),
        "daily": records(daily),
        "episodes": records(
            loaded.episodes_by_agent.get(agent_id, empty).sort_values("day")
            if agent_id in loaded.episodes_by_agent
            else empty
        ),
        "legacies": records(
            loaded.legacies_by_agent.get(agent_id, empty).sort_values("day")
            if agent_id in loaded.legacies_by_agent
            else empty
        ),
    }


# ---------------------------------------------------------------------------- twins


def experiment_names(results_dir: Path) -> list[str]:
    """Names a results directory may be known by: its manifest name, then its directory name."""
    names: list[str] = []
    try:
        manifest = json.loads((results_dir / "manifest.json").read_text())
        manifest_name = str(manifest.get("name") or "")
    except (OSError, ValueError):
        manifest_name = ""
    for n in (manifest_name, results_dir.name):
        if n and n not in names:
            names.append(n)
    return names


def find_sibling(results_dir: Path, kind: str) -> Path | None:
    """Find the experiment's `-placebo` or `-twins` sibling: derived from its names, contained in the parent."""
    parent = results_dir.resolve().parent
    for name in experiment_names(results_dir):
        sib = sibling_dir(parent, name, kind)
        if sib is None:
            continue
        if kind == "twins" and runner.is_twins_dir(sib):
            return sib
        if kind == "placebo" and runner.is_results_dir(sib):
            return sib
    return None


def find_twins_dir(results_dir: Path) -> Path | None:
    """Locate the twins run next to a results directory (names only; stored paths are ignored)."""
    return find_sibling(results_dir, "twins")


class TwinsCache:
    """Lazily loaded twin runs (control and treatment) for one results directory."""

    def __init__(self, results_dir: Path) -> None:
        """Remember the results directory; nothing is read until `load`."""
        self.results_dir = results_dir
        self.loaded = False
        self.path: Path | None = None
        self.control: Loaded | None = None
        self.treatment: Loaded | None = None
        self.world: dict[str, Any] | None = None

    def load(self) -> None:
        """Find and read the twin runs once; later calls are no-ops."""
        if self.loaded:
            return
        self.loaded = True
        self.path = find_twins_dir(self.results_dir)
        if self.path is None:
            return
        self.control = Loaded(self.path / "control")
        self.treatment = Loaded(self.path / "treatment")
        self.world = self._build_world(_summary(self.results_dir))

    def _build_world(self, summary: dict[str, Any] | None) -> dict[str, Any]:
        assert self.control is not None and self.treatment is not None and self.path is not None
        tc, tt = self.control.tables, self.treatment.tables
        n = int(tc.config["n_couples"])
        days = tc.days
        ids = list(range(n))
        grids = {}
        for arm, t in (("control", tc), ("treatment", tt)):
            cp = t.couples[t.couples["origin"] == "initial"].set_index("couple_id").reindex(ids).reset_index()
            cp = cp.dropna(subset=["final_state"])
            grids[arm] = state_grid(t, cp)
        gc, gt = grids["control"], grids["treatment"]
        all_mask = np.ones(n, dtype=bool)
        paired = ((summary or {}).get("governance") or {}).get("twins") or {}
        twins_summary_path = self.path / "summary.json"
        if not paired.get("paired") and twins_summary_path.exists():
            paired = json.loads(twins_summary_path.read_text())
        return {
            "available": True,
            "days": days,
            "couples": ids,
            "states_control": [gc[day].tobytes().decode("ascii") for day in range(days)],
            "states_treatment": [gt[day].tobytes().decode("ascii") for day in range(days)],
            "diverged": [int((gc[day] != gt[day]).sum()) for day in range(days)],
            "counts_control": grid_counts(gc, all_mask, ARM_LETTERS),
            "counts_treatment": grid_counts(gt, all_mask, ARM_LETTERS),
            "legend": LEGEND,
            "paired": list(paired.get("paired", [])),
            "path": str(self.path),
        }


# ---------------------------------------------------------------------------- store


DEFAULT_MAX_LOADED = 2
"""Experiments kept in memory at once; each loaded 1,000 x 365 run holds about half a gigabyte."""


def _max_loaded_from_env() -> int:
    """LOVEWORLD_MAX_LOADED when it is a positive integer, else the default."""
    raw = os.environ.get("LOVEWORLD_MAX_LOADED", "")
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_LOADED
    return value if value >= 1 else DEFAULT_MAX_LOADED


class ExperimentStore:
    """Experiments under a results root (or a single results directory), loaded lazily.

    The root is canonicalised once; children are listed only when they are real directories (no
    symlinks) whose resolved path is a direct child of the resolved root, and a name is loaded only
    when it passes the same check again at request time.
    """

    def __init__(self, root: Path, max_loaded: int | None = None) -> None:
        """Accept a results directory or a root containing results directories.

        At most `max_loaded` experiments stay in memory (env LOVEWORLD_MAX_LOADED, default 2),
        since one loaded year of 1,000 couples holds about half a gigabyte; the least recently
        used is dropped first and is read again from disk when asked for.
        """
        self.root = Path(root).resolve()
        self.single = runner.is_results_dir(self.root)
        self.extra: set[str] = set()
        self.max_loaded = max_loaded if max_loaded is not None else _max_loaded_from_env()
        if self.max_loaded < 1:
            raise ValueError("max_loaded must be at least 1")
        self.loaded: OrderedDict[str, Loaded] = OrderedDict()
        # `_lock` guards the cache itself and is held only briefly; `_load_lock` lets one
        # experiment load at a time, so concurrent cold requests never hold several copies.
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._generation: dict[str, int] = {}
        if not self.single and not self.root.is_dir():
            raise FileNotFoundError(f"{root} is neither a results directory nor a directory of them")

    @property
    def results_root(self) -> Path:
        """Where experiments live (the parent for a single results dir), resolved."""
        return self.root.parent if self.single else self.root

    def _contained(self, path: Path) -> bool:
        return path.is_dir() and not path.is_symlink() and path.resolve().parent == self.results_root

    def dir_for(self, name: str) -> Path | None:
        """Results directory of an experiment name, or None when it is not a contained child."""
        if not SAFE_NAME.match(name):
            return None
        path = self.root if (self.single and name == self.root.name) else self.results_root / name
        return path if self._contained(path) else None

    def names(self) -> list[str]:
        """Experiment names, sorted; placebo and twins siblings are attached, not listed."""
        if self.single:
            return sorted(n for n in {self.root.name, *self.extra} if self.dir_for(n) is not None)
        out = []
        for child in sorted(self.results_root.iterdir()):
            if child.name.endswith(GOVERNANCE_SUFFIXES) or not SAFE_NAME.match(child.name):
                continue
            if not self._contained(child):
                continue
            if (child / "summary.json").is_file() and runner.is_results_dir(child):
                out.append(child.name)
        return out

    def default(self) -> str | None:
        """Return the single experiment, or the first by name."""
        names = self.names()
        return names[0] if names else None

    def get(self, name: str | None) -> Loaded:
        """Load (once) and return an experiment; 404 when unknown or outside the root."""
        resolved = name or self.default()
        if resolved is None or resolved not in self.names():
            raise HTTPException(status_code=404, detail=f"unknown experiment {name!r}")
        path = self.dir_for(resolved)
        if path is None:
            raise HTTPException(status_code=404, detail=f"unknown experiment {name!r}")
        with self._lock:
            item = self.loaded.get(resolved)
            if item is not None:
                self.loaded.move_to_end(resolved)
                return item
        with self._load_lock:
            with self._lock:
                item = self.loaded.get(resolved)
                if item is not None:
                    self.loaded.move_to_end(resolved)
                    return item
                generation = self._generation.get(resolved, 0)
                # Make room first, so the new copy and the cache together stay within the limit.
                while len(self.loaded) >= self.max_loaded:
                    self.loaded.popitem(last=False)
            item = Loaded(path)
            with self._lock:
                # A re-run that invalidated this name while it loaded wins: serve, do not cache.
                if self._generation.get(resolved, 0) == generation:
                    self.loaded[resolved] = item
                    self.loaded.move_to_end(resolved)
        return item

    def invalidate(self, name: str) -> None:
        """Forget a cached experiment (after a re-run) and list it (after a new run)."""
        with self._lock:
            self.loaded.pop(name, None)
            self._generation[name] = self._generation.get(name, 0) + 1
        if self.single and name != self.root.name:
            self.extra.add(name)

    def listing(self) -> dict[str, Any]:
        """Build the /api/experiments payload from manifests and summaries, siblings checked on disk."""
        items = []
        for name in self.names():
            d = self.dir_for(name)
            if d is None:
                continue
            try:
                manifest = json.loads((d / "manifest.json").read_text())
            except (OSError, ValueError):
                continue
            summary = _summary(d) or {}
            cfg = manifest.get("config", {})
            mem = cfg.get("memory", {})
            control, treatment = mem.get("control", {}), mem.get("treatment", {})
            changed = {
                k: [control.get(k), treatment.get(k)] for k in MEMORY_PARAMS if control.get(k) != treatment.get(k)
            }
            outcomes = {o["name"]: o for o in summary.get("outcomes", [])}
            divorce = outcomes.get("divorce_rate", {})
            items.append(
                {
                    "name": name,
                    "dir": str(d),
                    "n_couples": cfg.get("n_couples"),
                    "days": cfg.get("days"),
                    "seeds": cfg.get("seeds"),
                    "intervention": {"memory": changed or None, "shocks": list(cfg.get("shocks") or [])},
                    "divorce_control": divorce.get("control_mean"),
                    "divorce_treatment": divorce.get("treatment_mean"),
                    "generated_at_unix": manifest.get("generated_at_unix"),
                    "has_placebo": find_sibling(d, "placebo") is not None,
                    "has_twins": find_sibling(d, "twins") is not None,
                }
            )
        return {"default": self.default(), "items": items}


RUN_BODY_KEYS = (*EXPERIMENT_KEYS, "overwrite")


def parse_run_body(raw: Any) -> tuple[dict[str, Any], bool]:
    """Validate a POST /api/experiments/run body against the section 6 bounds (ExperimentError on any problem)."""
    if not isinstance(raw, dict):
        raise ExperimentError("body must be a JSON object")
    unknown = sorted(set(raw) - set(RUN_BODY_KEYS))
    if unknown:
        raise ExperimentError(f"unknown key {unknown[0]} (known: {', '.join(RUN_BODY_KEYS)})")
    overwrite = raw.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise ExperimentError("overwrite must be true or false")
    body = {k: v for k, v in raw.items() if k != "overwrite" and v is not None}
    for key, cap in (("n_couples", MAX_COUPLES), ("days", MAX_DAYS)):
        if key in body:
            v = body[key]
            if isinstance(v, bool) or not isinstance(v, int) or v < 1 or v > cap:
                raise ExperimentError(f"{key} must be an integer between 1 and {cap}, got {v!r}")
    name = body.get("name") or _default_run_name()
    if not isinstance(name, str) or not SAFE_NAME.match(name) or name.endswith(GOVERNANCE_SUFFIXES):
        raise ExperimentError(f"name must match {SAFE_NAME.pattern} and not end in -placebo or -twins")
    body["name"] = name
    analysis = body.get("analysis") or {}
    if not isinstance(analysis, dict):
        raise ExperimentError("analysis must be a mapping")
    analysis = dict(analysis)
    analysis.setdefault("n_boot", 300)
    analysis.setdefault("n_perm", 300)
    for key in ("n_boot", "n_perm"):
        v = analysis[key]
        if isinstance(v, bool) or not isinstance(v, int) or v < 0 or v > MAX_RESAMPLES:
            raise ExperimentError(f"analysis.{key} must be an integer between 0 and {MAX_RESAMPLES}, got {v!r}")
    body["analysis"] = analysis
    return body, overwrite


def _default_run_name() -> str:
    return "run-" + time.strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------------------- app


def create_app(results_dir: str | Path, frontend_dist: Path | None = None) -> FastAPI:
    """Build the API for a results directory or a results root."""
    store = ExperimentStore(Path(results_dir))
    if not store.single:
        # A run interrupted between its two publication renames leaves its results hidden
        # next to the root; put them back before anything is listed.
        runner.recover_swaps(store.results_root)
    app = FastAPI(title="LoveWorld results", version="0.2.0")
    app.state.store = store

    def exp_param(experiment: str | None = Query(None, description="Experiment name (default: the first)")) -> Loaded:
        return store.get(experiment)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "experiments": store.names()}

    @app.get("/api/experiments")
    def experiments() -> dict[str, Any]:
        return store.listing()

    @app.get("/api/shocks/catalog")
    def shocks_catalog() -> dict[str, Any]:
        return {"kinds": [dict(k) for k in SHOCK_CATALOG]}

    @app.post("/api/experiments/run")
    def run_experiment(body: dict[str, Any]) -> dict[str, Any]:
        try:
            raw, overwrite = parse_run_body(body)
            exp = parse_experiment(raw)
        except ExperimentError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        name = exp.name
        target = store.results_root / name
        if target.exists() and any(target.iterdir()) and not overwrite:
            raise HTTPException(status_code=409, detail=f"experiment {name!r} exists; set overwrite to replace it")
        try:
            summary = runner.run_experiment(exp, target, overwrite=overwrite)
        except runner.TargetError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        except (ExperimentError, EngineError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        store.invalidate(name)
        return {"name": name, "dir": str(target), "summary": sanitize(summary)}

    @app.get("/api/experiment")
    def experiment(experiment: str | None = Query(None)) -> dict[str, Any]:
        loaded = store.get(experiment)
        return {"manifest": loaded.tables.manifest, "summary": loaded.summary}

    @app.get("/api/ate")
    def ate(experiment: str | None = Query(None)) -> list[dict[str, Any]]:
        s = store.get(experiment).summary
        return list(s.get("outcomes", [])) if s else []

    @app.get("/api/curves")
    def curves(experiment: str | None = Query(None)) -> dict[str, Any]:
        s = store.get(experiment).summary
        return dict(s.get("curves", {})) if s else {}

    @app.get("/api/distributions")
    def distributions(experiment: str | None = Query(None)) -> dict[str, Any]:
        s = store.get(experiment).summary
        return dict(s.get("distributions", {})) if s else {}

    @app.get("/api/policy")
    def policy(experiment: str | None = Query(None)) -> dict[str, Any]:
        return dict(store.get(experiment).tables.manifest.get("policy_spec", {}))

    @app.get("/api/world")
    def world_view(experiment: str | None = Query(None)) -> dict[str, Any]:
        return store.get(experiment).world

    @app.get("/api/events")
    def events(
        experiment: str | None = Query(None),
        day: int | None = Query(None, ge=0),
        from_day: int | None = Query(None, alias="from", ge=0),
        to_day: int | None = Query(None, alias="to", ge=0),
    ) -> dict[str, Any]:
        loaded = store.get(experiment)
        ev = loaded.events_sorted
        if day is not None:
            return {"day": day, "items": records(ev[ev["day"] == day])}
        if from_day is None and to_day is None:
            raise HTTPException(status_code=400, detail="pass ?day=N or ?from=A&to=B")
        lo = from_day if from_day is not None else 0
        hi = to_day if to_day is not None else loaded.tables.days - 1
        sub = ev[(ev["day"] >= lo) & (ev["day"] <= hi)]
        truncated = len(sub) > EVENTS_CAP
        return {"from": lo, "to": hi, "items": records(sub.iloc[:EVENTS_CAP]), "truncated": truncated}

    @app.get("/api/couples")
    def couples(
        experiment: str | None = Query(None),
        arm: str | None = None,
        state: str | None = None,
        origin: str | None = None,
        limit: int = Query(100, ge=1, le=10000),
        offset: int = Query(0, ge=0),
        sort: str = "couple_id",
    ) -> dict[str, Any]:
        df = store.get(experiment).tables.couples
        if sort not in set(df.columns):
            raise HTTPException(status_code=400, detail=f"unknown sort column {sort!r}")
        if arm is not None:
            df = df[df["arm"] == arm]
        if state is not None:
            df = df[df["final_state"] == state]
        if origin is not None:
            df = df[df["origin"] == origin]
        df = df.sort_values(sort, kind="stable")
        return {"total": int(len(df)), "items": records(df.iloc[offset : offset + limit])}

    @app.get("/api/couples/{couple_id}")
    def couple(couple_id: int, experiment: str | None = Query(None)) -> dict[str, Any]:
        detail = couple_detail(store.get(experiment), couple_id)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"couple {couple_id} not found")
        return detail

    @app.get("/api/agents/{agent_id}")
    def agent(agent_id: int, experiment: str | None = Query(None)) -> dict[str, Any]:
        detail = agent_detail(store.get(experiment), agent_id)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"agent {agent_id} not found")
        return detail

    @app.get("/api/twins/world")
    def twins_world(experiment: str | None = Query(None)) -> dict[str, Any]:
        loaded = store.get(experiment)
        loaded.twins.load()
        if loaded.twins.world is None:
            return {"available": False, "reason": f"no twins run found next to {loaded.dir} (run `loveworld twins`)"}
        return loaded.twins.world

    @app.get("/api/twins/couples/{couple_id}")
    def twins_couple(couple_id: int, experiment: str | None = Query(None)) -> dict[str, Any]:
        loaded = store.get(experiment)
        loaded.twins.load()
        if loaded.twins.control is None or loaded.twins.treatment is None:
            raise HTTPException(status_code=404, detail="no twins run available")
        control = couple_detail(loaded.twins.control, couple_id)
        treatment = couple_detail(loaded.twins.treatment, couple_id)
        if control is None or treatment is None:
            raise HTTPException(status_code=404, detail=f"couple {couple_id} not found in the twins run")
        return {"control": control, "treatment": treatment}

    dist = frontend_dist if frontend_dist is not None else FRONTEND_DIST
    if dist.exists() and (dist / "index.html").exists():
        mount_dashboard(app, dist)
    return app


def mount_dashboard(app: FastAPI, dist: Path) -> None:
    """Serve the built single-page dashboard: hashed assets from disk, index.html re-read per request.

    Client-side routes (anything that is not a file under dist and not /api) fall back to
    index.html, which is read on every request so a rebuilt bundle is picked up without a restart.
    """
    root = dist.resolve()
    assets = root / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="unknown API route")
        if path:
            candidate = (root / path).resolve()
            if candidate.is_file() and root in candidate.parents:
                return FileResponse(str(candidate))
        index = (root / "index.html").resolve()
        if not index.is_file() or root not in index.parents:
            raise HTTPException(
                status_code=404, detail="dashboard index.html is missing or outside the build directory"
            )
        return HTMLResponse(index.read_text(encoding="utf-8"))

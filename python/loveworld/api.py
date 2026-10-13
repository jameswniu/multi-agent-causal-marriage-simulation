"""FastAPI layer over one results directory or a results root, serving the built dashboard.

Every endpoint takes `?experiment=<name>`; the default is the single experiment or the first by
name. Tables are loaded once per experiment and indexed by couple and agent so detail endpoints
slice instead of scanning.
"""

from __future__ import annotations

import hmac
import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from loveworld import forking, runner, translate, world_views
from loveworld import jobs as jobq
from loveworld import public as pubmod
from loveworld.analysis import Tables, load_tables, sanitize, sibling_dir
from loveworld.engine import REPO_ROOT, EngineError
from loveworld.experiment import ExperimentError, build_engine_config, parse_experiment
from loveworld.schema import (
    EXPERIMENT_KEYS,
    MAX_COUPLES,
    MAX_DAYS,
    MAX_RESAMPLES,
    MEMORY_PARAMS,
    SAFE_NAME,
    SHOCK_CATALOG,
    effect_catalog,
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
    """Per-day state strings for every couple (initial first, then remarriage), with counts.

    The payload carries the determinism hash of the run these states were read from, the engine's hash of
    every table it wrote, so a forked world can tell whether its parent is still the run it was forked
    from (parent.json records the parent's hash at the fork) before comparing house by house.
    """
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
        "determinism_hash": tables.manifest.get("determinism_hash"),
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
        self.twins = TwinsCache(results_dir, t.manifest)
        self._lenses: dict[str, bytes | None] = {}
        self._digest: dict[str, Any] | None = None
        self._views_lock = threading.Lock()

    def lens(self, name: str) -> bytes | None:
        """Return one colour lens as day-major bytes, built on first use and kept.

        A lens is a daily measure per couple, such as trust or stress, that recolours the town. None when the
        run lacks the columns it reads.
        """
        with self._views_lock:
            if name not in self._lenses:
                self._lenses[name] = world_views.lens_bytes(self.tables, name)
            return self._lenses[name]

    def digest(self) -> dict[str, Any]:
        """Event counts per day, group and kind, built on first use and kept."""
        with self._views_lock:
            if self._digest is None:
                self._digest = world_views.day_digest(self.tables)
            return self._digest

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
        "partner_legacies": partner_legacies(loaded, c, couple_id),
    }


def partner_legacies(loaded: Loaded, couple: dict[str, Any], couple_id: int) -> list[dict[str, Any]]:
    """Return the records the two partners sealed when an earlier marriage of theirs ended in divorce.

    Only records sealed before this couple formed count, so an earlier couple never shows a record
    from a partner's later marriage.
    """
    formed = couple.get("formed_day")
    parts = []
    for agent in (couple.get("agent_a"), couple.get("agent_b")):
        if agent is None:
            continue
        g = loaded.legacies_by_agent.get(int(agent))
        if g is not None and len(g):
            keep = g["couple_id"] != couple_id
            if formed is not None and pd.notna(formed):
                keep &= g["day"] < int(formed)
            parts.append(g[keep])
    if not parts:
        return []
    return records(pd.concat(parts).sort_values(["day", "agent_id"]))


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


def find_placebo(results_dir: Path) -> Path | None:
    """Find the experiment's `-placebo` sibling: derived from its names, contained in the parent."""
    parent = results_dir.resolve().parent
    for name in experiment_names(results_dir):
        sib = sibling_dir(parent, name, "placebo")
        if sib is not None and runner.is_results_dir(sib):
            return sib
    return None


def twins_link(summary: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return the twins a run's summary links (its `governance.twins`), or None."""
    governance = (summary or {}).get("governance")
    link = governance.get("twins") if isinstance(governance, dict) else None
    return link if isinstance(link, dict) else None


def find_twins(
    results_dir: Path, run_manifest: dict[str, Any], link: dict[str, Any] | None = None
) -> tuple[Path | None, str | None, dict[str, Any]]:
    """Find the twins run beside a results directory that was made for its run.

    Returns the twins directory with each half's determinism hash; or None with the reason when a twins run
    sits beside the results but was made for another run (`runner.check_twins`); or None and no reason when
    none sits there. Candidates come from the run's names only, never from a path stored in a summary, and
    must be direct siblings.
    """
    parent = results_dir.resolve().parent
    reason: str | None = None
    for name in experiment_names(results_dir):
        sib = sibling_dir(parent, name, "twins")
        if sib is None or not runner.is_twins_dir(sib):
            continue
        problem, hashes = runner.check_twins(run_manifest, sib, link)
        if problem is None:
            return sib, None, hashes
        if reason is None:
            reason = f"{sib.name} was made for a different run than {results_dir.name}, since {problem}"
    return None, reason, {}


def _records_these_twins(link: dict[str, Any], hashes: dict[str, Any]) -> bool:
    """Tell whether a summary's twins link records these halves' hashes, or records none to compare."""
    return all(hashes.get(arm) == value for arm, value in runner.linked_twin_hashes(link).items())


class TwinsCache:
    """The twins made for one results directory's run: found by their manifests, their tables read lazily.

    Twins beside the run that were made for another run, as a publication that stopped between its twins
    and its run leaves them, are never served: not by the twins endpoints, and not as the summary's link.
    The check is made again whenever what it read changes on disk (the run's summary, or a twins run made,
    replaced or removed beside the run), so twins published later are found and replaced ones are not
    served from memory.
    """

    def __init__(self, results_dir: Path, run_manifest: dict[str, Any]) -> None:
        """Remember the run as it was read; nothing about its twins is read until `check` or `load`."""
        self.results_dir = results_dir
        self.run_manifest = run_manifest
        self.path: Path | None = None
        # Why the twins beside the run are not shown for it; None when it has its own or none sits beside it.
        self.reason: str | None = None
        self.hashes: dict[str, Any] = {}
        self.control: Loaded | None = None
        self.treatment: Loaded | None = None
        self.world: dict[str, Any] | None = None
        # What the last check read, as stamps, and the hashes of the twin runs whose tables are held now.
        self._checked: tuple[Any, ...] | None = None
        self._held: dict[str, Any] | None = None
        # The check reads a few small files and is quick, while a load reads two whole runs, so a request that
        # needs only the check never waits behind a load.
        self._check_lock = threading.Lock()
        self._load_lock = threading.Lock()

    def _stamp(self) -> tuple[Any, ...]:
        """Stamp everything the check reads: the run's summary and the two manifests of each candidate twins run."""
        parent = self.results_dir.resolve().parent
        halves = []
        for name in experiment_names(self.results_dir):
            sib = sibling_dir(parent, name, "twins")
            halves.append(tuple(_disk_stamp(sib / arm) if sib is not None else None for arm in runner.TWIN_ARMS))
        return (_file_stamp(self.results_dir / "summary.json"), tuple(halves))

    def check(self) -> Path | None:
        """Find the twins beside the run that were made for it, from their manifests alone, again on any change."""
        with self._check_lock:
            stamp = self._stamp()
            if stamp != self._checked:
                link = twins_link(_summary(self.results_dir))
                self.path, self.reason, self.hashes = find_twins(self.results_dir, self.run_manifest, link)
                self._checked = stamp
            return self.path

    def load(self) -> None:
        """Hold the tables of the twins made for this run, read again only when the check finds other twins."""
        with self._load_lock:
            path = self.check()
            hashes = dict(self.hashes)
            if path is not None and self._held == hashes:
                return
            # Twin tables read for an earlier check are not the twins beside the run now.
            self.control = self.treatment = self.world = None
            self._held = None
            if path is None:
                return
            control, treatment = Loaded(path / "control"), Loaded(path / "treatment")
            read = {
                arm: half.tables.manifest.get("determinism_hash")
                for arm, half in zip(runner.TWIN_ARMS, (control, treatment), strict=True)
            }
            world = self._build_world(path, control, treatment, self.vetted(_summary(self.results_dir)))
            # Checked once more with everything read: twins replaced meanwhile are not the ones that were
            # checked, so nothing is held and the next request checks again.
            if read != hashes or self.check() != path or self.hashes != hashes:
                with self._check_lock:
                    self.path, self._checked = None, None
                    self.reason = f"{path.name} changed while it was being read"
                return
            self.control, self.treatment, self.world = control, treatment, world
            self._held = hashes

    def vetted(self, summary: dict[str, Any] | None) -> dict[str, Any] | None:
        """Return the run's summary as served: its twins link is dropped when the twins beside it are not its own.

        A link stays when the twins beside the run were made for it and are the runs it records, and when no
        twins run sits beside the run at all, since it then only reports what the run's own twins found.
        """
        link = twins_link(summary)
        if summary is None or link is None:
            return summary
        self.check()
        if self.reason is None and (self.path is None or _records_these_twins(link, self.hashes)):
            return summary
        governance = dict(summary.get("governance") or {})
        governance["twins"] = None
        return {**summary, "governance": governance}

    @staticmethod
    def _build_world(path: Path, control: Loaded, treatment: Loaded, summary: dict[str, Any] | None) -> dict[str, Any]:
        """Build the /api/twins/world payload from the twin runs read from `path`."""
        tc, tt = control.tables, treatment.tables
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
        twins_summary_path = path / "summary.json"
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
            "path": path.name,
        }


# ---------------------------------------------------------------------------- store


DEFAULT_MAX_LOADED = 2
"""Experiments kept in memory at once; each loaded 1,000 x 365 run holds about half a gigabyte."""


def _file_stamp(path: Path) -> tuple[int, int, int] | None:
    """Return a file's inode, modification time and size, or None when it cannot be read."""
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_ino, st.st_mtime_ns, st.st_size)


def _disk_stamp(results_dir: Path) -> tuple[int, int, int] | None:
    """Return the stamp of a results directory's manifest: its inode, modification time and size.

    The stamp tells whether the directory still holds the run that was read. A run publishes by renaming a
    whole new directory into place, so a re-run from this server, the command line or another process
    leaves a manifest with another inode and modification time.
    """
    return _file_stamp(results_dir / "manifest.json")


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
        # The manifest stamp each cached copy was read under: a copy whose results changed on disk since,
        # by a run this server never saw, is read again instead of served.
        self._stamps: dict[str, tuple[int, int, int] | None] = {}
        # Public mode points the default at a curated experiment, never at a visitor's run, and with
        # `public_default_only` there is no default at all when no curated experiment exists.
        self.preferred_default: str | None = None
        self.public_default_only = False
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
        if not SAFE_NAME.fullmatch(name):
            return None
        path = self.root if (self.single and name == self.root.name) else self.results_root / name
        return path if self._contained(path) else None

    def names(self) -> list[str]:
        """Experiment names, sorted; placebo and twins siblings are attached, not listed."""
        if self.single:
            return sorted(n for n in {self.root.name, *self.extra} if self.dir_for(n) is not None)
        out = []
        for child in sorted(self.results_root.iterdir()):
            if child.name.endswith(GOVERNANCE_SUFFIXES) or not SAFE_NAME.fullmatch(child.name):
                continue
            if not self._contained(child):
                continue
            if (child / "summary.json").is_file() and runner.is_results_dir(child):
                out.append(child.name)
        return out

    def default(self) -> str | None:
        """Return the preferred experiment when it exists, else the single one, else the first by name."""
        names = self.names()
        if self.preferred_default in names:
            return self.preferred_default
        if self.public_default_only:
            return None
        return names[0] if names else None

    def get(self, name: str | None) -> Loaded:
        """Load (once) and return an experiment; 404 when unknown or outside the root.

        A cached copy is served only while the results on disk are still the run it was read from, so a
        run published over it by another process is read again rather than hidden behind the old copy.
        While a run holds the lock to publish over it, its results are missing for a moment between the two
        renames: the copy in memory is served then, and with no copy the answer is a 503 to try again, or a
        404 while not even the directory is there.
        """
        resolved = name or self.default()
        if resolved is None:
            raise HTTPException(status_code=404, detail=f"unknown experiment {name!r}")
        path = self.dir_for(resolved) if resolved in self.names() else None
        if path is None:
            with self._lock:
                item = self.loaded.get(resolved)
                # Between the two renames of a run published over it, the experiment is not on disk at all.
                if item is not None and runner.publishing(self.results_root / resolved):
                    self.loaded.move_to_end(resolved)
                    return item
                self._drop(resolved)
            raise HTTPException(status_code=404, detail=f"unknown experiment {name!r}")
        with self._lock:
            item = self.loaded.get(resolved)
            if item is not None and self._current(resolved, _disk_stamp(path), path):
                self.loaded.move_to_end(resolved)
                return item
        with self._load_lock:
            with self._lock:
                # Stamped only now, after any wait for another load, and before any table is read, so results
                # that change during the read are read again on the next request.
                stamp = _disk_stamp(path)
                item = self.loaded.get(resolved)
                if item is not None and self._current(resolved, stamp, path):
                    self.loaded.move_to_end(resolved)
                    return item
                # A copy of results that have changed on disk since it was read is dropped, never served.
                self._drop(resolved)
                if stamp is None and runner.publishing(path):
                    raise HTTPException(status_code=503, detail=f"{resolved} is being published; try again in a moment")
                if stamp is None:
                    raise HTTPException(status_code=404, detail=f"unknown experiment {name!r}")
                generation = self._generation.get(resolved, 0)
                # Make room first, so the new copy and the cache together stay within the limit.
                while len(self.loaded) >= self.max_loaded:
                    dropped, _ = self.loaded.popitem(last=False)
                    self._stamps.pop(dropped, None)
            item = Loaded(path)
            # Tables are read one file after another, so results published over them meanwhile may mix two
            # runs: read them once more, under the stamp of what is there now.
            fresh = _disk_stamp(path)
            if fresh is not None and fresh != stamp:
                stamp, item = fresh, Loaded(path)
            with self._lock:
                # A re-run that invalidated this name while it loaded wins, and so do results that were gone
                # by the end of the read: serve what was read, do not cache it.
                if fresh is not None and self._generation.get(resolved, 0) == generation:
                    self.loaded[resolved] = item
                    self._stamps[resolved] = stamp
                    self.loaded.move_to_end(resolved)
        return item

    def _current(self, name: str, stamp: tuple[int, int, int] | None, path: Path) -> bool:
        """Tell whether the cached copy of `name` still stands, given the stamp of its results on disk now.

        No manifest at the moment while a run holds the lock to publish there means the results are being
        replaced, between the two renames, so the copy stands until there is a run to read. No manifest and
        no such run means the results are gone or broken, and the copy does not stand. Called with `_lock`.
        """
        if stamp is None:
            return runner.publishing(path)
        return self._stamps.get(name) == stamp

    def _drop(self, name: str) -> None:
        """Forget the cached copy of `name`, if any. Called with `_lock` held."""
        self.loaded.pop(name, None)
        self._stamps.pop(name, None)

    def invalidate(self, name: str) -> None:
        """Forget a cached experiment (after a re-run) and list it (after a new run)."""
        with self._lock:
            self.loaded.pop(name, None)
            self._stamps.pop(name, None)
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
                    "dir": d.name,
                    "n_couples": cfg.get("n_couples"),
                    "days": cfg.get("days"),
                    "seeds": cfg.get("seeds"),
                    "intervention": {"memory": changed or None, "shocks": list(cfg.get("shocks") or [])},
                    "divorce_control": divorce.get("control_mean"),
                    "divorce_treatment": divorce.get("treatment_mean"),
                    "generated_at_unix": manifest.get("generated_at_unix"),
                    "determinism_hash": manifest.get("determinism_hash"),
                    "has_placebo": find_placebo(d) is not None,
                    "has_twins": find_twins(d, manifest, twins_link(summary))[0] is not None,
                    "parent": (read_parent(d) or {}).get("parent"),
                }
            )
        return {"default": self.default(), "items": items}


def read_parent(results_dir: Path) -> dict[str, Any] | None:
    """Read a forked world's parent.json (its parent, the parent's hash and the comparison), or None."""
    try:
        data = json.loads((results_dir / "parent.json").read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


RUN_BODY_KEYS = (*EXPERIMENT_KEYS, "overwrite")
PUBLIC_TREATMENT_KEYS = ("conflict_half_life_days", "shocks")
# Public runs are analysed the same way every time; a visitor cannot thin the resamples or move the seed.
PUBLIC_ANALYSIS = {"n_boot": 500, "n_perm": 500, "seed": 7, "ci_level": 0.95}
MAX_PUBLIC_SHOCKS = 16
MAX_PUBLIC_BODY_BYTES = 64 * 1024
FORK_BODY_KEYS = ("parent", "name", "shocks", "translations")
WAIT_TIMEOUT_S = 900.0


def job_error(e: BaseException, results_root: Path | None = None) -> tuple[int, str]:
    """Return the HTTP status and message a failed run reports, with server paths made relative."""
    if isinstance(e, runner.TargetError):
        code, message = 409, str(e)
    elif isinstance(e, ExperimentError | EngineError | ValueError):
        code, message = 400, str(e)
    else:
        code, message = 500, f"the run failed: {type(e).__name__}: {e}"
    return code, scrub_paths(message, results_root)


def scrub_paths(message: str, results_root: Path | None = None) -> str:
    """Say a server path relative to the results root, and the home directory as ~, never in full."""
    if results_root is not None:
        root = str(results_root)
        message = message.replace(root + os.sep, "").replace(root, "results")
    home = str(Path.home())
    return message.replace(home + os.sep, "~" + os.sep).replace(home, "~")


def check_public_run(raw: Any, config: pubmod.PublicConfig) -> None:
    """Refuse every part of a run body public mode does not allow (ExperimentError names it)."""
    if not isinstance(raw, dict):
        return
    for key in ("engine", "control", "seeds"):
        if key in raw:
            raise ExperimentError(
                f"{key} cannot be set here: a public run may change only its shocks and the treatment memory half-life"
            )
    if raw.get("overwrite"):
        raise ExperimentError("overwrite is not available here: every run gets a new name")
    treatment = raw.get("treatment")
    if isinstance(treatment, dict):
        extra = sorted(set(treatment) - set(PUBLIC_TREATMENT_KEYS))
        if extra:
            raise ExperimentError(f"treatment.{extra[0]} cannot be set here: only conflict_half_life_days and shocks")
    count = 0
    for section in ("treatment", "world"):
        block = raw.get(section)
        if isinstance(block, dict) and isinstance(block.get("shocks"), list):
            count += len(block["shocks"])
    if count > MAX_PUBLIC_SHOCKS:
        raise ExperimentError(f"a public run takes at most {MAX_PUBLIC_SHOCKS} shocks, got {count}")
    for key, cap in (("n_couples", config.max_couples), ("days", config.max_days)):
        v = raw.get(key)
        if isinstance(v, int) and not isinstance(v, bool) and v > cap:
            raise ExperimentError(f"{key} is at most {cap} here, got {v}")


def parse_run_body(raw: Any) -> tuple[dict[str, Any], bool]:
    """Validate a POST /api/experiments/run body: its keys, couples, days, name and resamples.

    Any problem raises ExperimentError naming it.
    """
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
    if not isinstance(name, str) or not SAFE_NAME.fullmatch(name) or name.endswith(GOVERNANCE_SUFFIXES):
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


def parse_translations(raw: Any) -> list[tuple[str, int]]:
    """Validate the optional `translations` list of a run body: which shocks came from translated text.

    Each entry is {"translation_id": str, "shock_index": int}, where shock_index counts the
    experiment's shocks in parse order, treatment shocks first and then world shocks. The client
    only points at a translation; everything recorded about it comes from the server's own record.
    """
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 32:
        raise ExperimentError("translations must be a list of at most 32 entries")
    out: list[tuple[str, int]] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict) or set(entry) != {"translation_id", "shock_index"}:
            raise ExperimentError(f"translations[{i}] must have exactly translation_id and shock_index")
        tid, idx = entry["translation_id"], entry["shock_index"]
        if not isinstance(tid, str) or not 1 <= len(tid) <= 64:
            raise ExperimentError(f"translations[{i}].translation_id must be a short string")
        if isinstance(idx, bool) or not isinstance(idx, int) or idx < 0:
            raise ExperimentError(f"translations[{i}].shock_index must be a non-negative integer")
        out.append((tid, idx))
    return out


def _default_run_name() -> str:
    return "run-" + time.strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------------------- app


def create_app(
    results_dir: str | Path,
    frontend_dist: Path | None = None,
    translator: translate.Translator | None = None,
    public: pubmod.PublicConfig | None = None,
    queue: jobq.JobQueue | None = None,
) -> FastAPI:
    """Build the API for a results directory or a results root.

    `public` defaults to the environment (LOVEWORLD_PUBLIC and its caps); public mode needs a
    results root, since visitors' runs live beside the curated experiments.
    """
    store = ExperimentStore(Path(results_dir))
    # Translation records live beside the experiments, in a hidden directory the store never lists.
    shock_translator = (
        translator if translator is not None else translate.Translator(record_dir=store.results_root / ".translations")
    )
    if not store.single:
        # A run interrupted between its two publication renames leaves its results hidden
        # next to the root; put them back before anything is listed.
        runner.recover_swaps(store.results_root)
    public_config = public if public is not None else pubmod.PublicConfig.from_env()
    pub: pubmod.Public | None = None
    if public_config.enabled:
        if store.single:
            raise ValueError("public mode serves a results root, not a single results directory")
        curated = set(store.names())
        pub = pubmod.Public(public_config, store.results_root, curated)
        store.preferred_default = "example" if "example" in curated else (min(curated) if curated else None)
        store.public_default_only = True
        pub.start_sweeper(on_removed=store.invalidate)
    runs = queue if queue is not None else jobq.JobQueue(error_mapper=lambda e: job_error(e, store.results_root))
    app = FastAPI(title="LoveWorld results", version="0.3.0")
    app.state.store = store
    app.state.jobs = runs
    app.state.public = pub

    def session_of(request: Request) -> str | None:
        return getattr(request.state, "sid", None)

    def client_ip(request: Request) -> str:
        """Return the client's address, the edge proxy's report when the request carries its secret."""
        if pub is not None and pub.config.edge_secret:
            given = request.headers.get(pubmod.EDGE_HEADER, "")
            reported = request.headers.get(pubmod.CLIENT_IP_HEADER, "")
            if reported and hmac.compare_digest(given, pub.config.edge_secret):
                return reported
        return request.client.host if request.client else "unknown"

    if pub is not None:
        public_state = pub

        @app.middleware("http")
        async def public_guard(request: Request, call_next: Any) -> Response:
            sid = public_state.sessions.verify(request.cookies.get(pubmod.SESSION_COOKIE))
            cookie = None
            if sid is None:
                sid, cookie = public_state.sessions.new()
            request.state.sid = sid
            path = request.url.path
            response: Response
            edge = public_state.config.edge_secret
            name = request.query_params.get("experiment")
            length = request.headers.get("content-length", "")
            if (
                request.method == "POST"
                and path.startswith("/api/")
                and edge
                and not hmac.compare_digest(request.headers.get(pubmod.EDGE_HEADER, ""), edge)
            ):
                response = JSONResponse({"detail": "requests must come through the site"}, status_code=403)
            elif request.method == "POST" and path.startswith("/api/") and not length.isdigit():
                response = JSONResponse({"detail": "a request body needs its length"}, status_code=411)
            elif request.method == "POST" and path.startswith("/api/") and int(length) > MAX_PUBLIC_BODY_BYTES:
                response = JSONResponse({"detail": "that request is too large"}, status_code=413)
            elif path.startswith("/api/") and name and not public_state.visible(name, sid):
                response = JSONResponse({"detail": f"unknown experiment {name!r}"}, status_code=404)
            else:
                response = await call_next(request)
            if cookie is not None:
                secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
                response.set_cookie(
                    pubmod.SESSION_COOKIE, cookie, httponly=True, samesite="lax", secure=secure, max_age=7 * 86400
                )
            return response

    def visible_names(request: Request) -> list[str]:
        names = store.names()
        if pub is None:
            return names
        sid = session_of(request)
        return [n for n in names if pub.visible(n, sid)]

    def exp_param(experiment: str | None = Query(None, description="Experiment name (default: the first)")) -> Loaded:
        return store.get(experiment)

    @app.get("/api/health")
    def health(request: Request) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": True, "experiments": visible_names(request), "public": pub is not None}
        if pub is not None:
            out["limits"] = {"max_couples": pub.config.max_couples, "max_days": pub.config.max_days}
            out["turnstile_site_key"] = pub.config.turnstile_site_key
        return out

    @app.get("/api/experiments")
    def experiments(request: Request) -> dict[str, Any]:
        listing = store.listing()
        if pub is not None:
            sid = session_of(request)
            listing["items"] = [i for i in listing["items"] if pub.visible(i["name"], sid)]
            if listing.get("default") is not None and not pub.visible(listing["default"], sid):
                listing["default"] = store.preferred_default
        return listing

    @app.get("/api/shocks/catalog")
    def shocks_catalog() -> dict[str, Any]:
        return {"kinds": [dict(k) for k in SHOCK_CATALOG], "effects": effect_catalog()}

    @app.post("/api/shocks/translate")
    def translate_shock(body: dict[str, Any], request: Request) -> dict[str, Any]:
        unknown = sorted(set(body) - {"text", "days"}) if isinstance(body, dict) else []
        if unknown:
            raise HTTPException(status_code=400, detail=f"unknown key {unknown[0]} (known: text, days)")
        quota = None
        if pub is not None:
            ip_key = pub.sessions.hash_ip(client_ip(request))
            counters = pub.counters

            def quota() -> None:
                counters.take(ip_key)

        try:
            result = shock_translator.translate(body.get("text"), body.get("days", 365), before_model_call=quota)
        except translate.TranslationRequestError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except translate.TranslatorUnavailable as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        except pubmod.QuotaExceeded as e:
            raise HTTPException(status_code=429, detail=str(e)) from e
        return result.public()

    def taken_names() -> set[str]:
        return set(store.names())

    def submit(kind: str, name: str, work: Any, request: Request, wait: bool) -> Any:
        """Queue a run and answer at once (202 and the job), or wait for it and answer like a finished run."""
        sid = session_of(request)
        if pub is not None and sid is not None and runs.active_for(sid) >= 1:
            raise HTTPException(status_code=429, detail="You already have a run in progress. Wait for it to finish.")
        try:
            job = runs.submit(kind, name, work, owner=sid)
        except jobq.QueueFull as e:
            raise HTTPException(status_code=429, detail=str(e)) from e
        except jobq.NameBusy as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        if not wait:
            return JSONResponse(runs.describe(job), status_code=202)
        try:
            result = runs.wait(job, WAIT_TIMEOUT_S)
        except jobq.JobFailed as e:
            raise HTTPException(status_code=e.status_code, detail=str(e)) from e
        target = Path(result["dir"])
        return {"job_id": job.id, "name": name, "dir": target.name, "summary": sanitize(_summary(target) or {})}

    @app.post("/api/experiments/run")
    def run_experiment(body: dict[str, Any], request: Request, wait: bool = Query(False)) -> Any:
        try:
            body = dict(body) if isinstance(body, dict) else body
            pointers = parse_translations(body.pop("translations", None) if isinstance(body, dict) else None)
            if pub is not None:
                check_public_run(body, pub.config)
                sid = session_of(request) or "000000000000"
                body["name"] = pubmod.visitor_name(sid, taken_names())
                body["analysis"] = dict(PUBLIC_ANALYSIS)
            raw, overwrite = parse_run_body(body)
            exp = parse_experiment(raw)
            if pub is not None:
                # Checked on the parsed experiment, so a field left out cannot slip past through its default.
                for key, value, cap in (
                    ("n_couples", exp.n_couples, pub.config.max_couples),
                    ("days", exp.days, pub.config.max_days),
                ):
                    if value > cap:
                        raise ExperimentError(f"{key} is at most {cap} here, got {value}")
            for _, idx in pointers:
                if idx >= len(exp.shocks):
                    raise ExperimentError(f"shock_index {idx} is past the experiment's {len(exp.shocks)} shocks")
        except ExperimentError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        extra: dict[str, Any] = {}
        if pointers:
            extra["translation.json"] = translate.translation_file(shock_translator, pointers, exp.shocks)
        name = exp.name
        target = store.results_root / name
        twins = runner.twins_dir_for(target)
        if target.exists() and any(target.iterdir()) and not overwrite:
            raise HTTPException(status_code=409, detail=f"experiment {name!r} exists; set overwrite to replace it")
        if twins.exists() and any(twins.iterdir()) and not overwrite:
            raise HTTPException(status_code=409, detail=f"{twins.name} exists; set overwrite to replace it")

        # Every run brings its twins (each couple under both arms on the same seeds), through this same
        # job, so the run cap and the public rules cover them and the World page can show both.
        def work() -> dict[str, Any]:
            cfg = build_engine_config(exp)
            runner.run_with_twins(cfg, target, exp.analysis, overwrite=overwrite, extra_files=extra or None)
            store.invalidate(name)
            return {"name": name, "dir": str(target)}

        return submit("run", name, work, request, wait)

    @app.post("/api/experiments/fork")
    def fork_experiment(body: dict[str, Any], request: Request, wait: bool = Query(False)) -> Any:
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="body must be a JSON object")
        unknown = sorted(set(body) - set(FORK_BODY_KEYS))
        if unknown:
            known = ", ".join(FORK_BODY_KEYS)
            raise HTTPException(status_code=400, detail=f"unknown key {unknown[0]} (known: {known})")
        parent = body.get("parent")
        sid = session_of(request)
        if not isinstance(parent, str) or parent not in store.names() or store.dir_for(parent) is None:
            raise HTTPException(status_code=404, detail=f"unknown parent experiment {parent!r}")
        if pub is not None and not pub.visible(parent, sid):
            raise HTTPException(status_code=404, detail=f"unknown parent experiment {parent!r}")
        parent_dir = store.dir_for(parent)
        assert parent_dir is not None
        try:
            pointers = parse_translations(body.get("translations"))
            if pub is not None:
                name = pubmod.visitor_name(sid or "000000000000", taken_names())
            else:
                name = body.get("name") or f"{parent[:40]}-fork-{time.strftime('%Y%m%d-%H%M%S')}"
            if not isinstance(name, str) or not SAFE_NAME.fullmatch(name) or name.endswith(GOVERNANCE_SUFFIXES):
                raise ExperimentError(f"name must match {SAFE_NAME.pattern} and not end in -placebo or -twins")
            if name == parent:
                raise ExperimentError("a fork needs a name of its own")
            plan = forking.plan_fork(parent, parent_dir, body.get("shocks"), name)
            if pub is not None and (plan.n_couples > pub.config.max_couples or plan.days > pub.config.max_days):
                cap = f"{pub.config.max_couples} couples, {pub.config.max_days} days"
                raise ExperimentError(f"this world is larger than a public run may be ({cap})")
            for _, idx in pointers:
                if idx >= len(plan.shocks):
                    raise ExperimentError(f"shock_index {idx} is past the fork's {len(plan.shocks)} shocks")
        except ExperimentError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        target = store.results_root / plan.name
        twins = runner.twins_dir_for(target)
        if target.exists() and any(target.iterdir()):
            raise HTTPException(status_code=409, detail=f"experiment {plan.name!r} exists; pick another name")
        if twins.exists() and any(twins.iterdir()):
            raise HTTPException(status_code=409, detail=f"{twins.name} exists; pick another name")
        extra: dict[str, Any] = {}
        if pointers:
            extra["translation.json"] = translate.translation_file(shock_translator, pointers, plan.shocks)

        def work() -> dict[str, Any]:
            forking.run_fork(plan, target, extra_files=extra or None)
            store.invalidate(plan.name)
            return {"name": plan.name, "dir": str(target)}

        return submit("fork", plan.name, work, request, wait)

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str, request: Request) -> dict[str, Any]:
        job = runs.get(job_id)
        if job is None or (pub is not None and job.owner != session_of(request)):
            raise HTTPException(status_code=404, detail="unknown job")
        return runs.describe(job)

    @app.get("/api/experiment")
    def experiment(experiment: str | None = Query(None)) -> dict[str, Any]:
        loaded = store.get(experiment)
        parent = read_parent(loaded.dir)
        return {
            "manifest": loaded.tables.manifest,
            "summary": loaded.twins.vetted(loaded.summary),
            "parent": sanitize(parent) if parent is not None else None,
        }

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

    @app.get("/api/lenses")
    def lenses() -> dict[str, Any]:
        return {"items": [lens.meta() for lens in world_views.LENSES.values()]}

    @app.get("/api/lens/{name}")
    def lens(name: str, experiment: str | None = Query(None)) -> Response:
        meta = world_views.LENSES.get(name)
        if meta is None:
            known = ", ".join(world_views.LENSES)
            raise HTTPException(status_code=404, detail=f"unknown lens {name!r} (known: {known})")
        loaded = store.get(experiment)
        data = loaded.lens(name)
        if data is None:
            why = f"this run has no {meta.label.lower()} column (an older engine wrote it)"
            raise HTTPException(status_code=404, detail=why)
        n = len(loaded.world["couples"])
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={
                "X-Lens-Days": str(loaded.tables.days),
                "X-Lens-Couples": str(n),
                "X-Lens-Lo": repr(meta.lo),
                "X-Lens-Hi": repr(meta.hi),
                "X-Lens-Worse-High": "1" if meta.higher_is_worse else "0",
            },
        )

    @app.get("/api/digest")
    def digest(experiment: str | None = Query(None)) -> dict[str, Any]:
        return store.get(experiment).digest()

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
        world = loaded.twins.world
        if world is None:
            reason = loaded.twins.reason or f"no twins run found for {loaded.dir.name} (run `loveworld twins`)"
            return {"available": False, "reason": reason}
        return world

    @app.get("/api/twins/couples/{couple_id}")
    def twins_couple(couple_id: int, experiment: str | None = Query(None)) -> dict[str, Any]:
        loaded = store.get(experiment)
        loaded.twins.load()
        # Taken once, so a load answering another request meanwhile cannot change them halfway through.
        twin_control, twin_treatment = loaded.twins.control, loaded.twins.treatment
        if twin_control is None or twin_treatment is None:
            raise HTTPException(status_code=404, detail="no twins run available")
        control = couple_detail(twin_control, couple_id)
        treatment = couple_detail(twin_treatment, couple_id)
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

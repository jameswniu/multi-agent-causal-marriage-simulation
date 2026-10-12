"""Compact read-only views of a finished run for the World page.

LoveWorld replays a year of simulated couples, and the World page draws every couple as a house
in a town. Two views here keep that page cheap to play:

* A lens is one logged daily number per couple (trust, stress, grudge, warmth, satisfaction, or
  days without a shared warm memory), quantised to one byte per couple per day, so the town can
  recolour every house from a single small download per experiment and lens.
* The day digest counts events per day, per arm and per kind, so the page can play a whole year
  without asking the server for each day's event list.

Both read only the tables the engine already wrote; nothing here changes a run.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from loveworld.analysis import Tables

#: Byte for a couple that does not exist that day (not formed yet, or ended).
MISSING = 255
#: Largest byte a value can take; values are spread over 0..TOP.
TOP = 254
#: The three groups a couple belongs to on the World page.
GROUPS = ("control", "treatment", "remarriage")


@dataclass(frozen=True)
class Lens:
    """One colour view: which daily columns it averages, its fixed range, and which end is bad."""

    name: str
    label: str
    words: str
    columns: tuple[str, ...]
    lo: float
    hi: float
    higher_is_worse: bool

    def meta(self) -> dict[str, Any]:
        """Describe the lens as JSON for the page to show beside the lens picker."""
        return {
            "name": self.name,
            "label": self.label,
            "words": self.words,
            "lo": self.lo,
            "hi": self.hi,
            "higher_is_worse": self.higher_is_worse,
        }


# Ranges are fixed so the same colour means the same value in every experiment. Stress and the
# memory loads are clipped at 1.5 (the default load saturation, and well above the 99th
# percentile of stress in the example run); days without warmth are clipped at twice the 21-day
# leave gate.
LENSES: dict[str, Lens] = {
    lens.name: lens
    for lens in (
        Lens(
            "trust",
            "Trust",
            "how much the two partners trust each other, their average",
            ("trust_a", "trust_b"),
            0.0,
            1.0,
            False,
        ),
        Lens(
            "stress",
            "Stress",
            "how stressed the two partners are, their average",
            ("stress_a", "stress_b"),
            0.0,
            1.5,
            True,
        ),
        Lens(
            "grudge",
            "Grudge",
            "how much negative memory of each other the partners carry, their average",
            ("neg_a", "neg_b"),
            0.0,
            1.5,
            True,
        ),
        Lens(
            "warmth",
            "Warmth",
            "how much warm memory of each other the partners carry, their average",
            ("pos_a", "pos_b"),
            0.0,
            1.5,
            False,
        ),
        Lens(
            "satisfaction",
            "Satisfaction",
            "how satisfied the two partners are with the marriage, their average",
            ("satisfaction_a", "satisfaction_b"),
            0.0,
            1.0,
            False,
        ),
        Lens(
            "orphan_days",
            "Days without warmth",
            "how many days in a row the couple has gone without a warm memory on both sides",
            ("orphan_days",),
            0.0,
            42.0,
            True,
        ),
    )
}


def world_order(tables: Tables) -> np.ndarray:
    """Couple ids in the World page's order: initial couples by id, then remarried couples by id.

    This is the order of `/api/world`'s `couples`, so byte `day * n + i` of a lens belongs to the
    couple at position `i` there.
    """
    cp = tables.couples
    initial = cp[cp["origin"] == "initial"].sort_values("couple_id")
    remarriage = cp[cp["origin"] != "initial"].sort_values("couple_id")
    first = initial["couple_id"].to_numpy(dtype=np.int64)
    later = remarriage["couple_id"].to_numpy(dtype=np.int64)
    return np.concatenate([first, later])


def quantise(values: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Map values onto 0..TOP over [lo, hi], clipping outside the range; NaN becomes MISSING."""
    v = np.asarray(values, dtype=np.float64)
    span = hi - lo if hi > lo else 1.0
    scaled = np.clip((v - lo) / span, 0.0, 1.0) * TOP
    out = np.rint(np.nan_to_num(scaled, nan=0.0)).astype(np.uint8)
    out[np.isnan(v)] = MISSING
    return out


def lens_bytes(tables: Tables, name: str) -> bytes | None:
    """Return the lens as day-major bytes (`days * couples`), or None when the run lacks its columns."""
    lens = LENSES[name]
    daily = tables.daily
    if any(c not in daily.columns for c in lens.columns):
        return None
    order = world_order(tables)
    days = tables.days
    n = len(order)
    grid = np.full((days, n), MISSING, dtype=np.uint8)
    if n == 0 or len(daily) == 0:
        return grid.tobytes()
    col = pd.Series(np.arange(n, dtype=np.int64), index=order)
    cols = daily["couple_id"].map(col)
    rows = daily["day"].to_numpy(dtype=np.int64)
    known = cols.notna().to_numpy() & (rows >= 0) & (rows < days)
    values = daily[list(lens.columns)].to_numpy(dtype=np.float64).mean(axis=1)
    grid[rows[known], cols.to_numpy()[known].astype(np.int64)] = quantise(values[known], lens.lo, lens.hi)
    return grid.tobytes()


def group_of(tables: Tables) -> dict[int, str]:
    """Each couple's group on the World page: its arm for an initial couple, else remarriage."""
    out: dict[int, str] = {}
    cp = tables.couples
    for cid, origin, arm in zip(cp["couple_id"].tolist(), cp["origin"].tolist(), cp["arm"].tolist(), strict=True):
        out[int(cid)] = str(arm) if origin == "initial" and arm in ("control", "treatment") else "remarriage"
    return out


def day_digest(tables: Tables) -> dict[str, Any]:
    """Event counts per day, per group and per kind: `kinds[kind][group][day]`.

    Every kind that occurs in the run is listed with all three groups, so the page can read any
    count without checking for absent keys.
    """
    days = tables.days
    ev = tables.events
    kinds: dict[str, dict[str, list[int]]] = {}
    if len(ev):
        groups = ev["couple_id"].map(group_of(tables)).fillna("remarriage")
        day = ev["day"].to_numpy(dtype=np.int64)
        keep = (day >= 0) & (day < days)
        frame = pd.DataFrame({"kind": ev["kind"].to_numpy()[keep], "group": groups.to_numpy()[keep], "day": day[keep]})
        table = frame.groupby(["kind", "group", "day"], sort=True).size().unstack("day", fill_value=0)
        table = table.reindex(columns=range(days), fill_value=0)
        rows = {(str(k), str(g)): r.to_numpy(dtype=np.int64) for (k, g), r in table.iterrows()}
        zeros = [0] * days
        for kind in sorted({k for k, _ in rows}):
            kinds[kind] = {g: ([int(x) for x in rows[(kind, g)]] if (kind, g) in rows else list(zeros)) for g in GROUPS}
    return {"days": days, "groups": list(GROUPS), "kinds": kinds}

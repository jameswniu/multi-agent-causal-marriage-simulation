"""Tests for the World page's compact views of a finished LoveWorld run.

A lens packs one daily number per couple into one byte per couple per day, and the day digest
counts events per day, group and kind. These check the quantiser, the byte layout against the
world replay's couple order, the counts against the events table, and the three endpoints.
"""

from __future__ import annotations

import dataclasses
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from loveworld import world_views
from loveworld.analysis import load_tables
from loveworld.api import build_world, create_app, partner_legacies


def test_quantise_spreads_the_range_clips_and_marks_missing() -> None:
    v = np.array([0.0, 1.0, 0.5, -3.0, 9.0, math.nan])
    q = world_views.quantise(v, 0.0, 1.0)
    assert q.dtype == np.uint8
    assert q.tolist() == [0, world_views.TOP, 127, 0, world_views.TOP, world_views.MISSING]
    # A degenerate range never divides by zero.
    assert world_views.quantise(np.array([2.0]), 1.0, 1.0).tolist() == [world_views.TOP]


def test_every_lens_names_real_daily_columns_and_a_sane_range(smoke_results: Path) -> None:
    t = load_tables(smoke_results)
    for lens in world_views.LENSES.values():
        assert lens.hi > lens.lo
        assert all(c in t.daily.columns for c in lens.columns), lens.name


def test_world_order_matches_the_world_replay(smoke_results: Path) -> None:
    t = load_tables(smoke_results)
    assert world_views.world_order(t).tolist() == build_world(t)["couples"]


def test_lens_bytes_are_day_major_in_world_order(smoke_results: Path) -> None:
    t = load_tables(smoke_results)
    order = world_views.world_order(t)
    data = world_views.lens_bytes(t, "trust")
    assert data is not None
    grid = np.frombuffer(data, dtype=np.uint8).reshape(t.days, len(order))
    row = t.daily.sort_values(["day", "couple_id"]).iloc[len(t.daily) // 2]
    i = int(np.where(order == int(row["couple_id"]))[0][0])
    expected = world_views.quantise(np.array([(row["trust_a"] + row["trust_b"]) / 2]), 0.0, 1.0)[0]
    assert grid[int(row["day"]), i] == expected
    # A day with no daily row for a couple is missing, never a fake value.
    first = int(order[0])
    gap = dataclasses.replace(t, daily=t.daily[~((t.daily["day"] == 3) & (t.daily["couple_id"] == first))])
    gapped = world_views.lens_bytes(gap, "trust")
    assert gapped is not None
    assert np.frombuffer(gapped, dtype=np.uint8).reshape(t.days, len(order))[3, 0] == world_views.MISSING


def test_digest_counts_match_the_events_table(smoke_results: Path) -> None:
    t = load_tables(smoke_results)
    digest = world_views.day_digest(t)
    assert digest["days"] == t.days
    assert digest["groups"] == ["control", "treatment", "remarriage"]
    total = sum(sum(sum(v) for v in per.values()) for per in digest["kinds"].values())
    in_range = t.events[(t.events["day"] >= 0) & (t.events["day"] < t.days)]
    assert total == len(in_range)
    groups = world_views.group_of(t)
    ev = in_range.iloc[len(in_range) // 2]
    g = groups.get(int(ev["couple_id"]), "remarriage")
    same = in_range[(in_range["kind"] == ev["kind"]) & (in_range["day"] == ev["day"])]
    n = int((same["couple_id"].map(groups).fillna("remarriage") == g).sum())
    assert digest["kinds"][ev["kind"]][g][int(ev["day"])] == n


@pytest.fixture(scope="module")
def client(results_root: Path) -> TestClient:
    return TestClient(create_app(results_root, frontend_dist=results_root / "no-dist"))


def test_lens_endpoints(client: TestClient) -> None:
    listed = client.get("/api/lenses").json()["items"]
    assert [x["name"] for x in listed] == list(world_views.LENSES)
    world = client.get("/api/world?experiment=smoke").json()
    r = client.get("/api/lens/grudge?experiment=smoke")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    days = int(r.headers["x-lens-days"])
    n = int(r.headers["x-lens-couples"])
    assert (days, n) == (world["days"], len(world["couples"]))
    assert len(r.content) == days * n
    span = (float(r.headers["x-lens-lo"]), float(r.headers["x-lens-hi"]))
    assert span == (0.0, 1.5) and r.headers["x-lens-worse-high"] == "1"
    assert client.get("/api/lens/trust?experiment=smoke").headers["x-lens-worse-high"] == "0"
    bad = client.get("/api/lens/height?experiment=smoke")
    assert bad.status_code == 404 and "unknown lens" in bad.json()["detail"]


def test_digest_endpoint_and_partner_legacies(client: TestClient) -> None:
    d = client.get("/api/digest?experiment=smoke").json()
    assert d["groups"] == ["control", "treatment", "remarriage"]
    assert all(len(v) == d["days"] for per in d["kinds"].values() for v in per.values())
    couple = client.get("/api/couples/0?experiment=smoke").json()
    assert isinstance(couple["partner_legacies"], list)
    assert all(row["couple_id"] != 0 for row in couple["partner_legacies"])


def test_partner_legacies_keep_only_records_sealed_before_the_couple_formed() -> None:
    sealed = pd.DataFrame({"day": [40, 300], "couple_id": [3, 9], "agent_id": [14, 14], "final_trust": [0.3, 0.2]})
    loaded = SimpleNamespace(legacies_by_agent={14: sealed})
    later = partner_legacies(loaded, {"agent_a": 14, "agent_b": 15, "formed_day": 120}, 7)  # type: ignore[arg-type]
    assert [r["couple_id"] for r in later] == [3]
    # The couple that sealed the day-300 record sees only the earlier one, never its own.
    own = partner_legacies(loaded, {"agent_a": 14, "agent_b": 15, "formed_day": 250}, 9)  # type: ignore[arg-type]
    assert [r["couple_id"] for r in own] == [3]
    # An initial couple formed before any seal sees none.
    assert partner_legacies(loaded, {"agent_a": 14, "agent_b": 15, "formed_day": 0}, 3) == []  # type: ignore[arg-type]

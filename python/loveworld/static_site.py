"""Export the free, read-only demo: the example town and its pre-run shocks as files GitHub Pages can serve.

LoveWorld's dashboard normally reads a FastAPI server. The demo on GitHub Pages has no server, so this module
asks the very same app (`create_app`, on a results root that holds only the worlds the demo shows) for every
response the read-only pages make, and writes each one gzipped under `<site>/data`. It asks inside this process,
through loveworld.asgi_reader, which talks to the app the way the uvicorn server does and returns the very bytes
the live server sends, with no port and no package beyond the app's own. The dashboard's static mode
(frontend/src/staticApi.ts) maps each request to its file, inflates it with DecompressionStream, and does the one
thing a file cannot: /api/couples's filters, stable sort and paging, by the server's rules. Nothing here calls a
model, and nothing written holds a key or a secret.

Every file is gzipped, and JSON unless it ends in .bin:

    index.json.gz                      the worlds, the default world, the demo shocks, lens headers, what is left out
    experiments.json.gz                GET /api/experiments; likewise health, shocks-catalog and lenses
    w/<world>/experiment.json.gz       GET /api/experiment?experiment=<world>; likewise ate, curves, distributions,
                                       policy, world, twins-world (GET /api/twins/world) and digest
    w/<world>/couples.json.gz          GET /api/couples?limit=10000: every couple, in table order
    w/<world>/couples/<id>.json.gz     GET /api/couples/<id>
    w/<world>/agents/<id>.json.gz      GET /api/agents/<id>
    w/<world>/events/<k>.json.gz       GET /api/events?day=N for the days of chunk k: {"from", "to", "days": [...]}
    w/<world>/lens/<name>.bin.gz       GET /api/lens/<name>, its headers kept in the index
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import tempfile
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loveworld import demo as demos
from loveworld import public as pubmod
from loveworld import runner, translate
from loveworld.analysis import sibling_dir
from loveworld.api import create_app, experiment_names
from loveworld.asgi_reader import AppReader, Reply
from loveworld.engine import REPO_ROOT

SITE_FORMAT = 1
#: Days of events per file. The World page asks for one day at a time, and only while paused.
EVENT_CHUNK_DAYS = 10
#: The largest page /api/couples gives; every world here fits in one.
COUPLES_PAGE = 10000
#: The published site should stay under this many megabytes; the exporter says when it does not.
TARGET_MB = 400
#: Above this the export fails: GitHub Pages refuses sites over 1 GB.
FAIL_MB = 900
QUICKSTART_URL = "https://github.com/jameswniu/multi-agent-causal-marriage-simulation#run-it"
DEFAULT_SITE = REPO_ROOT / "site"
#: The per-world reads, by file stem: each is one GET with ?experiment=<world>.
WORLD_READS = {
    "experiment": "/api/experiment",
    "ate": "/api/ate",
    "curves": "/api/curves",
    "distributions": "/api/distributions",
    "policy": "/api/policy",
    "world": "/api/world",
    "twins-world": "/api/twins/world",
    "digest": "/api/digest",
}
#: Reads that do not depend on the world.
GLOBAL_READS = {
    "experiments": "/api/experiments",
    "health": "/api/health",
    "shocks-catalog": "/api/shocks/catalog",
    "lenses": "/api/lenses",
}
#: API reads the demo does not export, and why; the dashboard never makes them.
NOT_EXPORTED = [
    {"path": "/api/twins/couples/{id}", "why": "no page reads it"},
    {"path": "/api/events?from=A&to=B", "why": "no page reads it; the World page asks for one day at a time"},
]


class StaticExportError(RuntimeError):
    """The site cannot be exported: a world is missing or stale, a read failed, or the site is too large."""


def gz(data: bytes) -> bytes:
    """Gzip at the highest level with no timestamp, so the same response always writes the same file."""
    return gzip.compress(data, compresslevel=9, mtime=0)


@dataclass
class Report:
    """What an export wrote: files and compressed bytes, in all and per world."""

    out: Path
    files: int = 0
    bytes: int = 0
    per_world: dict[str, int] = field(default_factory=dict)

    @property
    def megabytes(self) -> float:
        """Compressed size of the data folder in megabytes (10^6 bytes)."""
        return self.bytes / 1e6


class _Writer:
    """Gzip and write files on a few threads while the requests run, counting what was written."""

    def __init__(self, root: Path, report: Report) -> None:
        self.root = root
        self.report = report
        self.pool = ThreadPoolExecutor(max_workers=4)
        self.pending: list[Future[tuple[str | None, int]]] = []

    def write(self, rel: str, raw: bytes, world: str | None = None) -> None:
        path = self.root / rel

        def job() -> tuple[str | None, int]:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = gz(raw)
            path.write_bytes(data)
            return world, len(data)

        self.pending.append(self.pool.submit(job))
        if len(self.pending) > 256:
            self._drain(128)

    def _drain(self, keep: int = 0) -> None:
        while len(self.pending) > keep:
            world, size = self.pending.pop(0).result()
            self.report.files += 1
            self.report.bytes += size
            if world is not None:
                self.report.per_world[world] = self.report.per_world.get(world, 0) + size

    def close(self) -> None:
        try:
            self._drain()
        finally:
            self.pool.shutdown(wait=True)


def _siblings(results_root: Path, world_dir: Path) -> list[Path]:
    """Return the placebo and twins directories the API attaches to a world: `<name>-placebo`, `<name>-twins`."""
    out = []
    for name in experiment_names(world_dir):
        for kind in ("placebo", "twins"):
            sib = sibling_dir(results_root, name, kind)
            if sib is not None and sib not in out:
                out.append(sib)
    return out


def _link_tree(src: Path, dst: Path) -> None:
    """Hard-link every file of `src` into `dst` (a copy where links are refused), keeping the layout."""
    for dirpath, _, filenames in os.walk(src):
        rel = Path(dirpath).relative_to(src)
        (dst / rel).mkdir(parents=True, exist_ok=True)
        for f in filenames:
            a, b = Path(dirpath) / f, dst / rel / f
            try:
                os.link(a, b)
            except OSError:
                shutil.copy2(a, b)


def stage_root(results_root: Path, worlds: list[str], into: Path) -> None:
    """Lay out a results root holding only `worlds` and the placebo and twins runs beside them.

    The app then lists, defaults and serves exactly what `loveworld serve` would for a root of just those
    worlds. Files are hard links, so staging costs no copy.
    """
    root = Path(results_root).resolve()
    for name in worlds:
        src = root / name
        if not runner.is_results_dir(src) or not (src / "summary.json").is_file():
            raise StaticExportError(f"{name} is not a finished world in {root}")
        for d in (src, *_siblings(root, src)):
            _link_tree(d, into / d.name)


def demo_cards(items: list[demos.Demo], days: int) -> list[dict[str, Any]]:
    """Return what the index lists for each pre-run shock: the card the World page's Try a shock panel draws."""
    cards = []
    for d in items:
        shocks = demos.check_demo(d, days)
        rec = d.record
        cards.append(
            {
                "name": d.name,
                "order": d.order,
                "title": d.title,
                "words": d.words,
                "typed": d.typed,
                "parent": d.parent,
                "hits": d.hits,
                "shocks": [s.to_engine() for s in shocks],
                "note": d.note,
                "translation": None
                if rec is None or d.translation is None
                else {
                    "translation_id": rec["translation_id"],
                    "model": rec["model"],
                    "recorded": d.translation["recorded"],
                    "rationale": rec["rationale"],
                    "words": rec["words"],
                },
            }
        )
    return cards


def export_site(
    results_root: Path,
    site: Path = DEFAULT_SITE,
    default: str = "example",
    demo_dir: Path = demos.DEMO_DIR,
    fail_mb: float = FAIL_MB,
    log: Callable[[str], None] = print,
) -> Report:
    """Write `<site>/data` for the default world and every demo world in `results_root`; return what was written.

    Each demo world must still be the fork its file describes, made from the default world as it is on disk
    now, or the World page could not ring a single house; the export stops and says to run make demo.
    """
    root = Path(results_root).resolve()
    items = demos.load_demos(demo_dir)
    for d in items:
        if d.parent != default:
            raise StaticExportError(f"{d.path.name} forks {d.parent}, but the demo's default world is {default}")
        demos.check_built(d, root)
    worlds = [default, *[d.name for d in items]]
    site = Path(site)
    site.mkdir(parents=True, exist_ok=True)
    out = site / "data"
    tmp = Path(tempfile.mkdtemp(prefix=".data-", dir=site))
    tmp.chmod(0o755)
    stage = Path(tempfile.mkdtemp(prefix=".static-export-", dir=root))
    report = Report(out=out)
    try:
        stage_root(root, worlds, stage)
        app = create_app(
            stage,
            frontend_dist=stage / "no-dashboard",
            translator=translate.Translator(client_factory=lambda: None),
            public=pubmod.PublicConfig(enabled=False),
        )
        store = app.state.store
        store.preferred_default = default
        with AppReader(app) as client:
            writer = _Writer(tmp, report)
            try:
                index = _export(client, store, worlds, items, writer, log)
                writer.write("index.json.gz", json.dumps(index, separators=(",", ":"), sort_keys=True).encode())
            finally:
                writer.close()
        for name in worlds:
            log(f"{name}: {report.per_world.get(name, 0) / 1e6:.1f} MB")
        log(f"Static site data: {report.files:,} files, {report.megabytes:.1f} MB gzipped")
        if report.megabytes > TARGET_MB:
            log(f"That is over the {TARGET_MB} MB the published site should stay under")
        # Too large to publish: the data already in the site folder stays as it was.
        if report.megabytes > fail_mb:
            raise StaticExportError(f"the site's data is {report.megabytes:.1f} MB, over the {fail_mb:g} MB limit")
        if out.exists():
            if not (out / "index.json.gz").is_file() and any(out.iterdir()):
                raise StaticExportError(f"{out} exists and is not an exported site; refusing to replace it")
            shutil.rmtree(out)
        os.rename(tmp, out)
        log(f"Written to {out}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(stage, ignore_errors=True)
    return report


def _get(client: AppReader, path: str, params: dict[str, Any] | None = None) -> Reply:
    """GET one API path and return the response, which must be a 200."""
    r = client.get(path, params=params)
    if r.status_code != 200:
        raise StaticExportError(f"{path} {params or ''} answered {r.status_code}: {r.text[:300]}")
    return r


def _export(
    client: AppReader,
    store: Any,
    worlds: list[str],
    items: list[demos.Demo],
    writer: _Writer,
    log: Callable[[str], None],
) -> dict[str, Any]:
    """Ask the app for every read the static pages make, write each response, and return the index."""
    for stem, path in GLOBAL_READS.items():
        writer.write(f"{stem}.json.gz", _get(client, path).content)
    listing = _get(client, "/api/experiments").json()
    if [i["name"] for i in listing["items"]] != sorted(worlds) or listing["default"] != worlds[0]:
        raise StaticExportError(f"the staged root lists {listing['items']} with default {listing['default']}")
    lens_names = [x["name"] for x in _get(client, "/api/lenses").json()["items"]]
    entries = []
    days_of_default = 0
    for name in worlds:
        log(f"Exporting {name}")
        q = {"experiment": name}
        w = f"w/{name}"
        for stem, path in WORLD_READS.items():
            writer.write(f"{w}/{stem}.json.gz", _get(client, path, q).content, name)
        loaded = store.get(name)
        days = int(loaded.tables.days)
        if name == worlds[0]:
            days_of_default = days
        table = loaded.tables.couples
        r = _get(client, "/api/couples", {**q, "limit": COUPLES_PAGE, "offset": 0})
        couples = r.json()
        if couples["total"] > COUPLES_PAGE:
            raise StaticExportError(f"{name} has {couples['total']} couples, more than one page of {COUPLES_PAGE}")
        ids = [int(c["couple_id"]) for c in couples["items"]]
        # The page sorts and filters this list itself, so it must be the table's own order, as the server's is.
        if ids != [int(x) for x in table["couple_id"].tolist()]:
            raise StaticExportError(f"{name}'s couples table is not in couple id order")
        writer.write(f"{w}/couples.json.gz", r.content, name)
        for cid in ids:
            writer.write(f"{w}/couples/{cid}.json.gz", _get(client, f"/api/couples/{cid}", q).content, name)
        agent_ids = sorted(int(x) for x in loaded.tables.agents["agent_id"].tolist())
        for aid in agent_ids:
            writer.write(f"{w}/agents/{aid}.json.gz", _get(client, f"/api/agents/{aid}", q).content, name)
        for start in range(0, days, EVENT_CHUNK_DAYS):
            end = min(days, start + EVENT_CHUNK_DAYS) - 1
            parts = [_get(client, "/api/events", {**q, "day": d}).content for d in range(start, end + 1)]
            body = b'{"from":%d,"to":%d,"days":[' % (start, end) + b",".join(parts) + b"]}"
            writer.write(f"{w}/events/{start // EVENT_CHUNK_DAYS}.json.gz", body, name)
        lenses: dict[str, Any] = {}
        for lens in lens_names:
            lr = client.get(f"/api/lens/{lens}", params=q)
            if lr.status_code == 200:
                headers = {
                    h: lr.header(h)
                    for h in ("X-Lens-Days", "X-Lens-Couples", "X-Lens-Lo", "X-Lens-Hi", "X-Lens-Worse-High")
                }
                lenses[lens] = {"headers": headers}
                writer.write(f"{w}/lens/{lens}.bin.gz", lr.content, name)
            elif lr.status_code == 404:
                lenses[lens] = {"status": 404, "detail": lr.json().get("detail")}
            else:
                raise StaticExportError(f"/api/lens/{lens} for {name} answered {lr.status_code}")
        entries.append(
            {
                "name": name,
                "days": days,
                "couples": len(ids),
                "agents": len(agent_ids),
                "couples_columns": [str(c) for c in table.columns],
                "lenses": lenses,
            }
        )
    return {
        "format": SITE_FORMAT,
        "default": worlds[0],
        "event_chunk_days": EVENT_CHUNK_DAYS,
        "couples_page": COUPLES_PAGE,
        "quickstart": QUICKSTART_URL,
        "worlds": entries,
        "demos": demo_cards(items, days_of_default),
        "not_exported": NOT_EXPORTED,
    }

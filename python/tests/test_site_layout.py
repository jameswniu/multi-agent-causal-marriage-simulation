"""The read-only demo's site folder: the page copies `make static-pages` writes, and how GitHub Pages serves them.

The free demo on GitHub Pages is the dashboard built in static mode, one copy of its index.html per page, couple
and agent, and the exported data. `make static-pages` writes the copies, and tools/serve_static.py serves the folder
the way GitHub Pages does, so that a link to /couples/12 answers 200 from couples/12.html while /couples still
answers from couples.html beside the couples/ folder. Measured on GitHub Pages itself (13 October 2026), a path
with no slash serves its .html file before a folder of that name, a nested one included, and a folder with no
.html file redirects to its path with a slash, keeping the query.
"""

from __future__ import annotations

import gzip
import http.client
import importlib.util
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

from .conftest import REPO

BASE = "/multi-agent-causal-marriage-simulation/"
PAGES = ("world", "overview", "comparisons", "couples", "agents", "policy", "governance", "new")
INDEX = b"<!doctype html><title>LoveWorld</title><div id=root></div>"


def _serve_static() -> ModuleType:
    spec = importlib.util.spec_from_file_location("serve_static", REPO / "tools" / "serve_static.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _exported(site: Path) -> None:
    """A site folder as make static leaves it: two worlds' data, with couples and agents the worlds share or not."""
    data = site / "data"
    data.mkdir(parents=True)
    (data / "index.json.gz").write_bytes(gzip.compress(b"{}"))
    for world, couples, agents in (("example", (0, 1, 12, 1003), (0, 1, 25)), ("demo-layoff", (0, 12, 1007), (25, 40))):
        for kind, ids in (("couples", couples), ("agents", agents)):
            folder = data / "w" / world / kind
            folder.mkdir(parents=True)
            for i in ids:
                (folder / f"{i}.json.gz").write_bytes(gzip.compress(b"{}"))
        (data / "w" / world / "couples.json.gz").write_bytes(gzip.compress(b"{}"))


def _make_pages(site: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["make", "--no-print-directory", "-C", str(REPO), "static-pages", f"SITE={site}"],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def site(tmp_path: Path) -> Path:
    """A site with the built index.html and the exported data, then the copies make static-pages writes."""
    out = tmp_path / "site"
    _exported(out)
    (out / "index.html").write_bytes(INDEX)
    stale = out / "couples"
    stale.mkdir()
    (stale / "999.html").write_bytes(b"left from an earlier build")
    done = _make_pages(out)
    assert done.returncode == 0, done.stdout + done.stderr
    return out


def test_make_writes_a_copy_of_index_html_per_page_and_per_published_couple_and_agent(site: Path) -> None:
    for name in ("404", *PAGES):
        assert (site / f"{name}.html").read_bytes() == INDEX, name
    couples = sorted(int(p.stem) for p in (site / "couples").iterdir())
    agents = sorted(int(p.stem) for p in (site / "agents").iterdir())
    # Every id of any world, once, and nothing from an earlier build.
    assert couples == [0, 1, 12, 1003, 1007] and agents == [0, 1, 25, 40]
    assert all(p.read_bytes() == INDEX for p in (site / "couples").iterdir())
    assert all(p.read_bytes() == INDEX for p in (site / "agents").iterdir())


def test_make_refuses_a_site_without_its_data(tmp_path: Path) -> None:
    out = tmp_path / "site"
    out.mkdir()
    (out / "index.html").write_bytes(INDEX)
    done = _make_pages(out)
    assert done.returncode != 0 and "run make static first" in done.stdout + done.stderr
    assert not (out / "404.html").exists()


def test_paths_resolve_as_github_pages_resolves_them(site: Path) -> None:
    resolve = _serve_static().resolve
    root = site.resolve()

    def r(path: str) -> tuple[str, object]:
        kind, target = resolve(root, BASE, path)
        return kind, target.relative_to(root).as_posix() if isinstance(target, Path) else target

    assert r(BASE.rstrip("/")) == ("redirect", BASE)
    assert r(BASE.rstrip("/") + "?experiment=example") == ("redirect", BASE + "?experiment=example")
    assert r(BASE) == ("file", "index.html")
    assert r(f"{BASE}world") == ("file", "world.html")
    # The page's .html file comes before the folder of the same name, as on GitHub Pages.
    assert r(f"{BASE}couples?experiment=example") == ("file", "couples.html")
    assert r(f"{BASE}couples/12?experiment=example") == ("file", "couples/12.html")
    assert r(f"{BASE}agents/25") == ("file", "agents/25.html")
    assert r(f"{BASE}couples/99999") == ("missing", None)
    assert r(f"{BASE}couples/") == ("missing", None)
    assert r(f"{BASE}world/") == ("missing", None)
    # A folder with no .html file of its name redirects to its path with a slash, keeping the query.
    assert r(f"{BASE}data/w?x=1") == ("redirect", f"{BASE}data/w/?x=1")
    assert r(f"{BASE}data/index.json.gz") == ("file", "data/index.json.gz")
    assert r(f"{BASE}../secret") == ("missing", None)
    assert r("/elsewhere/world") == ("missing", None)


@pytest.fixture
def server(site: Path) -> Iterator[int]:
    """tools/serve_static.py serving the site on a free port, for as long as one test runs."""
    mod = _serve_static()
    httpd = mod.ThreadingHTTPServer(("127.0.0.1", 0), mod.make_handler(site.resolve(), BASE))
    httpd.quiet = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield int(httpd.server_address[1])
    finally:
        httpd.shutdown()
        httpd.server_close()


def _get(port: int, path: str) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


def test_a_link_to_one_couple_or_agent_answers_200_and_an_unknown_one_404(site: Path, server: int) -> None:
    for path in ("couples/12?experiment=example", "agents/25?experiment=demo-layoff", "couples", "world"):
        status, _, body = _get(server, BASE + path)
        assert (status, body) == (200, INDEX), path
    status, _, body = _get(server, BASE + "couples/99999?experiment=example")
    assert (status, body) == (404, INDEX)
    status, headers, _ = _get(server, BASE.rstrip("/") + "?experiment=example")
    assert status == 301 and headers["location"] == BASE + "?experiment=example"
    status, headers, body = _get(server, BASE + "data/index.json.gz")
    assert status == 200 and headers["content-type"] == "application/gzip" and "content-encoding" not in headers
    assert gzip.decompress(body) == b"{}"

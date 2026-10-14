#!/usr/bin/env python3
"""Serve the read-only demo's site folder the way GitHub Pages serves it, for checks on this machine.

LoveWorld's free demo is a static site: the dashboard built in static mode plus the gzipped data files the
exporter writes (make static, make static-frontend). GitHub Pages serves a project site under /<repository>/.
It answers a path with no trailing slash from the .html file of that name when there is one, even beside a
folder of the same name, which is how /couples serves couples.html and /couples/12 serves couples/12.html
(each page of the dashboard, and each couple and agent, has its copy of index.html). A folder with no .html
file of its name redirects to the path with a slash, keeping the query, and a path with a slash serves the
folder's index.html. Any other path it has no file for gets 404.html with status 404, which is how a link to
an unknown couple still reaches the single-page app. It hands .gz files over as plain bytes with no
Content-Encoding, so the page inflates them itself. This server does the same, and nothing more:

    python3 tools/serve_static.py site --port 8790 --base /multi-agent-causal-marriage-simulation/

then open http://127.0.0.1:8790/multi-agent-causal-marriage-simulation/. Stop it with Ctrl+C.
"""

from __future__ import annotations

import argparse
import posixpath
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

DEFAULT_BASE = "/multi-agent-causal-marriage-simulation/"
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".gz": "application/gzip",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".woff2": "font/woff2",
}


def content_type(path: Path) -> str:
    """Return the type GitHub Pages sends for a file, by its last suffix; .gz is gzip bytes, never an encoding."""
    return TYPES.get(path.suffix.lower(), "application/octet-stream")


def resolve(root: Path, base: str, url_path: str) -> tuple[str, Path | str | None]:
    """Map a request to ("file", path), ("redirect", location) or ("missing", None), as GitHub Pages does.

    A path outside the base or outside the folder is missing. The base without its slash redirects to the
    base. A path ending in a slash serves its folder's index.html. Any other path serves its file, else the
    .html file of the same name, which comes before a folder of that name (/couples serves couples.html
    beside couples/, and /couples/12 serves couples/12.html), else redirects a folder to its path with a
    slash. Redirects keep the query. Everything else is missing, as /world/ is beside world.html.
    """
    parts = urlsplit(url_path)
    query = f"?{parts.query}" if parts.query else ""
    path = unquote(parts.path)
    if path == base.rstrip("/"):
        return "redirect", base + query
    if not path.startswith(base):
        return "missing", None
    rel = posixpath.normpath(path[len(base) :] or ".")
    if rel.startswith("..") or rel.startswith("/"):
        return "missing", None
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        return "missing", None
    if path.endswith("/") or target == root:
        index = target / "index.html"
        return ("file", index) if target.is_dir() and index.is_file() else ("missing", None)
    if target.is_file():
        return "file", target
    page = target.with_name(target.name + ".html")
    if page.is_file():
        return "file", page
    if target.is_dir():
        return "redirect", parts.path + "/" + query
    return "missing", None


def make_handler(root: Path, base: str) -> type[BaseHTTPRequestHandler]:
    """Build a request handler class bound to one site folder and base path."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "loveworld-static/1"

        def _send(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=600")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _serve(self) -> None:
            kind, target = resolve(root, base, self.path)
            if kind == "redirect" and isinstance(target, str):
                self._send(HTTPStatus.MOVED_PERMANENTLY, b"", "text/plain", {"Location": target})
            elif kind == "file" and isinstance(target, Path):
                self._send(HTTPStatus.OK, target.read_bytes(), content_type(target))
            else:
                page = root / "404.html"
                if page.is_file():
                    self._send(HTTPStatus.NOT_FOUND, page.read_bytes(), TYPES[".html"])
                else:
                    self._send(HTTPStatus.NOT_FOUND, b"Not Found", TYPES[".txt"])

        def do_GET(self) -> None:  # noqa: N802 (the http.server name)
            self._serve()

        def do_HEAD(self) -> None:  # noqa: N802 (the http.server name)
            self._serve()

        def log_message(self, fmt: str, *args: object) -> None:
            if getattr(self.server, "quiet", False):
                return
            sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    return Handler


def main(argv: list[str] | None = None) -> int:
    """Serve a site folder until interrupted."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("site", nargs="?", default="site", help="The built site folder (default: site)")
    p.add_argument("--port", type=int, default=8790)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--base", default=DEFAULT_BASE, help=f"Path the site is served under (default {DEFAULT_BASE})")
    p.add_argument("--quiet", action="store_true", help="Do not log each request")
    args = p.parse_args(argv)
    root = Path(args.site).resolve()
    if not (root / "index.html").is_file():
        p.error(f"{root} has no index.html; build the site first (make static static-frontend)")
    base = "/" + args.base.strip("/") + "/" if args.base.strip("/") else "/"
    server = ThreadingHTTPServer((args.host, args.port), make_handler(root, base))
    server.quiet = args.quiet  # type: ignore[attr-defined]
    print(f"Serving {root} at http://{args.host}:{args.port}{base}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

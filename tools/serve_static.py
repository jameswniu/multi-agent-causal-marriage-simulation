#!/usr/bin/env python3
"""Serve the read-only demo's site folder the way GitHub Pages serves it, for checks on this machine.

LoveWorld's free demo is a static site: the dashboard built in static mode plus the gzipped data files the
exporter writes (make static, make static-frontend). GitHub Pages serves a project site under /<repository>/,
answers a path with no extension from the .html file of that name when there is one (each page of the
dashboard has its copy of index.html), answers any other path it has no file for with 404.html and status
404 (which is how a link to one couple reaches the single-page app), and hands .gz files over as plain
bytes with no Content-Encoding, so the page inflates them itself. This server does the same, and nothing more:

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


def resolve(root: Path, base: str, url_path: str) -> tuple[str, Path | None]:
    """Map a request path to ("file", path), ("redirect", None), or ("missing", None), like GitHub Pages.

    A path outside the base or outside the folder, or one with no file, is missing; the folder's own
    path without its trailing slash redirects to it; a directory serves its index.html; and a path with
    no file of its own and no trailing slash serves the .html file of the same name, as /world serves
    world.html and /world/ is missing.
    """
    path = unquote(urlsplit(url_path).path)
    if path == base.rstrip("/"):
        return "redirect", None
    if not path.startswith(base):
        return "missing", None
    rel = posixpath.normpath(path[len(base) :] or ".")
    if rel.startswith("..") or rel.startswith("/"):
        return "missing", None
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        return "missing", None
    if target.is_dir():
        target = target / "index.html"
    elif not target.is_file() and target != root and not path.endswith("/"):
        target = target.with_name(target.name + ".html")
    return ("file", target) if target.is_file() else ("missing", None)


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
            if kind == "redirect":
                self._send(HTTPStatus.MOVED_PERMANENTLY, b"", "text/plain", {"Location": base})
            elif kind == "file" and target is not None:
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

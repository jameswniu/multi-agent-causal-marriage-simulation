"""The in-process reader the read-only demo's exporter asks the API through, checked on small apps of its own.

The exporter (loveworld.static_site) asks LoveWorld's FastAPI app for every answer the free demo serves, inside one
process, through loveworld.asgi_reader. These tests hold the reader to how a server such as uvicorn runs an app: the
app's startup before the first request and its shutdown at the end, an app without a lifespan still read, and each
reply's status, headers and body as the app sent them, errors included.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, MutableMapping
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse

from loveworld.asgi_reader import AppError, AppReader


def _app(events: list[str]) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[dict[str, Any]]:
        events.append("startup")
        yield {"greeting": "hello"}
        events.append("shutdown")

    app = FastAPI(lifespan=lifespan)

    @app.get("/hello")
    def hello(request: Request, name: str = Query("world"), n: int = Query(1, ge=1)) -> dict[str, Any]:
        events.append(f"request {name}")
        return {"text": f"{request.state.greeting} {name}", "n": n}

    @app.get("/bytes")
    def raw() -> Response:
        return Response(content=bytes(range(256)), media_type="application/octet-stream", headers={"X-Kind": "All"})

    @app.get("/stream")
    def stream() -> StreamingResponse:
        return StreamingResponse(iter([b"one,", b"two,", b"three"]), media_type="text/plain")

    @app.get("/missing")
    def missing() -> None:
        raise HTTPException(status_code=404, detail="nothing here")

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("it broke")

    return app


def test_the_lifespan_runs_around_the_requests_and_its_state_reaches_them() -> None:
    events: list[str] = []
    with AppReader(_app(events)) as reader:
        assert events == ["startup"]
        r = reader.get("/hello", {"name": "Ada", "n": 3})
        assert r.status_code == 200 and r.json() == {"text": "hello Ada", "n": 3}
        assert r.header("Content-Type") == "application/json" and r.header("content-length") == str(len(r.content))
    assert events == ["startup", "request Ada", "shutdown"]


def test_bodies_come_back_byte_for_byte_with_their_headers() -> None:
    with AppReader(_app([])) as reader:
        r = reader.get("/bytes")
        assert r.content == bytes(range(256)) and r.header("x-kind") == "All"
        assert reader.get("/stream").content == b"one,two,three"
        with pytest.raises(KeyError):
            r.header("x-none")


def test_error_answers_are_returned_and_a_crash_is_raised() -> None:
    with AppReader(_app([])) as reader:
        missing = reader.get("/missing")
        assert missing.status_code == 404 and missing.json() == {"detail": "nothing here"}
        invalid = reader.get("/hello", {"n": 0})
        assert invalid.status_code == 422
        assert reader.get("/nowhere").status_code == 404
        with pytest.raises(AppError, match="RuntimeError: it broke"):
            reader.get("/boom")
        with pytest.raises(ValueError, match="pass the query as params"):
            reader.get("/hello?name=x")


async def _no_lifespan(scope: MutableMapping[str, Any], receive: Any, send: Any) -> None:
    """A bare ASGI app that refuses the lifespan, as an app that does not support it does."""
    if scope["type"] != "http":
        raise RuntimeError("this app has no lifespan")
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": scope["query_string"], "more_body": True})
    await send({"type": "http.response.body", "body": b"|" + scope["path"].encode()})


def test_an_app_without_a_lifespan_is_still_read() -> None:
    with AppReader(_no_lifespan) as reader:
        r = reader.get("/a b", {"x": "1", "y": "two words"})
    assert r.status_code == 200 and r.content == b"x=1&y=two+words|/a b"


def test_a_failed_startup_stops_the_reader() -> None:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        raise RuntimeError("no database")
        yield

    with pytest.raises(AppError, match="failed to start"):
        with AppReader(FastAPI(lifespan=lifespan)):
            pass


def test_a_reader_that_is_not_open_refuses() -> None:
    with pytest.raises(AppError, match="open the reader first"):
        AppReader(_app([])).get("/hello")

"""Read a web app's answers inside this process, exactly as a server would send them, with no socket or port.

LoveWorld's free read-only demo is a folder of files holding every answer its dashboard needs, asked of the
API ahead of time (python/loveworld/static_site.py). This module is how it asks. It speaks ASGI, the interface
between a Python web server such as uvicorn, which `loveworld serve` runs, and an app such as LoveWorld's
FastAPI one, and it speaks it the way uvicorn does. It runs the app's startup first and its shutdown at the
end (the ASGI lifespan), reading an app that does not take part in the lifespan without one, as uvicorn does.
It hands each GET the request a server would, and it returns the status, the headers and the body bytes
exactly as the app sent them.

It needs nothing beyond the app's own packages, so a plain install (`uv sync --no-dev`) can export the site.
fastapi's TestClient did this job before, but it needs httpx from the dev tools, and Starlette now warns that
running TestClient on httpx is deprecated (it asks for httpx2 instead). A test still checks every kind of read
against TestClient byte for byte.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable, Mapping, MutableMapping
from dataclasses import dataclass
from types import TracebackType
from typing import Any
from urllib.parse import quote, urlencode

Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
App = Callable[[MutableMapping[str, Any], Receive, Send], Awaitable[None]]


class AppError(RuntimeError):
    """The app failed to start or stop, raised while answering, or broke the protocol in its reply."""


@dataclass(frozen=True)
class Reply:
    """One answer: its status, its headers (names in lower case) and its body bytes, as the app sent them."""

    status_code: int
    headers: tuple[tuple[str, str], ...]
    content: bytes

    def header(self, name: str) -> str:
        """Return the first header of this name, in any case; KeyError when the reply has none."""
        want = name.lower()
        for key, value in self.headers:
            if key == want:
                return value
        raise KeyError(name)

    @property
    def text(self) -> str:
        """The body as text."""
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """Read the body as JSON."""
        return json.loads(self.content)


@dataclass
class _Lifespan:
    """The app's lifespan while it runs: the queue into the app, the queue out of it, and its task."""

    inbox: asyncio.Queue[Message]
    outbox: asyncio.Queue[Message]
    task: asyncio.Future[None]


class AppReader:
    """Ask an ASGI app for GET answers in this process. Open it with `with AppReader(app) as reader:`.

    The app's startup runs on entering the block and its shutdown on leaving it. Each `get` runs one request
    to the end and returns its Reply; a reply of any status comes back, and the caller decides what is an error.
    """

    def __init__(self, app: App, host: str = "127.0.0.1", port: int = 8765) -> None:
        """Hold the app; `host` and `port` are what the request says the server is, as uvicorn's would."""
        self.app = app
        self._server = (host, port)
        self._runner: asyncio.Runner | None = None
        self._state: dict[str, Any] = {}
        self._lifespan: _Lifespan | None = None

    def __enter__(self) -> AppReader:
        """Start an event loop for this reader and run the app's startup on it."""
        runner = asyncio.Runner()
        try:
            runner.run(self._startup())
        except BaseException:
            runner.close()
            raise
        self._runner = runner
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Run the app's shutdown, then close the loop."""
        runner, self._runner = self._runner, None
        if runner is None:
            return
        try:
            runner.run(self._shutdown())
        finally:
            runner.close()

    def get(self, path: str, params: Mapping[str, Any] | None = None) -> Reply:
        """GET `path` with `params` as its query string and return the app's answer."""
        if self._runner is None:
            raise AppError("open the reader first: with AppReader(app) as reader")
        return self._runner.run(self._request("GET", path, params))

    async def _startup(self) -> None:
        inbox: asyncio.Queue[Message] = asyncio.Queue()
        outbox: asyncio.Queue[Message] = asyncio.Queue()
        scope: dict[str, Any] = {
            "type": "lifespan",
            "asgi": {"version": "3.0", "spec_version": "2.0"},
            "state": self._state,
        }

        async def receive() -> Message:
            return await inbox.get()

        async def send(message: Message) -> None:
            await outbox.put(message)

        task = asyncio.ensure_future(self.app(scope, receive, send))
        await inbox.put({"type": "lifespan.startup"})
        message = await _next_message(outbox, task)
        if message is None:
            # The app ended or raised without answering: it does not take part in the lifespan, and uvicorn
            # then serves it without one. So does this reader.
            return
        if message["type"] != "lifespan.startup.complete":
            _settle(task)
            if message["type"] == "lifespan.startup.failed":
                raise AppError(f"the app failed to start: {message.get('message', '')}")
            raise AppError(f"the app answered its startup with {message['type']!r}")
        self._lifespan = _Lifespan(inbox, outbox, task)

    async def _shutdown(self) -> None:
        life, self._lifespan = self._lifespan, None
        if life is None:
            return
        await life.inbox.put({"type": "lifespan.shutdown"})
        message = await _next_message(life.outbox, life.task)
        if message is not None and message["type"] == "lifespan.shutdown.failed":
            raise AppError(f"the app failed to shut down: {message.get('message', '')}")
        with contextlib.suppress(Exception):
            await life.task

    async def _request(self, method: str, path: str, params: Mapping[str, Any] | None) -> Reply:
        if "?" in path or "#" in path:
            raise ValueError(f"pass the query as params, not in the path: {path}")
        host, port = self._server
        scope: dict[str, Any] = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "server": (host, port),
            "client": ("127.0.0.1", 50000),
            "scheme": "http",
            "method": method,
            "root_path": "",
            "path": path,
            "raw_path": quote(path).encode("ascii"),
            "query_string": urlencode(params or {}, doseq=True).encode("ascii"),
            "headers": [(b"host", f"{host}:{port}".encode("ascii")), (b"accept", b"*/*")],
            # uvicorn gives each request a shallow copy of what the lifespan stored.
            "state": dict(self._state),
        }
        ended = asyncio.Event()
        asked = False
        status: int | None = None
        headers: list[tuple[str, str]] = []
        body = bytearray()

        async def receive() -> Message:
            nonlocal asked
            if not asked:
                asked = True
                return {"type": "http.request", "body": b"", "more_body": False}
            # A server says the client went away only once the reply is out; an app may wait for that.
            await ended.wait()
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            nonlocal status
            kind = message["type"]
            if kind == "http.response.start":
                if status is not None:
                    raise AppError(f"{method} {path}: the app started its reply twice")
                status = int(message["status"])
                for k, v in message.get("headers", []):
                    headers.append((k.decode("latin-1").lower(), v.decode("latin-1")))
            elif kind == "http.response.body":
                if status is None or ended.is_set():
                    raise AppError(f"{method} {path}: the app sent a body outside its reply")
                body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    ended.set()
            else:
                raise AppError(f"{method} {path}: the app sent {kind!r}, which a plain HTTP server does not take")

        try:
            await self.app(scope, receive, send)
        except AppError:
            raise
        except Exception as e:
            raise AppError(f"{method} {path} raised {type(e).__name__}: {e}") from e
        if status is None or not ended.is_set():
            raise AppError(f"{method} {path}: the app stopped before its reply was complete")
        return Reply(status, tuple(headers), bytes(body))


async def _next_message(outbox: asyncio.Queue[Message], task: asyncio.Future[None]) -> Message | None:
    """Return the app's next lifespan message, or None when its lifespan ended or raised without one."""
    getter = asyncio.ensure_future(outbox.get())
    waiting: set[asyncio.Future[Any]] = {getter, task}
    await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
    if getter.done():
        return getter.result()
    getter.cancel()
    _settle(task)
    return None


def _settle(task: asyncio.Future[None]) -> None:
    """Look at a finished task's exception, if it has one, so the loop never reports it as unread."""
    if task.done() and not task.cancelled():
        task.exception()

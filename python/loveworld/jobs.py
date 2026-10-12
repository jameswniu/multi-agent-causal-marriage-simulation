"""A run queue: engine runs execute one at a time on a worker thread, and callers poll a job id.

A run of 1,000 couples for a year takes seconds of CPU, so the API never runs the engine inside a
request. POST run and POST fork validate the request, queue a job and answer at once; the worker
runs jobs in arrival order; GET /api/jobs/{id} reports queued (with its place in line), running,
done (with the experiment name) or failed (with the message). Only a few jobs may wait, so a burst
of requests meets a plain busy answer instead of an ever-growing line. Jobs live in memory: a
restart forgets them, while finished experiments stay on disk.
"""

from __future__ import annotations

import os
import queue
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

# LoveWorld simulates married agent couples, and one engine run plays a whole population for up to two
# years. LOVEWORLD_QUEUE_MAX is the environment variable that sets how many runs may wait in line behind
# the one running; without it, three may wait.
DEFAULT_MAX_QUEUED = 3
RETAIN_FINISHED = 200


class QueueFull(RuntimeError):
    """Too many jobs are waiting; the endpoint maps this to 429."""


class NameBusy(RuntimeError):
    """A queued or running job already targets this experiment name; the endpoint maps this to 409."""


class JobFailed(RuntimeError):
    """A job the caller waited on failed; carries the HTTP status the failure maps to."""

    def __init__(self, message: str, status_code: int) -> None:
        """Keep the message and the HTTP status it maps to."""
        super().__init__(message)
        self.status_code = status_code


def max_queued_from_env() -> int:
    """LOVEWORLD_QUEUE_MAX when it is a positive integer, else the default."""
    try:
        value = int(os.environ.get("LOVEWORLD_QUEUE_MAX", ""))
    except ValueError:
        return DEFAULT_MAX_QUEUED
    return value if value >= 1 else DEFAULT_MAX_QUEUED


@dataclass
class Job:
    """One queued engine run."""

    id: str
    kind: str
    name: str
    work: Callable[[], dict[str, Any]]
    owner: str | None = None
    state: str = "queued"
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    error: str | None = None
    status_code: int | None = None
    result: dict[str, Any] | None = None
    done: threading.Event = field(default_factory=threading.Event)


ErrorMapper = Callable[[BaseException], tuple[int, str]]


def _default_mapper(e: BaseException) -> tuple[int, str]:
    return 500, f"{type(e).__name__}: {e}"


class JobQueue:
    """A bounded line of jobs and one worker thread that runs them in order."""

    def __init__(self, max_queued: int | None = None, error_mapper: ErrorMapper | None = None) -> None:
        """Allow at most `max_queued` waiting jobs (env LOVEWORLD_QUEUE_MAX, default 3) besides the running one."""
        self.max_queued = max_queued if max_queued is not None else max_queued_from_env()
        if self.max_queued < 1:
            raise ValueError("max_queued must be at least 1")
        self._map = error_mapper or _default_mapper
        self._lock = threading.Lock()
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._line: queue.Queue[Job] = queue.Queue()
        self._worker: threading.Thread | None = None

    def _waiting(self) -> list[Job]:
        return [j for j in self._jobs.values() if j.state == "queued"]

    def _active(self) -> list[Job]:
        return [j for j in self._jobs.values() if j.state in ("queued", "running")]

    def submit(self, kind: str, name: str, work: Callable[[], dict[str, Any]], owner: str | None = None) -> Job:
        """Queue `work`, which runs the engine for experiment `name`; refuse when the line is full."""
        with self._lock:
            if any(j.name == name for j in self._active()):
                raise NameBusy(f"a run for {name!r} is already queued or running")
            if len(self._waiting()) >= self.max_queued:
                raise QueueFull(
                    f"The simulator is busy: {len(self._waiting())} runs are already waiting. Try again in a minute."
                )
            job = Job(id=uuid.uuid4().hex, kind=kind, name=name, work=work, owner=owner)
            self._jobs[job.id] = job
            self._trim()
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._run_forever, name="loveworld-jobs", daemon=True)
                self._worker.start()
        self._line.put(job)
        return job

    def active_for(self, owner: str) -> int:
        """How many of `owner`'s jobs are queued or running."""
        with self._lock:
            return sum(1 for j in self._active() if j.owner == owner)

    def _trim(self) -> None:
        finished = [k for k, j in self._jobs.items() if j.state in ("done", "failed")]
        for key in finished[: max(0, len(finished) - RETAIN_FINISHED)]:
            del self._jobs[key]

    def _run_forever(self) -> None:
        while True:
            job = self._line.get()
            with self._lock:
                job.state = "running"
                job.started = time.time()
            try:
                result = job.work()
            except BaseException as e:  # noqa: BLE001 - every failure is reported on the job
                code, message = self._map(e)
                with self._lock:
                    job.state, job.error, job.status_code = "failed", message, code
                    job.finished = time.time()
            else:
                with self._lock:
                    job.state, job.result = "done", result
                    job.finished = time.time()
            finally:
                job.done.set()
                self._line.task_done()

    def get(self, job_id: str) -> Job | None:
        """Return the job, or None when unknown or forgotten."""
        with self._lock:
            return self._jobs.get(job_id)

    def describe(self, job: Job) -> dict[str, Any]:
        """Describe the job as the API reports it."""
        with self._lock:
            position = None
            if job.state == "queued":
                position = 1 + [j.id for j in self._waiting()].index(job.id)
            return {
                "job_id": job.id,
                "kind": job.kind,
                "name": job.name,
                "state": job.state,
                "position": position,
                "error": job.error,
                "created": job.created,
                "started": job.started,
                "finished": job.finished,
            }

    def wait(self, job: Job, timeout: float | None = None) -> dict[str, Any]:
        """Block until the job finishes; return its result or raise JobFailed with its status."""
        if not job.done.wait(timeout):
            raise JobFailed(f"run {job.name!r} is still {job.state} after {timeout} seconds", 504)
        if job.state == "failed":
            raise JobFailed(job.error or "the run failed", job.status_code or 500)
        return dict(job.result or {})

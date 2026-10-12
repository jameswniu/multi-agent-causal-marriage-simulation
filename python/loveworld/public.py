"""Public mode (LOVEWORLD_PUBLIC=1): the rules that make the dashboard safe to put on the internet.

Off by default, so the local dashboard keeps every power. When on:

- Experiments present at startup are read-only, and overwrite is refused.
- A visitor's runs get server-assigned names in their own namespace, keyed by a signed session
  cookie, are visible only to that visitor, and are deleted after a day with the twins run beside each.
- A run may set only its shocks and the treatment arm's memory half-life for fights, at most
  1,000 couples for 365 days; seeds, control memory and engine settings are fixed.
- The translator has an input cap, a daily cap per client address and a daily cap overall,
  counted on disk so a restart does not reset them. Only real model calls count.
- When an edge secret is set, every POST must come through the edge proxy that checks the bot
  challenge, and the client address is the one that proxy reports.
"""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SESSION_COOKIE = "lw_session"
EDGE_HEADER = "x-loveworld-edge"
CLIENT_IP_HEADER = "x-loveworld-client-ip"
VISITOR_PREFIX = "v-"
_SID = re.compile(r"^[0-9a-f]{12}$")
_VISITOR = re.compile(r"^v-([0-9a-f]{12})-\d{8}-\d{6}(-\d+)?$")
PUBLIC_DIR = ".public"


class QuotaExceeded(RuntimeError):
    """A translation cap is reached; the endpoint maps this to 429."""


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value >= 1 else default


@dataclass
class PublicConfig:
    """Public-mode switches and caps, read from the environment."""

    enabled: bool = False
    max_couples: int = 1000
    max_days: int = 365
    visitor_ttl_hours: int = 24
    translate_per_ip_day: int = 20
    translate_global_day: int = 3000
    edge_secret: str | None = None
    turnstile_site_key: str | None = None
    session_secret: str | None = None

    @classmethod
    def from_env(cls) -> PublicConfig:
        """Read LOVEWORLD_PUBLIC and the caps; anything unset keeps its default."""
        return cls(
            enabled=os.environ.get("LOVEWORLD_PUBLIC", "") in ("1", "true", "yes"),
            max_couples=_env_int("LOVEWORLD_PUBLIC_MAX_COUPLES", 1000),
            max_days=_env_int("LOVEWORLD_PUBLIC_MAX_DAYS", 365),
            visitor_ttl_hours=_env_int("LOVEWORLD_VISITOR_TTL_HOURS", 24),
            translate_per_ip_day=_env_int("LOVEWORLD_TRANSLATE_PER_IP_DAY", 20),
            translate_global_day=_env_int("LOVEWORLD_TRANSLATE_GLOBAL_DAY", 3000),
            edge_secret=os.environ.get("LOVEWORLD_EDGE_SECRET") or None,
            turnstile_site_key=os.environ.get("LOVEWORLD_TURNSTILE_SITE_KEY") or None,
            session_secret=os.environ.get("LOVEWORLD_SESSION_SECRET") or None,
        )


def _secret_file(root: Path) -> bytes:
    """Return a per-deployment signing secret kept beside the results, created once with owner-only permissions.

    Several processes may start at once: the first creates the file, and the others read what it wrote.
    """
    d = root / PUBLIC_DIR
    d.mkdir(parents=True, exist_ok=True)
    path = d / "secret"
    try:
        existing = path.read_bytes().strip()
    except FileNotFoundError:
        existing = b""
    if existing:
        return existing
    value = secrets.token_hex(32).encode()
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        # Another process won the race; wait briefly for it to finish writing, then use its secret.
        for _ in range(250):
            existing = path.read_bytes().strip()
            if existing:
                return existing
            time.sleep(0.02)
        raise RuntimeError(f"{path} exists but stayed empty; remove it and restart") from None
    try:
        os.write(fd, value)
    finally:
        os.close(fd)
    return value


class Sessions:
    """Signed visitor ids: the cookie is `<id>.<hmac>`, so a visitor cannot pick someone else's namespace."""

    def __init__(self, secret: bytes) -> None:
        """Sign with `secret`."""
        self._secret = secret

    def _sign(self, sid: str) -> str:
        return hmac.new(self._secret, sid.encode(), hashlib.sha256).hexdigest()[:32]

    def new(self) -> tuple[str, str]:
        """Return a fresh visitor id and its cookie value."""
        sid = secrets.token_hex(6)
        return sid, f"{sid}.{self._sign(sid)}"

    def verify(self, cookie: str | None) -> str | None:
        """Return the visitor id in a valid cookie, else None."""
        if not cookie or "." not in cookie:
            return None
        sid, sig = cookie.split(".", 1)
        if not _SID.fullmatch(sid) or not hmac.compare_digest(sig, self._sign(sid)):
            return None
        return sid

    def hash_ip(self, ip: str) -> str:
        """Return a keyed hash of a client address, so the counters never store raw addresses."""
        return hmac.new(self._secret, b"ip:" + ip.encode(), hashlib.sha256).hexdigest()[:16]


def visitor_name(sid: str, taken: set[str]) -> str:
    """Return a server-assigned experiment name in the visitor's namespace, unique among `taken`."""
    base = f"{VISITOR_PREFIX}{sid}-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}"
    name, n = base, 1
    while name in taken:
        n += 1
        name = f"{base}-{n}"
    return name


def owner_of(name: str) -> str | None:
    """Return the visitor id a server-assigned name belongs to, or None for any other name."""
    m = _VISITOR.fullmatch(name)
    return m.group(1) if m else None


class Counters:
    """Daily translation counts per client and overall, on disk, reset at UTC midnight.

    Every read-check-write holds an exclusive lock on a sibling lock file, so several server
    processes sharing the results root count one quota between them.
    """

    def __init__(self, root: Path, per_ip: int, global_cap: int) -> None:
        """Keep counts in `<root>/.public/counters.json`."""
        self._path = root / PUBLIC_DIR / "counters.json"
        self._lock_path = root / PUBLIC_DIR / "counters.lock"
        self._per_ip = per_ip
        self._global = global_cap
        self._lock = threading.Lock()

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, open(self._lock_path, "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _load(self, today: str) -> dict[str, Any]:
        try:
            data = json.loads(self._path.read_text())
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict) or data.get("day") != today:
            return {"day": today, "global": 0, "per_ip": {}}
        data.setdefault("global", 0)
        data.setdefault("per_ip", {})
        return data

    def _save(self, data: dict[str, Any]) -> None:
        fd, tmp = tempfile.mkstemp(prefix=".counters.", suffix=".tmp", dir=self._path.parent)
        try:
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(data, sort_keys=True))
            os.replace(tmp, self._path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def take(self, ip_key: str) -> None:
        """Count one model call for `ip_key`, or raise QuotaExceeded without counting it."""
        today = time.strftime("%Y-%m-%d", time.gmtime())
        with self._locked():
            data = self._load(today)
            mine = int(data["per_ip"].get(ip_key, 0))
            if int(data["global"]) >= self._global:
                raise QuotaExceeded(
                    "LoveWorld has used today's translations. Add the shock by hand below, or come back tomorrow."
                )
            if mine >= self._per_ip:
                raise QuotaExceeded(
                    f"You have used today's {self._per_ip} translations. "
                    "Add the shock by hand below, or come back tomorrow."
                )
            data["global"] = int(data["global"]) + 1
            data["per_ip"][ip_key] = mine + 1
            self._save(data)

    def snapshot(self) -> dict[str, Any]:
        """Return today's counts, for tests and operators."""
        with self._locked():
            return self._load(time.strftime("%Y-%m-%d", time.gmtime()))


_SIBLING = re.compile(r"-(twins|placebo)$")


def _made_at(d: Path) -> float | None:
    """When the run in `d` was written: its manifest's stamp, or its control twin's, else None."""
    for manifest in (d / "manifest.json", d / "control" / "manifest.json"):
        try:
            return float(json.loads(manifest.read_text()).get("generated_at_unix") or 0)
        except (OSError, ValueError, AttributeError):
            continue
    return None


def sweep(root: Path, ttl_hours: int, now: float | None = None, keep: set[str] | None = None) -> list[str]:
    """Delete visitor experiments older than `ttl_hours`, with the twins or placebo run beside each.

    Names in `keep` (the curated set) and their siblings are never touched. A sibling ages with the
    run it belongs to while that run is there, so the two leave together.
    """
    now = time.time() if now is None else now
    keep = keep or set()
    # Every age is read before anything is deleted, so a sibling still sees the run it belongs to.
    ages: list[tuple[Path, float]] = []
    for child in sorted(root.iterdir()):
        base = _SIBLING.sub("", child.name)
        if child.name in keep or base in keep or owner_of(base) is None:
            continue
        if not child.is_dir() or child.is_symlink():
            continue
        if child.resolve().parent != root.resolve():
            continue
        made = _made_at(root / base) if base != child.name else None
        if made is None:
            made = _made_at(child)
        ages.append((child, child.stat().st_mtime if made is None else made))
    removed = []
    for child, made in ages:
        if now - made >= ttl_hours * 3600:
            shutil.rmtree(child, ignore_errors=True)
            removed.append(child.name)
    return removed


class Public:
    """Public-mode state for one app: the session signer, the counters and the curated names."""

    def __init__(self, config: PublicConfig, root: Path, curated: set[str]) -> None:
        """Bind the config to a results root whose current experiments become read-only."""
        self.config = config
        self.root = root
        self.curated = set(curated)
        secret = config.session_secret.encode() if config.session_secret else _secret_file(root)
        self.sessions = Sessions(secret)
        self.counters = Counters(root, config.translate_per_ip_day, config.translate_global_day)
        self._sweeper: threading.Thread | None = None

    def visible(self, name: str, sid: str | None) -> bool:
        """Tell whether `name` is curated or one of this visitor's own runs."""
        return name in self.curated or (sid is not None and owner_of(name) == sid)

    def start_sweeper(self, on_removed: Any = None, every_s: float = 600.0) -> None:
        """Sweep now and then every `every_s` seconds on a daemon thread."""

        def loop() -> None:
            while True:
                for name in sweep(self.root, self.config.visitor_ttl_hours, keep=self.curated):
                    if on_removed is not None:
                        on_removed(name)
                time.sleep(every_s)

        if self._sweeper is None:
            self._sweeper = threading.Thread(target=loop, name="loveworld-sweeper", daemon=True)
            self._sweeper.start()

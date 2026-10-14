"""The read-only demo's pre-run shocks: frozen fork requests, and the worlds they make.

LoveWorld simulates married agent couples, and its dashboard lets a visitor shock a finished world: the
same couples run again with one event added. The free demo on GitHub Pages has no server, so it cannot
run the engine or ask a model to translate a sentence. Its shocks are run in advance instead, and each
file in experiments/demo/ freezes one of them:

- `name`, `order` and `title`: the world it makes and how the demo lists it.
- `words`: the request in plain words, and `typed`: whether those are the words someone typed into the
  shock box. Typed words must match the translation record's fingerprint, `text_sha256`, a SHA-256 of
  the text lowercased with its spacing collapsed (never the text itself). The fingerprint cannot tell
  case or spacing, so those come from where the words were seen typed, such as the README's recording.
- `parent` and `hits`: the world it forks (the example) and whether it hits the treatment arm or every
  couple (`all`).
- `shocks`: the shock specs exactly as the app validates and runs them (each with its own target).
- `translation`: for a shock a model translated, the saved translation record and when it was recorded,
  or null for a shock built from the catalog by hand. The model is never called again.
- `note`: where the shock came from, in a sentence.

`build_demo` replays a file through the fork endpoint's own code (`forking.plan_fork`, then
`forking.run_fork`, which runs the world and its twins with `runner.run_with_twins`), with the saved
record standing in for the translator, so a demo world is exactly what the live app makes from the same
request, translation.json and parent.json included.
"""

from __future__ import annotations

import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loveworld import forking, runner, translate
from loveworld.analysis import load_tables
from loveworld.engine import REPO_ROOT
from loveworld.experiment import Shock
from loveworld.schema import SAFE_NAME

DEMO_DIR = REPO_ROOT / "experiments" / "demo"
DEMO_KEYS = ("name", "order", "title", "words", "typed", "parent", "hits", "shocks", "translation", "note")
TRANSLATION_KEYS = ("shock_index", "recorded", "record")
RECORD_KEYS = (
    "translation_id",
    "status",
    "spec",
    "words",
    "rationale",
    "model",
    "text_sha256",
    "days",
    "errors",
    "message",
)
# Records written since the translator stamps them also carry when they were written.
OPTIONAL_RECORD_KEYS = ("recorded",)
HITS = ("treatment", "all")
DEMO_PREFIX = "demo-"
TITLE_MAX_CHARS = 60
WORDS_MAX_CHARS = 400
_ID = re.compile(r"^[0-9a-f]{32}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_RECORDED = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")


class DemoError(ValueError):
    """A demo file is invalid, or its world cannot be built or no longer matches it."""


@dataclass(frozen=True)
class Demo:
    """One pre-run shock of the read-only demo, as frozen in experiments/demo/."""

    path: Path
    name: str
    order: int
    title: str
    words: str
    typed: bool
    parent: str
    hits: str
    shocks: list[dict[str, Any]]
    translation: dict[str, Any] | None
    note: str

    @property
    def record(self) -> dict[str, Any] | None:
        """The saved translation record, or None for a shock built from the catalog."""
        return self.translation["record"] if self.translation is not None else None


def _text(value: Any, key: str, where: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise DemoError(f"{where}: {key} must be a non-empty string of at most {limit} characters")
    return value


def load_demo(path: Path) -> Demo:
    """Read and check the shape of one demo file; `check_demo` checks its shocks against a world."""
    where = path.name
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise DemoError(f"{where}: cannot read it as JSON: {e}") from e
    if not isinstance(raw, dict):
        raise DemoError(f"{where}: must be a JSON object")
    keys = set(raw)
    if keys != set(DEMO_KEYS):
        missing, extra = sorted(set(DEMO_KEYS) - keys), sorted(keys - set(DEMO_KEYS))
        raise DemoError(f"{where}: keys must be exactly {', '.join(DEMO_KEYS)} (missing {missing}, unknown {extra})")
    name = raw["name"]
    if (
        not isinstance(name, str)
        or not SAFE_NAME.fullmatch(name)
        or not name.startswith(DEMO_PREFIX)
        or name.endswith(("-placebo", "-twins"))
    ):
        raise DemoError(
            f"{where}: name must start with {DEMO_PREFIX!r}, match {SAFE_NAME.pattern}, "
            "and not end in -placebo or -twins"
        )
    order = raw["order"]
    if isinstance(order, bool) or not isinstance(order, int) or order < 1:
        raise DemoError(f"{where}: order must be a positive integer")
    parent = raw["parent"]
    if not isinstance(parent, str) or not SAFE_NAME.fullmatch(parent):
        raise DemoError(f"{where}: parent must name a world")
    if raw["hits"] not in HITS:
        raise DemoError(f"{where}: hits must be one of {list(HITS)}")
    if not isinstance(raw["typed"], bool):
        raise DemoError(f"{where}: typed must be true or false")
    shocks = raw["shocks"]
    if not isinstance(shocks, list) or not shocks or not all(isinstance(s, dict) for s in shocks):
        raise DemoError(f"{where}: shocks must be a non-empty list of shock specs")
    translation = raw["translation"]
    if translation is not None:
        _check_translation(translation, len(shocks), where)
    if raw["typed"] and translation is None:
        raise DemoError(f"{where}: typed words need the translation record that holds their hash")
    return Demo(
        path=path,
        name=name,
        order=order,
        title=_text(raw["title"], "title", where, TITLE_MAX_CHARS),
        words=_text(raw["words"], "words", where, WORDS_MAX_CHARS),
        typed=raw["typed"],
        parent=parent,
        hits=raw["hits"],
        shocks=[dict(s) for s in shocks],
        translation=dict(translation) if translation is not None else None,
        note=_text(raw["note"], "note", where, 600),
    )


def _check_translation(t: Any, n_shocks: int, where: str) -> None:
    """Check a translation block: which shock it became, when it was recorded, and the saved record itself."""
    if not isinstance(t, dict) or set(t) != set(TRANSLATION_KEYS):
        raise DemoError(f"{where}: translation must have exactly {', '.join(TRANSLATION_KEYS)}")
    idx = t["shock_index"]
    if isinstance(idx, bool) or not isinstance(idx, int) or not 0 <= idx < n_shocks:
        raise DemoError(f"{where}: translation.shock_index must point at one of the shocks")
    if not isinstance(t["recorded"], str) or not _RECORDED.fullmatch(t["recorded"]):
        raise DemoError(f"{where}: translation.recorded must be a timestamp like 2026-10-12T01:33:33-07:00")
    rec = t["record"]
    if not isinstance(rec, dict) or set(rec) - set(OPTIONAL_RECORD_KEYS) != set(RECORD_KEYS):
        raise DemoError(f"{where}: translation.record must be a saved translation record ({', '.join(RECORD_KEYS)})")
    if "recorded" in rec and rec["recorded"] != t["recorded"]:
        raise DemoError(f"{where}: translation.recorded must be the time the record itself gives, {rec['recorded']!r}")
    if not isinstance(rec["translation_id"], str) or not _ID.fullmatch(rec["translation_id"]):
        raise DemoError(f"{where}: translation.record.translation_id must be 32 hex characters")
    if not isinstance(rec["text_sha256"], str) or not _SHA.fullmatch(rec["text_sha256"]):
        raise DemoError(f"{where}: translation.record.text_sha256 must be a SHA-256")
    if rec["status"] != "ok" or not isinstance(rec["spec"], dict):
        raise DemoError(f"{where}: only a translation that came back ok can be run")
    if not isinstance(rec["model"], str) or not rec["model"]:
        raise DemoError(f"{where}: translation.record.model must name the model")


def load_demos(directory: Path = DEMO_DIR) -> list[Demo]:
    """Read every demo file in `directory`, in their order; names and orders must not repeat."""
    demos = [load_demo(p) for p in sorted(Path(directory).glob("*.json"))]
    for attr in ("name", "order"):
        seen: dict[Any, str] = {}
        for d in demos:
            value = getattr(d, attr)
            if value in seen:
                raise DemoError(f"{d.path.name} and {seen[value]} share the {attr} {value!r}")
            seen[value] = d.path.name
    return sorted(demos, key=lambda d: (d.order, d.name))


def pinned_translations(directory: Path = DEMO_DIR) -> list[translate.Translation]:
    """Return the saved translation each demo card holds, dated as the card dates it, for the live app's translator.

    The translator answers a card's words from these before any record on disk (`translate.Translator`), so words
    a card shows typed come back as the shock it shows, in any results root and in a fresh clone whose
    `.translations` holds no record of them. A card that does not load is left out; `loveworld demo` reports it.
    """
    cards = []
    for path in sorted(Path(directory).glob("*.json")):
        try:
            cards.append(load_demo(path))
        except DemoError:
            continue
    return [
        translate.Translation(**{**d.translation["record"], "recorded": d.translation["recorded"]})
        for d in sorted(cards, key=lambda d: (d.order, d.name))
        if d.translation is not None
    ]


def hits_of(shocks: list[Shock]) -> str:
    """Which houses a fork's shocks reach: every couple when any shock targets all, else the treatment arm."""
    return "all" if any(s.target == "all" for s in shocks) else "treatment"


def check_demo(demo: Demo, days: int) -> list[Shock]:
    """Validate a demo's shocks with the fork endpoint's parser for a run of `days` days; return them parsed.

    Each stored spec must already be the form the app runs (what `Shock.to_engine` writes into the config),
    its `hits` must follow from the targets, a translated shock must be the shock as translated (unedited),
    and typed words must hash to the record's `text_sha256`.
    """
    where = demo.path.name
    try:
        shocks = forking.parse_fork_shocks(demo.shocks, days)
    except ValueError as e:
        raise DemoError(f"{where}: {e}") from e
    for i, (stored, shock) in enumerate(zip(demo.shocks, shocks, strict=True)):
        if stored != shock.to_engine():
            raise DemoError(f"{where}: shocks[{i}] is not in the form the app runs, which is {shock.to_engine()}")
    if demo.hits != hits_of(shocks):
        raise DemoError(f"{where}: hits must be {hits_of(shocks)!r} for these targets")
    if demo.translation is not None:
        rec = demo.translation["record"]
        shock = shocks[demo.translation["shock_index"]]
        if translate.comparable(rec["spec"]) != translate.comparable(translate.spec_of(shock)):
            raise DemoError(
                f"{where}: the shock differs from the shock as translated in record {rec['translation_id']}"
            )
        if rec["days"] != days:
            raise DemoError(f"{where}: the record translated for {rec['days']} days, the parent runs {days}")
    record = demo.record
    if demo.typed and (record is None or translate.text_sha256(demo.words) != record["text_sha256"]):
        raise DemoError(f"{where}: typed words must hash to the record's text_sha256; these do not")
    return shocks


def _no_model() -> None:
    """Stand in for the translator's client: the demo never calls a model, so any attempt fails."""
    return None


def translation_file(demo: Demo, shocks: list[Shock]) -> dict[str, Any] | None:
    """Write translation.json from the saved record, through the server's own provenance code."""
    if demo.translation is None:
        return None
    rec = demo.translation["record"]
    with tempfile.TemporaryDirectory(prefix="loveworld-demo-") as tmp:
        (Path(tmp) / f"{rec['translation_id']}.json").write_text(json.dumps(rec, sort_keys=True))
        translator = translate.Translator(client_factory=_no_model, record_dir=Path(tmp))
        out = translate.translation_file(translator, [(rec["translation_id"], demo.translation["shock_index"])], shocks)
    for entry in out["translations"]:
        if not entry.get("verified") or entry.get("edited"):
            raise DemoError(f"{demo.path.name}: the saved record did not verify as the shock that runs")
    return out


def build_demo(demo: Demo, results_root: Path) -> dict[str, Any]:
    """Run one demo world (and its twins) into `results_root`, replacing an earlier build of it; return its summary.

    The parent must already be in the root. The fork goes through `forking.plan_fork` and `forking.run_fork`,
    as POST /api/experiments/fork does, so the world carries the same parent.json, translation.json and twins.
    """
    root = Path(results_root)
    parent_dir = root / demo.parent
    if not runner.is_results_dir(parent_dir) or not (parent_dir / "summary.json").is_file():
        raise DemoError(
            f"{demo.path.name}: the parent world {demo.parent!r} is not in {root}; run it first (make example)"
        )
    days = int(json.loads((parent_dir / "config.json").read_text())["days"])
    check_demo(demo, days)
    plan = forking.plan_fork(demo.parent, parent_dir, demo.shocks, demo.name)
    record = translation_file(demo, plan.shocks)
    extra = {"translation.json": record} if record is not None else None
    summary = forking.run_fork(plan, root / demo.name, extra_files=extra, overwrite=True)
    made = json.loads((root / demo.name / "parent.json").read_text())
    parent_hash = json.loads((parent_dir / "manifest.json").read_text()).get("determinism_hash")
    if made.get("parent_determinism_hash") != parent_hash or not made["comparison"].get("comparable"):
        raise DemoError(f"{demo.name}: the parent changed while the demo world ran; run make demo again")
    return summary


def check_built(demo: Demo, results_root: Path) -> list[Shock]:
    """Check that the world in the root is this demo's, forked from the parent as it is on disk now."""
    root = Path(results_root)
    child, parent_dir = root / demo.name, root / demo.parent
    if not runner.is_results_dir(parent_dir):
        raise DemoError(f"the parent world {demo.parent!r} is not in {root}; run make example, then make demo")
    if not runner.is_results_dir(child) or not (child / "parent.json").is_file():
        raise DemoError(f"{demo.name} is not in {root}; run make demo")
    days = int(json.loads((parent_dir / "config.json").read_text())["days"])
    shocks = check_demo(demo, days)
    record = json.loads((child / "parent.json").read_text())
    if record.get("parent") != demo.parent or record.get("appended_shocks") != [s.to_engine() for s in shocks]:
        raise DemoError(f"{demo.name} in {root} was made from other shocks than {demo.path.name}; run make demo")
    parent_hash = json.loads((parent_dir / "manifest.json").read_text()).get("determinism_hash")
    if record.get("parent_determinism_hash") != parent_hash:
        raise DemoError(
            f"{demo.parent} was run again after {demo.name} was made, so no house would be compared; run make demo"
        )
    return shocks


def differing_per_day(parent_dir: Path, child_dir: Path) -> list[int]:
    """Count, per day, the starting couples whose state differs between a fork and its parent (the town's rings)."""
    from loveworld.api import build_world

    parent, child = build_world(load_tables(parent_dir)), build_world(load_tables(child_dir))
    index = {
        cid: j for j, (cid, o) in enumerate(zip(parent["couples"], parent["origin"], strict=True)) if o != "remarriage"
    }
    pairs = [
        (i, index[cid])
        for i, (cid, o) in enumerate(zip(child["couples"], child["origin"], strict=True))
        if o != "remarriage" and cid in index
    ]
    out = []
    for day in range(min(len(parent["states"]), len(child["states"]))):
        a, b = child["states"][day], parent["states"][day]
        out.append(sum(1 for i, j in pairs if a[i] != b[j]))
    return out

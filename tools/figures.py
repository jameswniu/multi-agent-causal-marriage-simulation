#!/usr/bin/env python3
"""Generate the README figures from the repository's own numbers.

Three SVGs land in docs/figures: a hero band, a map of how a run flows, and a results panel read
from results/example/summary.json. Every text run passes a fit guard, so a string that would
overflow its box fails generation with the string named, and nothing in the panels is typed by
hand. Each figure's alt text is generated from the same numbers, and the README's copy of it is
kept in step, so a new run cannot leave a stale number in the page's text either.

    python3 tools/figures.py --write    # regenerate the SVGs and the README alt text in place
    python3 tools/figures.py --check    # regenerate in memory and fail on any difference
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
SUMMARY = ROOT / "results" / "example" / "summary.json"
OUT = ROOT / "docs" / "figures"
README = ROOT / "README.md"

VIEW_W = 1200
PAD = 48

# One dark palette, owned by this repository. ROSE is the single accent and appears only on the
# hero's top rule and on headings. CONTROL and TREATMENT encode the two arms wherever they appear,
# the same blue and orange the dashboard uses, lightened to read on the dark ground.
GROUND = "#0e1119"
RAISED = "#161a24"
TRACK = "#232a3a"
HAIRLINE = "#2b3242"
INK = "#eef0f4"
SOFT = "#c9cdd6"
DIM = "#9aa1ae"
ROSE = "#d4627c"
CONTROL = "#6ea8fe"
TREATMENT = "#f5a05e"

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

MIN_FONT = 23


def fits(text: str, size: float, box_w: float, pad: float, bold: bool = False, where: str = "", mono: bool = False) -> None:
    """Refuse a text run that would overflow its box, naming the string."""
    if size < MIN_FONT:
        raise SystemExit(f"font {size} under the {MIN_FONT} floor {where}: {text!r}")
    factor = 0.62 if bold or mono else 0.58
    est = len(text) * size * factor
    room = box_w - 2 * pad
    if est > room:
        raise SystemExit(f"text does not fit {where}: {text!r} needs {est:.0f} of {room:.0f}")


def width(text: str, size: float, bold: bool = False, mono: bool = False) -> float:
    """The same width estimate the fit guard uses, for laying out runs side by side."""
    return len(text) * size * (0.62 if bold or mono else 0.58)


def fits_row(total: float, room: float, where: str, parts: list[str]) -> None:
    """Refuse a row of runs laid side by side whose combined width overflows, naming the runs."""
    if total > room:
        raise SystemExit(f"row does not fit {where}: {parts!r} needs {total:.0f} of {room:.0f}")


def attr(s: str) -> str:
    return escape(s, {'"': "&quot;"})


def text(x: float, y: float, s: str, size: float, fill: str = INK, bold: bool = False, anchor: str = "start", mono: bool = False, spacing: float = 0) -> str:
    family = MONO if mono else SANS
    weight = ' font-weight="700"' if bold else ""
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    return f'<text x="{x:.0f}" y="{y:.0f}" font-family="{attr(family)}" font-size="{size}" fill="{fill}"{weight} text-anchor="{anchor}"{ls}>{escape(s)}</text>'


def card(x: float, y: float, w: float, h: float, fill: str = RAISED) -> str:
    return f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" rx="10" fill="{fill}" stroke="{HAIRLINE}" stroke-width="1.5"/>'


def bar(x: float, y: float, w: float, h: float, fill: str) -> str:
    return f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" rx="4" fill="{fill}"/>'


def open_svg(h: int, label: str, rule: bool = False) -> str:
    """The dark ground with rounded corners, and the rose rule along the top when asked for."""
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW_W} {h}" width="100%" role="img" aria-label="{attr(label)}">',
        f'<clipPath id="frame"><rect width="{VIEW_W}" height="{h}" rx="14"/></clipPath>',
        '<g clip-path="url(#frame)">',
        f'<rect width="{VIEW_W}" height="{h}" fill="{GROUND}"/>',
    ]
    if rule:
        parts.append(f'<rect width="{VIEW_W}" height="5" fill="{ROSE}"/>')
    parts.append("</g>")
    parts.append(f'<rect x="0.75" y="0.75" width="{VIEW_W - 1.5}" height="{h - 1.5}" rx="14" fill="none" stroke="{HAIRLINE}" stroke-width="1.5"/>')
    return "\n".join(parts) + "\n"


def load_summary() -> dict:
    with SUMMARY.open() as fh:
        return json.load(fh)


def outcome(summary: dict, name: str) -> dict:
    for o in summary["outcomes"]:
        if o["name"] == name:
            return o
    raise SystemExit(f"outcome {name} missing from {SUMMARY}")


def pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def digits(o: dict) -> int:
    return 2 if o["unit"].startswith("trust") else 1


def fmt_value(o: dict, v: float) -> str:
    return pct(v) if o["type"] == "binary" else f"{v:.{digits(o)}f}"


def js_round(x: float) -> int:
    """Round half up, as the dashboard's Math.round does, so both say the same span."""
    return int(math.floor(x + 0.5))


def human_duration(days: float) -> str:
    """Days to a rounded human span, the dashboard's humanDuration: days, then weeks, then months."""
    if not math.isfinite(days) or days <= 0:
        return f"{days:g} days"
    if days < 7:
        d = js_round(days)
        return f"{d} day" if d == 1 else f"{d} days"
    if days < 60:
        w = max(1, js_round(days / 7))
        return f"{w} week" if w == 1 else f"{w} weeks"
    return f"{max(2, js_round(days / 30))} months"


def memory_values(summary: dict) -> tuple[float, float] | None:
    """The conflict half-lives of the two arms, when the experiment changes them."""
    t = summary["experiment"].get("treatment") or {}
    cv, tv = t.get("control_value"), t.get("treatment_value")
    if t.get("parameter") != "conflict_half_life_days" or not isinstance(cv, (int, float)) or not isinstance(tv, (int, float)) or cv == tv:
        return None
    return float(cv), float(tv)


def arm_words(summary: dict) -> tuple[str, str]:
    """What a first-time reader sees for each arm, in the dashboard's own words."""
    mem = memory_values(summary)
    if mem is None:
        return "Control", "Treatment"
    cv, tv = mem

    def words(own: float, other: float) -> str:
        return f"Holds onto fights for {human_duration(own)}" if own > other else f"Forgets fights in {human_duration(own)}"

    return words(cv, tv), words(tv, cv)


def days_words(v: float) -> str:
    return f"{v:g}-day"


def effect_words(o: dict, per: str = "") -> tuple[str, str]:
    """The effect in plain words and its interval, for one outcome."""
    ate = o["ate"]
    scale = 100 if o["type"] == "binary" else 1
    d = 1 if o["type"] == "binary" else digits(o)
    size = f"{abs(ate) * scale:.{d}f}"
    unit = " points" if o["type"] == "binary" else (f" {per}" if per else "")
    if ate > 0:
        head = f"Up {size}{unit}"
    elif ate < 0:
        head = f"Down {size}{unit}"
    else:
        head = "No change"
    ci = f"95% CI {o['ci_low'] * scale:.{d}f} to {o['ci_high'] * scale:.{d}f}"
    return head, ci


# ---------------------------------------------------------------- hero

def hero_tiles(days: int) -> list[tuple[str, str, str]]:
    """Outcome, heading and the per-unit word of each hero card; the headings follow the run length."""
    year = days == 365
    return [
        ("divorce_rate", "Divorced in a year" if year else f"Divorced in {days} days", ""),
        ("final_trust", "Trust at year end" if year else "Trust on the last day", ""),
        ("conflict_rate", "Conflicts per couple", "a year"),
    ]


def hero(summary: dict) -> tuple[str, str]:
    exp = summary["experiment"]
    title = "What does a grudge do to a marriage?"
    span = "one year" if exp["days"] == 365 else f"{exp['days']} days"
    sub = f"{exp['n_couples']:,} agent couples, {span}, one memory setting changed"
    c_words, t_words = arm_words(summary)
    lead = "Redrawn from the example run by"
    cmd = "python3 tools/figures.py --write"

    h = 516
    cx = VIEW_W / 2
    p = [open_svg(h, f"{title} {sub}", rule=True)]
    fits(title, 46, VIEW_W, PAD, bold=True, where="hero title")
    p.append(text(cx, 90, title, 46, INK, bold=True, anchor="middle"))
    fits(sub, 26, VIEW_W, PAD, where="hero subtitle")
    p.append(text(cx, 134, sub, 26, DIM, anchor="middle"))

    # The legend says what blue and orange mean before any number does.
    sw, sgap, igap = 18, 12, 52
    items = [(c_words, CONTROL), (t_words, TREATMENT)]
    total = sum(sw + sgap + width(w, 23) for w, _ in items) + igap
    fits_row(total, VIEW_W - 2 * PAD, "hero legend", [w for w, _ in items])
    x = cx - total / 2
    for words, color in items:
        p.append(bar(x, 162, sw, sw, color))
        p.append(text(x + sw + sgap, 178, words, 23, SOFT))
        x += sw + sgap + width(words, 23) + igap

    gap = 20
    side = 40
    tile_w = (VIEW_W - 2 * side - 2 * gap) / 3
    tile_h = 248
    ty = 204
    inner = 24
    tiles = []
    for i, (name, label, per) in enumerate(hero_tiles(exp["days"])):
        o = outcome(summary, name)
        x = side + i * (tile_w + gap)
        p.append(card(x, ty, tile_w, tile_h))
        fits(label, 24, tile_w, inner, bold=True, where=f"hero tile {i} heading")
        p.append(text(x + inner, ty + 46, label, 24, ROSE, bold=True))

        values = [(o["control_mean"], CONTROL), (o["treatment_mean"], TREATMENT)]
        labels = [fmt_value(o, v) for v, _ in values]
        val_w = max(width(s, 34, bold=True) for s in labels)
        bx = x + inner + val_w + 18
        bw = x + tile_w - inner - bx
        if bw < 60:
            raise SystemExit(f"hero tile {i}: no room left for the bars beside {labels}")
        top = max(abs(v) for v, _ in values) or 1.0
        for k, ((v, color), s) in enumerate(zip(values, labels)):
            fits(s, 34, val_w + 2 * inner, inner, bold=True, where=f"hero tile {i} value {k}")
            base = ty + 104 + k * 52
            p.append(text(x + inner, base, s, 34, color, bold=True))
            p.append(bar(bx, base - 22, bw, 22, TRACK))
            p.append(bar(bx, base - 22, max(4.0, bw * abs(v) / top), 22, color))

        head, ci = effect_words(o, per)
        fits(head, 24, tile_w, inner, bold=True, where=f"hero tile {i} effect")
        p.append(text(x + inner, ty + 202, head, 24, INK, bold=True))
        fits(ci, 23, tile_w, inner, where=f"hero tile {i} interval")
        p.append(text(x + inner, ty + 232, ci, 23, DIM))
        tiles.append((label, labels, head, ci))

    lw, cw = width(lead, 23), width(cmd, 23, mono=True)
    fits_row(lw + 12 + cw, VIEW_W - 2 * PAD, "hero footer", [lead, cmd])
    # One text run with the command as a tspan, so the browser spaces the two fonts itself.
    p.append(
        f'<text x="{cx:.0f}" y="{h - 26}" font-family="{attr(SANS)}" font-size="23" fill="{DIM}" text-anchor="middle">'
        f'{escape(lead)} <tspan font-family="{attr(MONO)}">{escape(cmd)}</tspan></text>'
    )
    p.append("</svg>\n")

    if memory_values(summary) is None:
        arms = "Blue is the control arm, orange the treatment arm."
    else:
        arms = f"Blue is the arm that {c_words.lower()}, orange the arm that {t_words.lower()}."
    parts = [f"{title} LoveWorld runs {exp['n_couples']:,} agent couples for {span}, with one memory setting changed between the arms.", arms]
    for label, (c, t), head, ci in tiles:
        parts.append(f"{label}, {c} against {t}, {head.lower()}, {ci}.")
    parts.append(f"{lead} {cmd}.")
    return "\n".join(p), " ".join(parts)


# ---------------------------------------------------------------- how a run flows


def map_sections() -> list[dict]:
    return [
        {
            "code": "01",
            "head": "THE EXPERIMENT FILE",
            "note": "One YAML file is the whole experiment",
            "cards": [
                {
                    "title": "experiments/example.yaml",
                    "lines": ["Couples, days, three seeds, the treatment memory half-life, and any shocks.", "Python turns it into the engine's config JSON and keeps both."],
                    "foot": "loveworld run experiments/example.yaml",
                },
            ],
        },
        {
            "code": "02",
            "head": "THE ENGINE",
            "note": "Rust on Bevy ECS, headless, deterministic",
            "cards": [
                {
                    "title": "One schedule, every day",
                    "lines": ["Stress, affect, conflict decision,", "trust, memory decay, market, log.", "Every draw keyed by seed and id."],
                    "foot": "loveworld-engine run --config",
                },
                {
                    "title": "What it writes",
                    "lines": ["Eight Parquet tables, one manifest", "with a SHA-256 per table.", "Replay fails on any mismatch."],
                    "foot": "loveworld-engine replay --manifest",
                },
            ],
        },
        {
            "code": "03",
            "head": "THE ANALYSIS",
            "note": "Python reads the tables and writes summary.json",
            "cards": [
                {
                    "title": "Effects with intervals",
                    "lines": ["Effect per outcome, with bootstrap", "intervals and permutation p-values.", "Conditional outcomes are flagged."],
                    "foot": "loveworld analyze results/example",
                },
                {
                    "title": "Two checks on every experiment",
                    "lines": ["Placebo: equal parameters, both", "arms must match byte for byte.", "Twins: each couple under both arms."],
                    "foot": "make placebo && make twins",
                },
            ],
        },
        {
            "code": "04",
            "head": "THE DASHBOARD",
            "note": "FastAPI serves the results, React shows them",
            "cards": [
                {
                    "title": "World replay and the causal readout",
                    "lines": ["Play the year day by day, open any couple or agent, read every decision.", "Pick a shock and run a new experiment from the page in about ten seconds."],
                    "foot": "make dashboard",
                },
            ],
        },
    ]


MAP_TITLE = "How a run flows"
MAP_SUB = "Experiment file to dashboard, every step logged"
MAP_CLOSING = "The policy never reads the arm. A test greps four modules for the word."


def how_it_works(summary: dict) -> tuple[str, str]:
    exp = summary["experiment"]
    stat = (f"{exp['n_couples']:,} couples, {exp['days']} days", "one second in the engine")
    sections = map_sections()

    y = 136
    section_tops: list[tuple[dict, int, int]] = []
    for s in sections:
        card_h = 196 if max(len(c["lines"]) for c in s["cards"]) <= 2 else 226
        section_tops.append((s, y, card_h))
        y += 44 + card_h + 36
    h = y + 56

    p = [open_svg(h, f"{MAP_TITLE}. {MAP_SUB}.")]
    fits(MAP_TITLE, 44, 760, 0, bold=True, where="map title")
    p.append(text(PAD, 72, MAP_TITLE, 44, INK, bold=True))
    box_w = 380
    box_x = VIEW_W - PAD - box_w
    fits(MAP_SUB, 24, box_x - PAD, 24, where="map subtitle")
    p.append(text(PAD, 106, MAP_SUB, 24, DIM))
    p.append(card(box_x, 36, box_w, 76))
    for i, line in enumerate(stat):
        fits(line, 23, box_w, 18, bold=i == 0, where=f"stat box line {i}")
        p.append(text(box_x + box_w / 2, 66 + i * 30, line, 23, INK if i == 0 else DIM, bold=i == 0, anchor="middle"))

    inner_w = VIEW_W - 2 * PAD
    for s, top, card_h in section_tops:
        head = f"{s['code']}  {s['head']}"
        fits(head, 23, 420, 0, bold=True, where=f"section {s['code']} head")
        p.append(text(PAD, top + 24, head, 23, ROSE, bold=True, spacing=1.5))
        fits(s["note"], 23, inner_w - 440, 0, where=f"section {s['code']} note")
        p.append(text(PAD + 440, top + 24, s["note"], 23, DIM))
        p.append(f'<line x1="{PAD}" y1="{top + 36}" x2="{VIEW_W - PAD}" y2="{top + 36}" stroke="{HAIRLINE}" stroke-width="1"/>')
        n = len(s["cards"])
        gap = 24
        cw = (inner_w - gap * (n - 1)) / n
        cy = top + 44
        for i, c in enumerate(s["cards"]):
            cx = PAD + i * (cw + gap)
            p.append(card(cx, cy, cw, card_h))
            tx = cx + 24
            fits(c["title"], 26, cw, 24, bold=True, where=f"section {s['code']} card {i} title")
            p.append(text(tx, cy + 44, c["title"], 26, INK, bold=True))
            for j, ln in enumerate(c["lines"]):
                fits(ln, 24, cw, 24, where=f"section {s['code']} card {i} line {j}")
                p.append(text(tx, cy + 86 + j * 36, ln, 24, SOFT))
            fits(c["foot"], 23, cw, 24, where=f"section {s['code']} card {i} foot", mono=True)
            p.append(text(tx, cy + card_h - 24, c["foot"], 23, DIM, mono=True))

    fits(MAP_CLOSING, 23, VIEW_W, PAD, where="map closing")
    p.append(text(VIEW_W / 2, h - 24, MAP_CLOSING, 23, DIM, anchor="middle"))
    p.append("</svg>\n")

    alt = [f"{MAP_TITLE}, from an experiment file to a dashboard with every step logged. {stat[0]}, {stat[1]}."]
    for s in sections:
        cards = " ".join(f"{c['title']}. {' '.join(c['lines'])}" for c in s["cards"])
        alt.append(f"Section {s['code']}, {s['head'].lower()}. {s['note']}. {cards}")
    alt.append(MAP_CLOSING)
    return "\n".join(p), " ".join(alt)


# ---------------------------------------------------------------- results panel

SHORT = {
    "divorce_rate": "Divorced within the year",
    "separation_rate": "Separated at least once",
    "days_married": "Days married until divorce or end",
    "final_trust": "Trust on the last day",
    "mean_trust": "Mean trust over the year",
    "conflict_rate": "Conflicts per couple-year",
    "escalations_per_conflict": "Escalations per conflict",
    "reconciliation_rate": "Conflicts ending reconciled",
    "recovery_days": "Days from conflict to repair",
    "remarriage_rate": "Divorced agents who remarried",
}


def fmt_effect(o: dict) -> tuple[str, str]:
    """The effect line and its interval line for one row."""
    if o["type"] == "binary":
        return f"{o['ate'] * 100:+.1f} points", f"95% CI {o['ci_low'] * 100:.1f} to {o['ci_high'] * 100:.1f}"
    d = digits(o)
    return f"{o['ate']:+.{d}f}", f"95% CI {o['ci_low']:.{d}f} to {o['ci_high']:.{d}f}"


def legend_words(summary: dict) -> tuple[str, str]:
    mem = memory_values(summary)
    if mem is None:
        return "control", "treatment"
    cv, tv = mem
    return f"control, {days_words(cv)} conflict memory", f"treatment, {days_words(tv)} conflict memory"


def results(summary: dict) -> tuple[str, str]:
    exp = summary["experiment"]
    seeds = exp["seeds"]
    rows = [o for o in summary["outcomes"] if o["name"] in SHORT]
    plain = [o for o in rows if not o["conditional_on_post_treatment"]]
    cond = [o for o in rows if o["conditional_on_post_treatment"]]
    title = "Example run, control against treatment"
    sub = f"{exp['n_couples']:,} couples over {exp['days']} days, seeds {seeds['population']}, {seeds['assignment']}, {seeds['dynamics']}. Bars are arm means, row by row."
    sub2 = "The right column is treatment minus control with its 95% bootstrap interval."

    row_h = 64
    group_h = 52
    top = 150
    h = top + group_h * 2 + row_h * len(rows) + 76

    p = [open_svg(h, title)]
    fits(title, 44, VIEW_W, PAD, bold=True, where="results title")
    p.append(text(PAD, 72, title, 44, INK, bold=True))
    fits(sub, 24, VIEW_W, PAD, where="results subtitle")
    p.append(text(PAD, 106, sub, 24, DIM))
    fits(sub2, 24, VIEW_W, PAD, where="results subtitle 2")
    p.append(text(PAD, 136, sub2, 24, DIM))

    label_x = PAD
    label_w = 470
    bar_x = PAD + label_w + 16
    bar_w = 180
    val_w = 90
    eff_x = bar_x + bar_w + 20 + val_w
    eff_w = VIEW_W - PAD - eff_x

    def group(y: int, name: str, items: list[dict]) -> int:
        fits(name, 23, VIEW_W, PAD, bold=True, where=f"group {name}")
        p.append(text(PAD, y + 34, name.upper(), 23, ROSE, bold=True, spacing=1.5))
        p.append(f'<line x1="{PAD}" y1="{y + 44}" x2="{VIEW_W - PAD}" y2="{y + 44}" stroke="{HAIRLINE}" stroke-width="1"/>')
        y += group_h
        for o in items:
            label = SHORT[o["name"]]
            fits(label, 24, label_w, 0, where=f"row {o['name']} label")
            p.append(text(label_x, y + 40, label, 24, SOFT))
            scale = max(abs(o["control_mean"]), abs(o["treatment_mean"])) or 1.0
            for k, (mean, color) in enumerate(((o["control_mean"], CONTROL), (o["treatment_mean"], TREATMENT))):
                by = y + 14 + k * 20
                p.append(bar(bar_x, by, bar_w, 14, TRACK))
                p.append(bar(bar_x, by, max(3.0, bar_w * abs(mean) / scale), 14, color))
                v = fmt_value(o, mean)
                fits(v, 23, val_w, 0, where=f"row {o['name']} value {k}")
                p.append(text(bar_x + bar_w + 12, by + 12, v, 23, color))
            eff, ci = fmt_effect(o)
            fits(eff, 24, eff_w, 0, bold=True, where=f"row {o['name']} effect")
            p.append(text(VIEW_W - PAD, y + 28, eff, 24, INK, bold=True, anchor="end"))
            fits(ci, 23, eff_w, 0, where=f"row {o['name']} interval")
            p.append(text(VIEW_W - PAD, y + 54, ci, 23, DIM, anchor="end"))
            p.append(f'<line x1="{PAD}" y1="{y + row_h}" x2="{VIEW_W - PAD}" y2="{y + row_h}" stroke="{HAIRLINE}" stroke-width="0.75"/>')
            y += row_h
        return y

    y = top
    y = group(y, "Measured on every couple", plain)
    y = group(y, "Conditional on events after assignment", cond)

    lc, lt = legend_words(summary)
    sw, sgap, igap = 22, 10, 40
    total = sw + sgap + width(lc, 23) + igap + sw + sgap + width(lt, 23)
    fits_row(total, VIEW_W - 2 * PAD, "results legend", [lc, lt])
    legend_y = h - 26
    x = PAD
    for words, color in ((lc, CONTROL), (lt, TREATMENT)):
        p.append(bar(x, legend_y - 14, sw, 14, color))
        p.append(text(x + sw + sgap, legend_y, words, 23, DIM))
        x += sw + sgap + width(words, 23) + igap
    p.append("</svg>\n")

    mem = memory_values(summary)
    if mem is None:
        bars = "Blue bars are control, orange bars treatment."
    else:
        bars = f"Blue bars are control with a {days_words(mem[0])} conflict memory, orange bars treatment with a {days_words(mem[1])} one."

    def row_alt(o: dict) -> str:
        eff, ci = fmt_effect(o)
        crosses = ", an interval that crosses zero" if o["ci_low"] < 0 < o["ci_high"] else ""
        return f"{SHORT[o['name']].lower()} {fmt_value(o, o['control_mean'])} against {fmt_value(o, o['treatment_mean'])}, effect {eff}, {ci}{crosses}"

    alt = (
        f"{title}. {sub} {sub2} Measured on every couple: {'; '.join(row_alt(o) for o in plain)}. "
        f"Conditional on events after assignment: {'; '.join(row_alt(o) for o in cond)}. {bars}"
    )
    return "\n".join(p), alt


# ---------------------------------------------------------------- main


def render() -> tuple[dict[str, str], dict[str, str]]:
    """The SVG bodies by file name, and the alt text by the same names."""
    summary = load_summary()
    hero_svg, hero_alt = hero(summary)
    map_svg, map_alt = how_it_works(summary)
    results_svg, results_alt = results(summary)
    svgs = {"hero.svg": hero_svg, "how-it-works.svg": map_svg, "results.svg": results_svg}
    alts = {"hero.svg": hero_alt, "how-it-works.svg": map_alt, "results.svg": results_alt}
    return svgs, alts


def img_pattern(name: str) -> re.Pattern[str]:
    return re.compile(r'(<img src="docs/figures/' + re.escape(name) + r'" alt=")([^"]*)(")')


def readme_with_alts(readme: str, alts: dict[str, str]) -> str:
    """The README with each figure's alt attribute set to its generated text."""
    for name, alt in alts.items():
        pat = img_pattern(name)
        found = pat.findall(readme)
        if len(found) != 1:
            raise SystemExit(f"README.md must embed docs/figures/{name} exactly once as <img src=... alt=...>, found {len(found)}")
        value = attr(alt)
        readme = pat.sub(lambda m: m.group(1) + value + m.group(3), readme)
    return readme


def write_all(files: dict[Path, str]) -> None:
    """Stage every output beside its target, then rename them all into place.

    Disk-full and permission errors happen while staging, before anything is replaced, so a failed
    write changes nothing; the renames that follow need no new space. A kill between two renames
    can still leave a mixed set, which --check, run by make figures-check and in CI, names.
    """
    staged: list[tuple[Path, Path]] = []
    try:
        for path, body in files.items():
            fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            staged.append((Path(tmp), path))
            with os.fdopen(fd, "w") as fh:
                fh.write(body)
            # mkstemp creates the file private; keep the mode the replaced file had, else 0644.
            os.chmod(tmp, path.stat().st_mode & 0o777 if path.exists() else 0o644)
    except BaseException:
        for tmp, _ in staged:
            tmp.unlink(missing_ok=True)
        raise
    for tmp, path in staged:
        os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write docs/figures/*.svg and the README alt text")
    mode.add_argument("--check", action="store_true", help="fail if a committed figure or its README alt text differs from a fresh render")
    args = ap.parse_args()
    svgs, alts = render()
    readme = README.read_text()
    fresh_readme = readme_with_alts(readme, alts)
    if args.write:
        OUT.mkdir(parents=True, exist_ok=True)
        files = {OUT / name: body for name, body in svgs.items()}
        if fresh_readme != readme:
            files[README] = fresh_readme
        write_all(files)
        for path in files:
            print(f"wrote {path.relative_to(ROOT)}")
        return 0
    stale = [name for name, body in svgs.items() if not (OUT / name).exists() or (OUT / name).read_text() != body]
    if fresh_readme != readme:
        stale.append("README.md alt text")
    if stale:
        print("figures are stale, run python3 tools/figures.py --write: " + ", ".join(stale), file=sys.stderr)
        return 1
    print("figures match their generator")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

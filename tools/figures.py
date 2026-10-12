#!/usr/bin/env python3
"""Generate the README figures from the repository's own numbers.

Three SVGs land in docs/figures: a hero card, a map of how a run flows, and a results panel read
from results/example/summary.json. Every text run passes a fit guard, so a string that would
overflow its box fails generation with the string named, and nothing in the panels is typed by hand.

    python3 tools/figures.py --write    # regenerate the SVGs in place
    python3 tools/figures.py --check    # regenerate in memory and fail on any difference
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
SUMMARY = ROOT / "results" / "example" / "summary.json"
OUT = ROOT / "docs" / "figures"

VIEW_W = 1200
PAD = 48

PAPER = "#ffffff"
PANEL = "#f6f8fa"
HAIRLINE = "#d0d7de"
INK = "#1f2328"
MUTED = "#57606a"
ACCENT = "#345c8f"
CONTROL = "#2a78d6"
TREATMENT = "#d95926"

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

MIN_FONT = 23


def fits(text: str, size: float, box_w: float, pad: float, bold: bool = False, where: str = "", mono: bool = False) -> None:
    """Refuse a text run that would overflow its box, naming the string."""
    if size < MIN_FONT:
        raise SystemExit(f"font {size} under the {MIN_FONT} floor {where}: {text!r}")
    factor = 0.62 if bold else 0.58
    if mono:
        factor = 0.62
    est = len(text) * size * factor
    room = box_w - 2 * pad
    if est > room:
        raise SystemExit(f"text does not fit {where}: {text!r} needs {est:.0f} of {room:.0f}")


def text(x: float, y: float, s: str, size: float, fill: str = INK, bold: bool = False, anchor: str = "start", mono: bool = False, spacing: float = 0) -> str:
    family = MONO if mono else SANS
    weight = ' font-weight="700"' if bold else ""
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    return f'<text x="{x:.0f}" y="{y:.0f}" font-family="{family}" font-size="{size}" fill="{fill}"{weight} text-anchor="{anchor}"{ls}>{escape(s)}</text>'


def card(x: float, y: float, w: float, h: float, fill: str = PANEL) -> str:
    return f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" rx="8" fill="{fill}" stroke="{HAIRLINE}" stroke-width="1.5"/>'


def open_svg(h: int, label: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW_W} {h}" width="100%" role="img" aria-label="{escape(label)}">\n'
        f'<rect x="0.75" y="0.75" width="{VIEW_W - 1.5}" height="{h - 1.5}" rx="12" fill="{PAPER}" stroke="{HAIRLINE}" stroke-width="1.5"/>\n'
    )


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


def num(v: float, unit: str) -> str:
    if unit.startswith("trust"):
        return f"{v:.2f}"
    return f"{v:.1f}"


def signed(v: float, digits: int = 1) -> str:
    s = f"{v:+.{digits}f}"
    return s.replace("-", "−") if False else s


# ---------------------------------------------------------------- hero


def hero(summary: dict) -> tuple[str, str]:
    exp = summary["experiment"]
    div = outcome(summary, "divorce_rate")
    trust = outcome(summary, "final_trust")
    conf = outcome(summary, "conflict_rate")
    seeds = exp["seeds"]

    kicker = "Causal simulation of agent marriages"
    title = "LoveWorld"
    sub = f"{exp['n_couples']:,} agent couples, one year, one memory setting changed between arms"
    tiles = [
        ("Divorced within the year", pct(div["control_mean"]), pct(div["treatment_mean"])),
        ("Trust on the last day", num(trust["control_mean"], trust["unit"]), num(trust["treatment_mean"], trust["unit"])),
        ("Conflicts per couple-year", num(conf["control_mean"], conf["unit"]), num(conf["treatment_mean"], conf["unit"])),
    ]
    pills = ["experiment file", "Rust engine", "analysis", "dashboard"]
    footer = "python3 tools/figures.py --write  from results/example/summary.json"

    h = 468
    p = [open_svg(h, "LoveWorld, a causal simulation of agent marriages")]
    cx = VIEW_W / 2
    fits(kicker, 24, VIEW_W, PAD, where="hero kicker")
    p.append(text(cx, 66, kicker.upper(), 24, MUTED, anchor="middle", spacing=2))
    fits(title, 52, VIEW_W, PAD, bold=True, where="hero title")
    p.append(text(cx, 128, title, 52, INK, bold=True, anchor="middle"))
    fits(sub, 26, VIEW_W, PAD, where="hero subtitle")
    p.append(text(cx, 170, sub, 26, MUTED, anchor="middle"))

    gap = 12
    tile_w = (VIEW_W - 2 * PAD - 2 * gap) / 3
    tile_h = 150
    ty = 206
    for i, (label, c, t) in enumerate(tiles):
        x = PAD + i * (tile_w + gap)
        p.append(card(x, ty, tile_w, tile_h))
        fits(label, 23, tile_w, 12, where=f"hero tile {i} label")
        p.append(text(x + tile_w / 2, ty + 40, label, 23, MUTED, anchor="middle"))
        pair = f"{c}  vs  {t}"
        fits(pair, 36, tile_w, 12, bold=True, where=f"hero tile {i} value")
        # Control in blue, treatment in orange: the colour is the arm encoding the app uses. Each
        # run is placed explicitly so the spacing does not depend on whitespace handling.
        w_c = len(c) * 36 * 0.62
        w_t = len(t) * 36 * 0.62
        w_vs = 72
        start = x + tile_w / 2 - (w_c + w_vs + w_t) / 2
        p.append(text(start, ty + 92, c, 36, CONTROL, bold=True))
        p.append(text(start + w_c + w_vs / 2, ty + 92, "vs", 26, MUTED, anchor="middle"))
        p.append(text(start + w_c + w_vs, ty + 92, t, 36, TREATMENT, bold=True))
        cap = "control vs treatment"
        fits(cap, 23, tile_w, 12, where=f"hero tile {i} caption")
        p.append(text(x + tile_w / 2, ty + 128, cap, 23, MUTED, anchor="middle"))

    py = 392
    pill_h = 40
    pill_gap = 16
    widths = [len(s) * 24 * 0.58 + 40 for s in pills]
    total = sum(widths) + pill_gap * (len(pills) - 1)
    x = (VIEW_W - total) / 2
    for i, (s, w) in enumerate(zip(pills, widths)):
        active = s == "Rust engine"
        fill = ACCENT if active else PAPER
        color = PAPER if active else INK
        p.append(f'<rect x="{x:.0f}" y="{py}" width="{w:.0f}" height="{pill_h}" rx="20" fill="{fill}" stroke="{HAIRLINE if not active else ACCENT}" stroke-width="1.5"/>')
        fits(s, 24, w, 16, where=f"hero pill {i}")
        p.append(text(x + w / 2, py + 27, s, 24, color, anchor="middle"))
        x += w + pill_gap

    fits(footer, 23, VIEW_W, PAD, where="hero footer", mono=True)
    p.append(text(cx, h - 18, footer, 23, MUTED, anchor="middle", mono=True))
    p.append("</svg>\n")

    alt = (
        f"LoveWorld, a causal simulation of agent marriages. {sub}. Three tiles compare control with treatment: "
        f"divorced within the year {tiles[0][1]} against {tiles[0][2]}, trust on the last day {tiles[1][1]} against {tiles[1][2]}, "
        f"conflicts per couple-year {tiles[2][1]} against {tiles[2][2]}. Four stages, experiment file, Rust engine, analysis, dashboard. "
        f"Footer: {footer}."
    )
    return "\n".join(p), alt


# ---------------------------------------------------------------- how a run flows


def how_it_works(summary: dict) -> str:
    exp = summary["experiment"]
    title = "How a run flows"
    sub = "Experiment file to dashboard, every step logged"
    stat = (f"{exp['n_couples']:,} couples, {exp['days']} days", "one second in the engine")

    sections = [
        {
            "code": "01",
            "head": "THE EXPERIMENT FILE",
            "note": "One YAML file is the whole experiment",
            "cards": [
                {
                    "title": "experiments/example.yaml",
                    "lines": ["Couples, days, three seeds, the treatment memory half-life, and any shocks.", "Python turns it into the engine's config JSON and keeps both."],
                    "foot": "loveworld run experiments/example.yaml",
                    "foot_mono": True,
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
                    "foot_mono": True,
                },
                {
                    "title": "What it writes",
                    "lines": ["Eight Parquet tables, one manifest", "with a SHA-256 per table.", "Replay fails on any mismatch."],
                    "foot": "loveworld-engine replay --manifest",
                    "foot_mono": True,
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
                    "foot_mono": True,
                },
                {
                    "title": "Two checks on every experiment",
                    "lines": ["Placebo: equal parameters, both", "arms must match byte for byte.", "Twins: each couple under both arms."],
                    "foot": "make placebo   make twins",
                    "foot_mono": True,
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
                    "foot_mono": True,
                },
            ],
        },
    ]
    closing = "The policy never reads the arm. A test greps four modules for the word."

    # Layout.
    y = 118
    section_tops: list[tuple[dict, int, int]] = []
    for s in sections:
        n = len(s["cards"])
        card_h = 196 if max(len(c["lines"]) for c in s["cards"]) <= 2 else 226
        section_tops.append((s, y, card_h))
        y += 44 + card_h + 36
    h = y + 56

    p = [open_svg(h, "How a LoveWorld run flows")]
    fits(title, 44, 760, 0, bold=True, where="map title")
    p.append(text(PAD, 72, title, 44, INK, bold=True))
    box_w = 360
    box_x = VIEW_W - PAD - box_w
    fits(sub, 24, box_x - PAD, 24, where="map subtitle")
    p.append(text(PAD, 106, sub, 24, MUTED))
    p.append(card(box_x, 36, box_w, 76, PAPER))
    for i, line in enumerate(stat):
        fits(line, 23, box_w, 18, where=f"stat box line {i}")
        p.append(text(box_x + box_w / 2, 66 + i * 30, line, 23, ACCENT if i == 0 else MUTED, anchor="middle"))

    inner_w = VIEW_W - 2 * PAD
    for s, top, card_h in section_tops:
        head = f"{s['code']}  {s['head']}"
        fits(head, 23, 420, 0, bold=True, where=f"section {s['code']} head")
        p.append(text(PAD, top + 24, head, 23, ACCENT, bold=True, spacing=1.5))
        fits(s["note"], 23, inner_w - 440, 0, where=f"section {s['code']} note")
        p.append(text(PAD + 440, top + 24, s["note"], 23, MUTED))
        p.append(f'<line x1="{PAD}" y1="{top + 36}" x2="{VIEW_W - PAD}" y2="{top + 36}" stroke="{HAIRLINE}" stroke-width="1"/>')
        n = len(s["cards"])
        gap = 24
        cw = (inner_w - gap * (n - 1)) / n
        cy = top + 44
        for i, c in enumerate(s["cards"]):
            cx = PAD + i * (cw + gap)
            p.append(card(cx, cy, cw, card_h))
            p.append(f'<rect x="{cx:.0f}" y="{cy + 10}" width="4" height="{card_h - 20}" rx="2" fill="{ACCENT}"/>')
            tx = cx + 22
            fits(c["title"], 26, cw, 22, bold=True, where=f"section {s['code']} card {i} title")
            p.append(text(tx, cy + 44, c["title"], 26, INK, bold=True))
            for j, ln in enumerate(c["lines"]):
                fits(ln, 24, cw, 22, where=f"section {s['code']} card {i} line {j}")
                p.append(text(tx, cy + 86 + j * 36, ln, 24, INK))
            fits(c["foot"], 23, cw, 22, where=f"section {s['code']} card {i} foot", mono=c["foot_mono"])
            p.append(text(tx, cy + card_h - 24, c["foot"], 23, MUTED, mono=c["foot_mono"]))

    fits(closing, 23, VIEW_W, PAD, where="map closing")
    p.append(text(VIEW_W / 2, h - 24, closing, 23, MUTED, anchor="middle"))
    p.append("</svg>\n")
    return "\n".join(p)


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


def fmt_value(o: dict, v: float) -> str:
    return pct(v) if o["type"] == "binary" else num(v, o["unit"])


def fmt_effect(o: dict) -> tuple[str, str]:
    """The effect line and its interval line for one row."""
    if o["type"] == "binary":
        return f"{o['ate'] * 100:+.1f} points", f"95% CI {o['ci_low'] * 100:.1f} to {o['ci_high'] * 100:.1f}"
    d = 2 if o["unit"].startswith("trust") else 1
    return f"{o['ate']:+.{d}f}", f"95% CI {o['ci_low']:.{d}f} to {o['ci_high']:.{d}f}"


def results(summary: dict) -> str:
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

    p = [open_svg(h, "Example run results, control against treatment")]
    fits(title, 44, VIEW_W, PAD, bold=True, where="results title")
    p.append(text(PAD, 72, title, 44, INK, bold=True))
    fits(sub, 24, VIEW_W, PAD, where="results subtitle")
    p.append(text(PAD, 106, sub, 24, MUTED))
    fits(sub2, 24, VIEW_W, PAD, where="results subtitle 2")
    p.append(text(PAD, 136, sub2, 24, MUTED))

    label_x = PAD
    label_w = 470
    bar_x = PAD + label_w + 16
    bar_w = 180
    val_w = 90
    eff_x = bar_x + bar_w + 20 + val_w
    eff_w = VIEW_W - PAD - eff_x

    def group(y: int, name: str, items: list[dict]) -> int:
        fits(name, 23, VIEW_W, PAD, bold=True, where=f"group {name}")
        p.append(text(PAD, y + 34, name.upper(), 23, ACCENT, bold=True, spacing=1.5))
        p.append(f'<line x1="{PAD}" y1="{y + 44}" x2="{VIEW_W - PAD}" y2="{y + 44}" stroke="{HAIRLINE}" stroke-width="1"/>')
        y += group_h
        for o in items:
            label = SHORT[o["name"]]
            fits(label, 24, label_w, 0, where=f"row {o['name']} label")
            p.append(text(label_x, y + 40, label, 24, INK))
            scale = max(abs(o["control_mean"]), abs(o["treatment_mean"])) or 1.0
            for k, (mean, color) in enumerate(((o["control_mean"], CONTROL), (o["treatment_mean"], TREATMENT))):
                by = y + 14 + k * 20
                bl = max(2.0, bar_w * abs(mean) / scale)
                p.append(f'<rect x="{bar_x}" y="{by}" width="{bl:.0f}" height="14" rx="3" fill="{color}"/>')
                v = fmt_value(o, mean)
                fits(v, 23, val_w, 0, where=f"row {o['name']} value {k}")
                p.append(text(bar_x + bar_w + 12, by + 12, v, 23, color))
            eff, ci = fmt_effect(o)
            fits(eff, 24, eff_w, 0, bold=True, where=f"row {o['name']} effect")
            p.append(text(VIEW_W - PAD, y + 28, eff, 24, INK, bold=True, anchor="end"))
            fits(ci, 23, eff_w, 0, where=f"row {o['name']} interval")
            p.append(text(VIEW_W - PAD, y + 54, ci, 23, MUTED, anchor="end"))
            p.append(f'<line x1="{PAD}" y1="{y + row_h}" x2="{VIEW_W - PAD}" y2="{y + row_h}" stroke="{HAIRLINE}" stroke-width="0.75"/>')
            y += row_h
        return y

    y = top
    y = group(y, "Measured on every couple", plain)
    y = group(y, "Conditional on events after assignment", cond)

    legend_y = h - 26
    p.append(f'<rect x="{PAD}" y="{legend_y - 12}" width="22" height="14" rx="3" fill="{CONTROL}"/>')
    lc, lt = "control, 14-day conflict memory", "treatment, 90-day conflict memory"
    fits(lc, 23, 430, 0, where="legend control")
    fits(lt, 23, 450, 0, where="legend treatment")
    p.append(text(PAD + 32, legend_y, lc, 23, MUTED))
    p.append(f'<rect x="{PAD + 470}" y="{legend_y - 12}" width="22" height="14" rx="3" fill="{TREATMENT}"/>')
    p.append(text(PAD + 502, legend_y, lt, 23, MUTED))
    p.append("</svg>\n")
    return "\n".join(p)


# ---------------------------------------------------------------- main


def render() -> dict[str, str]:
    summary = load_summary()
    hero_svg, alt = hero(summary)
    return {
        "hero.svg": hero_svg,
        "hero.alt.txt": alt + "\n",
        "how-it-works.svg": how_it_works(summary),
        "results.svg": results(summary),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write docs/figures/*.svg")
    mode.add_argument("--check", action="store_true", help="fail if a committed figure differs from a fresh render")
    args = ap.parse_args()
    files = render()
    if args.write:
        OUT.mkdir(parents=True, exist_ok=True)
        for name, body in files.items():
            (OUT / name).write_text(body)
            print(f"wrote docs/figures/{name}")
        return 0
    stale = [name for name, body in files.items() if not (OUT / name).exists() or (OUT / name).read_text() != body]
    if stale:
        print("figures are stale, run python3 tools/figures.py --write: " + ", ".join(stale), file=sys.stderr)
        return 1
    print("figures match their generator")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

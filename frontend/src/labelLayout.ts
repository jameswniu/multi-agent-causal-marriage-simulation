// Places the short labels a chart writes beside its points (a couple's trust chart names each change, such as
// separated or reunited, above its dot) so that no two labels overlap and none leaves the chart. Each label
// tries just above its point, then one line higher, then just below it, so it always sits next to its own point,
// and moves sideways only to stay inside the chart. A label with no free place is left out, and its point stays
// drawn. Labels are placed in priority order, then from left to right.

/** A point to label, in the chart's pixel coordinates. A lower priority number is placed first. */
export interface LabelPoint {
  key: string | number;
  x: number;
  y: number;
  text: string;
  priority?: number;
}

/** A label that found a place: its centre and baseline, and how far above its point it sits (-1 is below). */
export interface PlacedLabel {
  key: string | number;
  text: string;
  x: number;
  y: number;
  level: number;
}

/** The box labels must stay inside. */
export interface LabelBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LabelOptions {
  /** The text size in pixels. */
  fontPx?: number;
  /** Width of a character as a share of the text size, kept generous so a measured label is never wider. */
  charEm?: number;
  /** Clear space kept between a label and its point. */
  pointGap?: number;
  /** Clear space kept around every label. */
  pad?: number;
  /**
   * The radius of the marker drawn at each point. Given, no label covers any other point's marker, and its own
   * marker is cleared by the gap above.
   */
  markerRadius?: number;
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

function hits(a: Box, b: Box, pad: number): boolean {
  return a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;
}

/** The estimated width of a label in pixels. */
export function labelWidth(text: string, fontPx = 16, charEm = 0.56): number {
  return Math.ceil(text.length * charEm * fontPx) + 2;
}

/** Where each label goes, and how many were left out. */
export function placeLabels(points: LabelPoint[], bounds: LabelBounds, options: LabelOptions = {}): { placed: PlacedLabel[]; hidden: number } {
  const fontPx = options.fontPx ?? 16;
  const charEm = options.charEm ?? 0.56;
  const pointGap = options.pointGap ?? 8;
  const pad = options.pad ?? 3;
  const ascent = Math.ceil(fontPx * 0.8);
  const descent = Math.ceil(fontPx * 0.25);
  // A line up clears the label below it by the padding with room to spare, since neighbouring points rarely sit at
  // the same height, so stacked names never touch.
  const lineH = ascent + descent + 2 * pad;
  const r = options.markerRadius;
  // Every marker but a label's own is in the way of that label.
  const markers = r === undefined ? [] : points.map((p) => ({ key: p.key, box: { l: p.x - r, r: p.x + r, t: p.y - r, b: p.y + r } }));
  const taken: Box[] = [];
  const order = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.priority ?? 0) - (b.p.priority ?? 0) || a.p.x - b.p.x || a.i - b.i);
  const placed: PlacedLabel[] = [];
  let hidden = 0;
  for (const { p } of order) {
    const w = labelWidth(p.text, fontPx, charEm);
    if (w > bounds.right - bounds.left) {
      hidden += 1;
      continue;
    }
    const x = Math.min(Math.max(p.x, bounds.left + w / 2), bounds.right - w / 2);
    // Baselines to try: just above the point, one line higher, then just below it. Any higher and a reader could
    // no longer tell which point a label names.
    const above = p.y - pointGap - descent;
    const tries: [number, number][] = [
      [above, 0],
      [above - lineH, 1],
      [p.y + pointGap + ascent, -1],
    ];
    let done = false;
    for (const [base, level] of tries) {
      const box = { l: x - w / 2, r: x + w / 2, t: base - ascent, b: base + descent };
      if (box.t < bounds.top || box.b > bounds.bottom) continue;
      if (taken.some((o) => hits(box, o, pad))) continue;
      if (markers.some((m) => m.key !== p.key && hits(box, m.box, pad))) continue;
      taken.push(box);
      placed.push({ key: p.key, text: p.text, x, y: base, level });
      done = true;
      break;
    }
    if (!done) hidden += 1;
  }
  return { placed, hidden };
}

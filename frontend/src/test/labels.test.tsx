// Tests for the names a couple's trust chart writes beside its dots (separated, reunited, reconciled and the
// other changes in a relationship): no two names ever overlap or cover a dot, none leaves the chart, every
// change keeps its dot, and the chart says how many dots go unnamed where they crowd.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TrustLines from '../components/TrustLines';
import { labelWidth, placeLabels, type LabelPoint } from '../labelLayout';
import type { DailyRow, EventRow } from '../types';

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** The box a placed name takes, by the same estimate the layout uses. */
function boxOf(x: number, y: number, text: string): Box {
  const w = labelWidth(text);
  return { l: x - w / 2, r: x + w / 2, t: y - 13, b: y + 4 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

describe('placing names beside points', () => {
  const bounds = { left: 64, right: 798, top: 2, bottom: 240 };

  it('stacks names of points a few days apart instead of overlapping them, and keeps them inside the chart', () => {
    const points: LabelPoint[] = [
      { key: 1, x: 400, y: 150, text: 'separated' },
      { key: 2, x: 411, y: 152, text: 'reunited' },
      { key: 3, x: 66, y: 120, text: 'reconciled' },
      { key: 4, x: 796, y: 14, text: 'reconciled' },
    ];
    const { placed, hidden } = placeLabels(points, bounds);
    expect(hidden).toBe(0);
    expect(placed).toHaveLength(4);
    const boxes = placed.map((p) => boxOf(p.x, p.y, p.text));
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].l).toBeGreaterThanOrEqual(bounds.left);
      expect(boxes[i].r).toBeLessThanOrEqual(bounds.right);
      expect(boxes[i].t).toBeGreaterThanOrEqual(bounds.top);
      expect(boxes[i].b).toBeLessThanOrEqual(bounds.bottom);
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
    }
    // The second of the close pair goes one line up; a point near the top puts its name below it.
    expect(placed.find((p) => p.key === 2)?.level).toBe(1);
    expect(placed.find((p) => p.key === 4)?.level).toBe(-1);
  });

  it('leaves a name out where there is no room, keeping the rarer change named first', () => {
    const crowd: LabelPoint[] = Array.from({ length: 12 }, (_, i) => ({ key: i, x: 300 + i * 4, y: 120, text: 'reconciled', priority: 6 }));
    const divorce: LabelPoint = { key: 'd', x: 322, y: 160, text: 'divorced', priority: 0 };
    const { placed, hidden } = placeLabels([...crowd, divorce], bounds, { markerRadius: 6 });
    expect(placed.some((p) => p.key === 'd')).toBe(true);
    expect(placed.length + hidden).toBe(13);
    expect(hidden).toBeGreaterThan(0);
    const boxes = placed.map((p) => boxOf(p.x, p.y, p.text));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
    // No name covers any dot.
    for (const b of boxes) for (const c of [...crowd, divorce]) expect(overlaps(b, { l: c.x - 5, r: c.x + 5, t: c.y - 5, b: c.y + 5 })).toBe(false);
  });

  it('puts a name right above its own dot when nothing is in the way, and below it at the top edge', () => {
    const { placed } = placeLabels(
      [
        { key: 'mid', x: 400, y: 150, text: 'separated' },
        { key: 'top', x: 600, y: 14, text: 'reunited' },
      ],
      bounds,
      { markerRadius: 6 },
    );
    expect(placed.find((p) => p.key === 'mid')?.level).toBe(0);
    expect(placed.find((p) => p.key === 'top')?.level).toBe(-1);
  });
});

describe("a couple's trust chart", () => {
  const daily: DailyRow[] = Array.from({ length: 120 }, (_, day) => ({ day, trust_a: 0.6, trust_b: 0.5, affect_a: 0.1, affect_b: 0.2 }) as unknown as DailyRow);
  const event = (day: number, kind: string, seq: number): EventRow => ({ day, seq, couple_id: 12, agent_id: null, kind, from_state: null, to_state: null, value: null });
  // A crowded year like couple 12's: a separation and a reunion three days apart, again and again, and reconciliations.
  const events: EventRow[] = [
    event(10, 'reconciled', 0),
    event(14, 'reconciled', 1),
    event(30, 'separated', 2),
    event(33, 'reunited', 3),
    event(40, 'separated', 4),
    event(42, 'reunited', 5),
    event(45, 'reconciled', 6),
    event(70, 'separated', 7),
    event(72, 'reunited', 8),
    event(74, 'reconciled', 9),
    event(76, 'reconciled', 10),
    event(110, 'divorced', 11),
  ];

  for (const width of [360, 900]) {
    it(`keeps a dot for every change and writes no two names over each other, ${width}px wide`, () => {
      render(<TrustLines daily={daily} conflicts={[]} events={events} width={width} height={300} metric="trust" agentA={24} agentB={25} />);
      expect(screen.getAllByTestId('marker-dot')).toHaveLength(events.length);
      const names = screen.getAllByTestId('marker-label');
      expect(names.length).toBeGreaterThan(0);
      const boxes = names.map((t) => boxOf(Number(t.getAttribute('x')), Number(t.getAttribute('y')), t.textContent ?? ''));
      for (let i = 0; i < boxes.length; i++) {
        expect(boxes[i].l).toBeGreaterThanOrEqual(0);
        expect(boxes[i].r).toBeLessThanOrEqual(width);
        expect(boxes[i].t).toBeGreaterThanOrEqual(0);
        for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
      // No name covers a dot, its own or another's.
      const dots = screen.getAllByTestId('marker-dot').map((d) => ({ x: Number(d.getAttribute('cx')), y: Number(d.getAttribute('cy')) }));
      for (const b of boxes) for (const d of dots) expect(overlaps(b, { l: d.x - 5, r: d.x + 5, t: d.y - 5, b: d.y + 5 })).toBe(false);
      // The divorce is always named; every dot keeps its own name on hover.
      expect(names.map((n) => n.textContent)).toContain('divorced');
      expect(screen.getAllByTestId('marker-dot').map((d) => d.querySelector('title')?.textContent)).toContain('Day 33: reunited');
      const unnamed = events.length - names.length;
      // The note points to the Events list, which names every change on a phone too, where no pointer can hover a dot.
      if (unnamed > 0) expect(screen.getByText(new RegExp(`Where they crowd, ${unnamed} dots? go(es)? unnamed; the Events list below names every one\\.$`))).toBeInTheDocument();
    });
  }
});

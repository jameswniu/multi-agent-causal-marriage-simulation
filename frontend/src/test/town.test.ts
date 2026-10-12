// Tests for the town view's pure layout: where every couple's lot sits, which agent belongs to
// which couple, where each agent stands for each state, and how a figure walks between days.
import { describe, expect, it } from 'vitest';
import type { CoupleRow, WorldResponse } from '../types';
import {
  DISTRICT_COLS,
  LOT_H,
  LOT_W,
  PLAZA_COLS,
  buildAgents,
  buildLayout,
  datingSpot,
  everMarried,
  focusOrder,
  hash01,
  houseState,
  leaver,
  lotAt,
  moveFocus,
  placeAgent,
  roofsOnly,
  shouldSnap,
  singleSpot,
  stepToward,
  walkSpeed,
} from '../town/layout';

type Shape = Pick<WorldResponse, 'couples' | 'arms' | 'origin'>;

/** Ten first-marriage couples (ids 0..9, even ids control, odd treatment) and two remarriages
 * (ids 10 and 11) formed from the divorced partners of couples 1 and 3 and of 0 and 2. */
function smallWorld(): { world: Shape; rows: CoupleRow[] } {
  const couples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const arms = couples.map((id) => (id >= 10 ? null : id % 2 === 0 ? 'control' : 'treatment')) as WorldResponse['arms'];
  const origin = couples.map((id) => (id >= 10 ? 'remarriage' : 'initial')) as WorldResponse['origin'];
  const row = (couple_id: number, agent_a: number, agent_b: number, formed_day: number): CoupleRow => ({
    couple_id,
    agent_a,
    agent_b,
    arm: couple_id >= 10 ? null : couple_id % 2 === 0 ? 'control' : 'treatment',
    origin: couple_id >= 10 ? 'remarriage' : 'initial',
    formed_day,
    married_day: null,
    compatibility: 0.5,
    final_state: 'married',
    ended_day: null,
    years_married_at_start: 3,
  });
  const rows = couples.slice(0, 10).map((id) => row(id, 2 * id, 2 * id + 1, 0));
  rows.push(row(10, 2, 7, 120)); // agent 2 from couple 1 (treatment), agent 7 from couple 3 (treatment)
  rows.push(row(11, 1, 4, 150)); // agent 1 from couple 0 (control), agent 4 from couple 2 (control)
  return { world: { couples, arms, origin }, rows };
}

/** A states string for one day: every couple married unless overridden by couple index. */
function day(world: Shape, overrides: Record<number, string>): string {
  return world.couples.map((id, i) => overrides[i] ?? (id >= 10 ? '-' : 'M')).join('');
}

describe('town layout', () => {
  it('puts control lots left of the plaza, treatment lots right of it and new homes at its foot, in couple id order', () => {
    const { world } = smallWorld();
    const layout = buildLayout(world);
    expect(layout.order.control).toEqual([0, 2, 4, 6, 8]);
    expect(layout.order.treatment).toEqual([1, 3, 5, 7, 9]);
    expect(layout.order.newhomes).toEqual([10, 11]);
    for (const idx of layout.order.control) expect(layout.lots[idx]!.x + LOT_W).toBeLessThanOrEqual(layout.plaza.x);
    for (const idx of layout.order.treatment) expect(layout.lots[idx]!.x).toBeGreaterThanOrEqual(layout.plaza.x + layout.plaza.w);
    for (const idx of layout.order.newhomes) {
      const lot = layout.lots[idx]!;
      expect(lot.x).toBeGreaterThanOrEqual(layout.plaza.x);
      expect(lot.x + LOT_W).toBeLessThanOrEqual(layout.plaza.x + layout.plaza.w);
      expect(lot.y).toBeGreaterThanOrEqual(layout.newHomes.y);
    }
    // Lots of one zone never overlap and every couple has one.
    const seen = new Set<string>();
    world.couples.forEach((_, idx) => {
      const lot = layout.lots[idx]!;
      expect(lot).toBeDefined();
      const key = `${lot.x},${lot.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    });
    expect(layout.width).toBeGreaterThan(layout.treatment.x + layout.treatment.w);
    expect(layout.height).toBeGreaterThan(layout.plaza.y + layout.plaza.h);
  });

  it('wraps a full district into rows and keeps the singles and dating zones above the new homes', () => {
    const n = 1000;
    const world: Shape = {
      couples: Array.from({ length: n + 40 }, (_, i) => i),
      arms: Array.from({ length: n + 40 }, (_, i) => (i >= n ? null : i % 2 === 0 ? 'control' : 'treatment')) as WorldResponse['arms'],
      origin: Array.from({ length: n + 40 }, (_, i) => (i >= n ? 'remarriage' : 'initial')) as WorldResponse['origin'],
    };
    const layout = buildLayout(world);
    expect(layout.control.h).toBe(Math.ceil(500 / DISTRICT_COLS) * LOT_H);
    expect(layout.newHomes.h).toBe(Math.ceil(40 / PLAZA_COLS) * LOT_H);
    expect(layout.singles.y + layout.singles.h).toBeLessThanOrEqual(layout.dating.y);
    expect(layout.dating.y + layout.dating.h).toBeLessThanOrEqual(layout.newHomes.y);
  });

  it('finds the couple whose lot is under a point, and nothing in the open plaza', () => {
    const { world } = smallWorld();
    const layout = buildLayout(world);
    for (const idx of [0, 3, 10]) {
      const lot = layout.lots[idx]!;
      expect(lotAt(layout, lot.x + LOT_W / 2, lot.y + LOT_H / 2)).toBe(idx);
    }
    expect(lotAt(layout, layout.singles.x + 4, layout.singles.y + 4)).toBeNull();
    expect(lotAt(layout, -10, -10)).toBeNull();
  });
});

describe('town agents', () => {
  it('follows each agent through every couple it joined, in the order they formed', () => {
    const { world, rows } = smallWorld();
    const agents = buildAgents(world, rows);
    expect(agents).toHaveLength(20);
    const a2 = agents.find((a) => a.id === 2)!;
    expect(a2.couples).toEqual([1, 10]);
    expect(a2.sides).toEqual(['a', 'a']);
    expect(a2.homeArm).toBe('treatment');
    const a4 = agents.find((a) => a.id === 4)!;
    expect(a4.couples).toEqual([2, 11]);
    expect(a4.sides).toEqual(['a', 'b']);
    expect(a4.homeArm).toBe('control');
  });

  it('gives each couple two stand-in agents when the couples table is missing', () => {
    const { world } = smallWorld();
    const agents = buildAgents(world, null);
    expect(agents).toHaveLength(world.couples.length * 2);
    expect(agents.every((a) => a.id < 0 && a.couples.length === 1)).toBe(true);
  });
});

describe('town postures', () => {
  const { world, rows } = smallWorld();
  const layout = buildLayout(world);
  const agents = buildAgents(world, rows);
  const agent = (id: number) => agents.find((a) => a.id === id)!;
  const place = (id: number, states: string) => placeAgent(agent(id), states, layout, world.couples);

  it('stands both partners of a married couple at their own house', () => {
    const states = day(world, {});
    const lot = layout.lots[0]!;
    for (const id of [0, 1]) {
      const p = place(id, states);
      expect(p.posture).toBe('home');
      expect(p.couple).toBe(0);
      expect(p.x).toBeGreaterThan(lot.x);
      expect(p.x).toBeLessThan(lot.x + LOT_W);
      expect(p.y).toBeGreaterThan(lot.y);
      expect(p.y).toBeLessThanOrEqual(lot.y + LOT_H);
    }
  });

  it('puts a couple in conflict outside and apart, facing away from each other', () => {
    const states = day(world, { 4: 'C' });
    const a = place(8, states);
    const b = place(9, states);
    expect(a.posture).toBe('conflict');
    expect(b.posture).toBe('conflict');
    expect(b.x - a.x).toBeGreaterThan(30);
    expect(a.facing).toBe(-1);
    expect(b.facing).toBe(1);
  });

  it('sends the leaver of a separated couple to the plaza edge on its own side and keeps the other home', () => {
    const control = day(world, { 0: 'S' });
    const goes = leaver(0) === 'a' ? 0 : 1;
    const stays = goes === 0 ? 1 : 0;
    const away = place(goes, control);
    expect(away.posture).toBe('away');
    expect(away.x).toBeLessThan(layout.plaza.x + layout.plaza.w / 2);
    expect(away.x).toBeGreaterThanOrEqual(layout.plaza.x);
    expect(place(stays, control).posture).toBe('home');
    const treatment = day(world, { 1: 'S' });
    const goesT = leaver(1) === 'a' ? 2 : 3;
    const awayT = place(goesT, treatment);
    expect(awayT.posture).toBe('away');
    expect(awayT.x).toBeGreaterThan(layout.plaza.x + layout.plaza.w / 2);
  });

  it('walks both partners of a divorce to their own fixed spots in the plaza', () => {
    const states = day(world, { 3: 'D' });
    for (const id of [6, 7]) {
      const p = place(id, states);
      expect(p.posture).toBe('single');
      expect(p.couple).toBeNull();
      expect(p).toMatchObject(singleSpot(layout, id));
      expect(p.x).toBeGreaterThanOrEqual(layout.singles.x);
      expect(p.x).toBeLessThanOrEqual(layout.singles.x + layout.singles.w);
    }
  });

  it('moves divorced agents into their new couple: dating in the plaza, then home at the new lot, then single again after a break-up', () => {
    const dating = day(world, { 1: 'D', 3: 'D', 10: 'T' });
    const spot = datingSpot(layout, 10);
    const p2 = place(2, dating);
    const p7 = place(7, dating);
    expect(p2.posture).toBe('dating');
    expect(p7.posture).toBe('dating');
    expect(Math.abs((p2.x + p7.x) / 2 - spot.x)).toBeLessThan(0.001);
    expect(p2.y).toBe(spot.y);
    const married = day(world, { 1: 'D', 3: 'D', 10: 'M' });
    const lot = layout.lots[10]!;
    const home = place(2, married);
    expect(home.posture).toBe('home');
    expect(home.couple).toBe(10);
    expect(home.x).toBeGreaterThan(lot.x);
    expect(home.x).toBeLessThan(lot.x + LOT_W);
    const broken = day(world, { 1: 'D', 3: 'D', 10: 'B' });
    expect(place(2, broken).posture).toBe('single');
    // A partner of a couple not yet formed is still where the earlier couple left them.
    const before = day(world, { 1: 'D', 3: 'M' });
    expect(place(2, before).posture).toBe('single');
    expect(place(7, before).posture).toBe('home');
  });

  it('places the same agent the same way however often or in whatever order it is asked', () => {
    const states = day(world, { 2: 'C', 5: 'S', 7: 'D' });
    const first = agents.map((a) => placeAgent(a, states, layout, world.couples));
    const reversed = [...agents].reverse().map((a) => placeAgent(a, states, layout, world.couples)).reverse();
    expect(reversed).toEqual(first);
  });
});

describe('town houses and motion', () => {
  it('keeps a first-marriage house standing, dims it on divorce, and raises a new home only at the wedding', () => {
    expect(houseState('M', 'initial')).toEqual({ visible: true, dim: false, conflict: false });
    expect(houseState('C', 'initial')).toEqual({ visible: true, dim: false, conflict: true });
    expect(houseState('D', 'initial')).toEqual({ visible: true, dim: true, conflict: false });
    expect(houseState('T', 'remarriage').visible).toBe(false);
    expect(houseState('-', 'remarriage').visible).toBe(false);
    expect(houseState('B', 'remarriage').visible).toBe(false);
    expect(houseState('M', 'remarriage').visible).toBe(true);
    expect(houseState('D', 'remarriage')).toEqual({ visible: true, dim: true, conflict: false });
  });

  it('walks at 1x and 10x and jumps at 50x or when the day moves by more than one', () => {
    expect(walkSpeed(1)).toBeGreaterThan(0);
    expect(walkSpeed(10)!).toBeGreaterThan(walkSpeed(1)!);
    expect(walkSpeed(50)).toBeNull();
    expect(shouldSnap(null, 0, 1)).toBe(true);
    expect(shouldSnap(10, 11, 10)).toBe(false);
    expect(shouldSnap(10, 20, 10)).toBe(true);
    expect(shouldSnap(10, 11, 50)).toBe(true);
  });

  it('steps toward a target by at most the allowed distance and stops on it', () => {
    const [x, y, moving] = stepToward(0, 0, 100, 0, 30);
    expect([x, y, moving]).toEqual([30, 0, true]);
    expect(stepToward(95, 0, 100, 0, 30)).toEqual([100, 0, false]);
    const [dx, dy] = stepToward(0, 0, 30, 40, 10);
    expect(Math.hypot(dx, dy)).toBeCloseTo(10, 6);
  });

  it('draws houses only when a lot is too small on screen to read a figure', () => {
    expect(roofsOnly(0.3)).toBe(true);
    expect(roofsOnly(0.75)).toBe(false);
  });

  it('hashes integers into a stable spread in [0, 1)', () => {
    const values = Array.from({ length: 2000 }, (_, i) => hash01(i, 3));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(hash01(42, 3)).toBe(hash01(42, 3));
    const mean = values.reduce((p, q) => p + q, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

describe('town new homes', () => {
  it('gives a house only to remarried couples that marry at some point, and keeps a dating pair in the plaza without one', () => {
    const { world, rows } = smallWorld();
    const states = [
      world.couples.map((id) => (id >= 10 ? '-' : 'M')).join(''),
      world.couples.map((id) => (id === 10 ? 'T' : id === 11 ? 'T' : id === 1 || id === 3 || id === 0 || id === 2 ? 'D' : 'M')).join(''),
      world.couples.map((id) => (id === 10 ? 'M' : id === 11 ? 'B' : id === 1 || id === 3 || id === 0 || id === 2 ? 'D' : 'M')).join(''),
    ];
    const homes = everMarried({ origin: world.origin, states });
    expect([...homes]).toEqual([10]);
    const layout = buildLayout(world, homes);
    expect(layout.order.newhomes).toEqual([10]);
    expect(layout.lots[11]).toBeUndefined();
    expect(lotAt(layout, layout.newHomes.x + 4, layout.newHomes.y + 4)).toBe(10);
    const agents = buildAgents(world, rows);
    const a1 = agents.find((a) => a.id === 1)!;
    const p = placeAgent(a1, states[1], layout, world.couples);
    expect(p.posture).toBe('dating');
    expect(p.couple).toBe(11);
    expect(placeAgent(a1, states[2], layout, world.couples).posture).toBe('single');
  });

  it('leaves the open plaza larger when fewer remarried couples need a house', () => {
    const { world } = smallWorld();
    const all = buildLayout(world);
    const one = buildLayout(world, new Set([10]));
    expect(one.newHomes.h).toBeLessThanOrEqual(all.newHomes.h);
    expect(one.singles.h + one.dating.h).toBeGreaterThanOrEqual(all.singles.h + all.dating.h);
  });
});

describe('town keyboard', () => {
  it('walks the houses from the control district through the new homes to the treatment district', () => {
    const { world } = smallWorld();
    const layout = buildLayout(world);
    expect(focusOrder(layout)).toEqual([0, 2, 4, 6, 8, 10, 11, 1, 3, 5, 7, 9]);
  });

  it('moves one house sideways, one row up or down inside a zone, opens on Enter or Space, and ignores other keys', () => {
    const n = 60;
    const world: Shape = {
      couples: Array.from({ length: n }, (_, i) => i),
      arms: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 'control' : 'treatment')) as WorldResponse['arms'],
      origin: Array.from({ length: n }, () => 'initial') as WorldResponse['origin'],
    };
    const layout = buildLayout(world);
    const order = focusOrder(layout);
    expect(moveFocus(layout, order, 0, 'ArrowRight')).toBe(1);
    expect(moveFocus(layout, order, 0, 'ArrowLeft')).toBe(0);
    expect(moveFocus(layout, order, 0, 'ArrowDown')).toBe(DISTRICT_COLS);
    expect(moveFocus(layout, order, DISTRICT_COLS, 'ArrowUp')).toBe(0);
    // The control district holds 30 lots, so a step down from the second row would leave it.
    expect(moveFocus(layout, order, DISTRICT_COLS + 5, 'ArrowDown')).toBe(DISTRICT_COLS + 5);
    expect(moveFocus(layout, order, 3, 'Home')).toBe(0);
    expect(moveFocus(layout, order, 3, 'End')).toBe(order.length - 1);
    expect(moveFocus(layout, order, 3, 'Enter')).toBe('open');
    expect(moveFocus(layout, order, 3, ' ')).toBe('open');
    expect(moveFocus(layout, order, 3, 'q')).toBeNull();
    expect(moveFocus(layout, [], 0, 'ArrowRight')).toBeNull();
  });
});


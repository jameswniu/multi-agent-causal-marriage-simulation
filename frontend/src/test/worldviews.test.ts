// Tests for the pure helpers behind the World page's colour views, time bar and couple panel:
// reading lens bytes back, the colour ramp, the density strip's series, shock bands, the jump to a
// couple's next event, the day's counts, the panel's plain-word state, and the mini-map colours.
import { describe, expect, it } from 'vitest';
import type { CoupleDetailResponse, CoupleRow, DailyRow, DayDigest, EventRow, LegacyRow, LensData, ShockKind, ShockSpec } from '../types';
import { LENS_EMPTY, LENS_MISSING, LENS_TOP, badness, cssColor, fmtLens, lensByte, lensColor, lensValue, meanValue, rampColor } from '../town/lens';
import { countsForDay, dayLabel, densitySeries, kindWords, nextEventDay, shockBands, shockEnd } from '../town/timebar';
import { legacyWords, sparkPoints, stateOnDay } from '../town/Inspector';
import { miniColor } from '../town/TownView';
import { dotTint } from '../town/layout';

function lens(bytes: number[], days: number, couples: number): LensData {
  return { name: 'grudge', days, couples, lo: 0, hi: 1.5, worseHigh: true, bytes: Uint8Array.from(bytes) };
}

describe('lens bytes', () => {
  // Two days of three couples, day-major: day 0 is [0, 127, missing], day 1 is [top, 10, 20].
  const data = lens([0, 127, LENS_MISSING, LENS_TOP, 10, 20], 2, 3);

  it('reads day-major bytes and clamps the day to the run', () => {
    expect(lensByte(data, 0, 1)).toBe(127);
    expect(lensByte(data, 1, 0)).toBe(LENS_TOP);
    expect(lensByte(data, 9, 2)).toBe(20);
    expect(lensByte(data, -4, 0)).toBe(0);
  });

  it('treats a couple outside the buffer, or an empty run, as missing', () => {
    expect(lensByte(data, 0, 3)).toBe(LENS_MISSING);
    expect(lensByte(data, 0, -1)).toBe(LENS_MISSING);
    expect(lensByte(lens([], 0, 3), 0, 0)).toBe(LENS_MISSING);
  });

  it('turns a byte back into its value and its place between the good and bad ends', () => {
    expect(lensValue(0, 0, 1.5)).toBe(0);
    expect(lensValue(LENS_TOP, 0, 1.5)).toBeCloseTo(1.5);
    expect(lensValue(127, 0, 1)).toBeCloseTo(0.5, 2);
    expect(lensValue(LENS_MISSING, 0, 1)).toBeNull();
    expect(badness(LENS_TOP, true)).toBe(1);
    expect(badness(LENS_TOP, false)).toBe(0);
    expect(badness(0, false)).toBe(1);
    expect(badness(LENS_MISSING, true)).toBeNull();
  });

  it('ramps from green through yellow to red and greys out a missing couple', () => {
    expect(rampColor(0)).toBe(0x1baf7a);
    expect(rampColor(0.5)).toBe(0xf6c945);
    expect(rampColor(1)).toBe(0xd03b3b);
    expect(rampColor(-2)).toBe(0x1baf7a);
    expect(rampColor(7)).toBe(0xd03b3b);
    expect(lensColor(LENS_MISSING, true)).toBe(LENS_EMPTY);
    expect(lensColor(LENS_TOP, true)).toBe(0xd03b3b);
    expect(lensColor(LENS_TOP, false)).toBe(0x1baf7a);
    expect(cssColor(0x006300)).toBe('#006300');
  });

  it('averages a lens over some couples, skipping missing ones, and formats it', () => {
    expect(meanValue(data, 0, [0, 1, 2])).toBeCloseTo((127 / LENS_TOP) * 1.5 / 2);
    expect(meanValue(data, 0, [2])).toBeNull();
    expect(fmtLens(0.8412, 1)).toBe('0.84');
    expect(fmtLens(12.4, 42)).toBe('12');
  });
});

describe('time bar', () => {
  const digest: DayDigest = {
    days: 4,
    groups: ['control', 'treatment', 'remarriage'],
    kinds: {
      conflict_started: { control: [1, 0, 3, 0], treatment: [2, 5, 0, 1], remarriage: [9, 9, 9, 9] },
      separated: { control: [0, 1, 0, 0], treatment: [0, 0, 2, 0] },
      divorced: { treatment: [0, 0, 0, 1] },
      memory_consolidated: { control: [4, 4, 4, 4], treatment: [4, 4, 4, 4] },
    },
  };

  it('labels a day with its week of the run', () => {
    expect(dayLabel(143)).toBe('Day 143, week 21');
    expect(dayLabel(0)).toBe('Day 0, week 1');
    expect(dayLabel(6)).toBe('Day 6, week 1');
    expect(dayLabel(7)).toBe('Day 7, week 2');
    expect(dayLabel(-3)).toBe('Day 0, week 1');
  });

  it('builds the density series per arm from the digest, leaving remarriages out', () => {
    const d = densitySeries(digest, 4);
    expect(d.control.conflicts).toEqual([1, 0, 3, 0]);
    expect(d.treatment.conflicts).toEqual([2, 5, 0, 1]);
    expect(d.control.separations).toEqual([0, 1, 0, 0]);
    expect(d.control.divorces).toEqual([0, 0, 0, 0]);
    expect(d.treatment.divorces).toEqual([0, 0, 0, 1]);
    expect(d.maxConflicts).toBe(5);
    expect(d.maxMarks).toBe(2);
  });

  it('pads a short digest with zeros and keeps the maxima at one without a digest', () => {
    expect(densitySeries(digest, 6).control.conflicts).toEqual([1, 0, 3, 0, 0, 0]);
    const none = densitySeries(null, 3);
    expect(none.treatment.separations).toEqual([0, 0, 0]);
    expect(none.maxConflicts).toBe(1);
    expect(none.maxMarks).toBe(1);
  });

  const kind = (k: string, over: Partial<ShockKind>): ShockKind => ({
    kind: k,
    label: k,
    blurb: '',
    member_applies: true,
    magnitude: { min: 0, max: 1, default: 0.5, unit: '' },
    default_start_day: 30,
    default_end_day: null,
    ...over,
  });
  const catalog = {
    job_loss: kind('job_loss', { default_length_days: 60 }),
    windfall: kind('windfall', { default_start_day: 10, default_end_day: 40 }),
    trait_shift: kind('trait_shift', {}),
  };
  const shock = (over: Partial<ShockSpec>): ShockSpec => ({ kind: 'job_loss', target: 'treatment', member: 'a', start_day: 100, end_day: null, magnitude: 0.5, ...over });

  it('ends each shock the way the engine does, clamped to the run', () => {
    expect(shockEnd(shock({ end_day: 150 }), catalog, 365)).toBe(150);
    expect(shockEnd(shock({}), catalog, 365)).toBe(160);
    expect(shockEnd(shock({ kind: 'windfall' }), catalog, 365)).toBe(130);
    expect(shockEnd(shock({ kind: 'trait_shift' }), catalog, 365)).toBe(364);
    expect(shockEnd(shock({ kind: 'not_in_catalog' }), catalog, 365)).toBe(364);
    expect(shockEnd(shock({ start_day: 340 }), catalog, 365)).toBe(364);
    expect(shockEnd(shock({ end_day: 50 }), catalog, 365)).toBe(100);
  });

  it('draws one band per shock that starts inside the run', () => {
    const bands = shockBands(
      [shock({ end_day: 120 }), shock({ target: 'all', start_day: 400 }), shock({ target: 'control', start_day: 0, end_day: 10 })],
      catalog,
      365,
      (s) => `${s.kind} on ${s.target}`,
    );
    expect(bands).toEqual([
      { start: 100, end: 120, target: 'treatment', label: 'job_loss on treatment' },
      { start: 0, end: 10, target: 'control', label: 'job_loss on control' },
    ]);
  });

  const ev = (day: number, k: string, seq = 0): EventRow => ({ day, seq, couple_id: 7, agent_id: null, kind: k, from_state: null, to_state: null, value: null });

  it("finds the couple's next day with an event, past housekeeping", () => {
    const events = [ev(40, 'conflict_started'), ev(12, 'married'), ev(30, 'memory_consolidated'), ev(40, 'reconciled', 1), ev(55, 'separated')];
    expect(nextEventDay(events, 0)).toBe(12);
    expect(nextEventDay(events, 12)).toBe(40);
    expect(nextEventDay(events, 29)).toBe(40);
    expect(nextEventDay(events, 55)).toBeNull();
    expect(nextEventDay([], 0)).toBeNull();
  });

  it("counts the day's events by kind and group, busiest first, housekeeping apart", () => {
    const { rows, housekeeping } = countsForDay(digest, 1);
    expect(rows.map((r) => r.kind)).toEqual(['conflict_started', 'separated']);
    expect(rows[0]).toEqual({ kind: 'conflict_started', control: 0, treatment: 5, remarriage: 9, total: 14 });
    expect(housekeeping).toBe(8);
    expect(countsForDay(null, 1)).toEqual({ rows: [], housekeeping: 0 });
    expect(kindWords('conflict_started')).toBe('conflict started');
  });
});

describe('couple panel helpers', () => {
  const daily = (day: number, over: Partial<DailyRow> = {}): DailyRow => ({
    day,
    couple_id: 7,
    state: 'married',
    in_conflict: false,
    conflict_days: 0,
    intensity: 0,
    positive_episode: false,
    trust_a: 0.8,
    trust_b: 0.6,
    affect_a: 0,
    affect_b: 0,
    satisfaction_a: 0.5,
    satisfaction_b: 0.5,
    neg_a: 0,
    neg_b: 0,
    pos_a: 0,
    pos_b: 0,
    stress_a: 0,
    stress_b: 0,
    ...over,
  });
  const couple: CoupleRow = {
    couple_id: 7,
    agent_a: 14,
    agent_b: 15,
    arm: 'treatment',
    origin: 'initial',
    formed_day: 5,
    married_day: 5,
    compatibility: 0.5,
    final_state: 'divorced',
    ended_day: 200,
    years_married_at_start: 3,
  };
  const detail = (rows: DailyRow[]): CoupleDetailResponse => ({ couple, agents: [], daily: rows, events: [], conflicts: [], decisions: [] });

  it("says the couple's state on the day in plain words", () => {
    const d = detail([daily(10), daily(11, { in_conflict: true, conflict_days: 1 }), daily(12, { in_conflict: true, conflict_days: 3 }), daily(13, { state: 'separated' })]);
    expect(stateOnDay(d, 10)).toBe('married and at home');
    expect(stateOnDay(d, 11)).toBe('married, in a conflict on its 1st day');
    expect(stateOnDay(d, 12)).toBe('married, in a conflict on its 3rd day');
    expect(stateOnDay(d, 13)).toBe('separated, one partner has moved out');
    expect(stateOnDay(d, 2)).toBe('not formed yet, they meet on day 5');
    expect(stateOnDay(d, 250)).toBe('divorced since day 200');
    expect(stateOnDay(d, 100)).toBe('no record that day');
  });

  it('plots a series on a box 40 units tall, clamped to its range', () => {
    const rows = [daily(0, { trust_a: 0 }), daily(1, { trust_a: 1 }), daily(2, { trust_a: 4 })];
    expect(sparkPoints(rows, (r) => r.trust_a, 0, 1)).toBe('0,39.00 1,1.00 2,1.00');
  });

  it('puts a sealed record in plain words', () => {
    const l: LegacyRow = {
      day: 90,
      couple_id: 3,
      agent_id: 14,
      partner_id: 9,
      ended_by: 'partner',
      conflicts: 6,
      reconciled: 2,
      final_trust: 0.31,
      final_neg_load: 1,
      final_pos_load: 0.2,
      match_quality: 0.4,
      commitment_shift: 0.05,
      trust_prior: 0.62,
    };
    expect(legacyWords(l)).toBe(
      'Agent 14 sealed a record of couple 3 on day 90, when their partner left: 6 conflicts, 2 reconciled, final trust 0.31. Leaving comes easier by 0.05 and a new marriage starts at trust 0.62.',
    );
  });
});

describe('mini-map colours', () => {
  it('match the town dots at home, in a conflict and apart', () => {
    expect(miniColor('M', 'treatment', 'initial')).toBe(cssColor(dotTint('home', 'treatment', 'initial')));
    expect(miniColor('M', 'control', 'remarriage')).toBe(cssColor(dotTint('home', 'control', 'remarriage')));
    expect(miniColor('C', 'control', 'initial')).toBe(cssColor(dotTint('conflict', 'control', 'initial')));
    expect(miniColor('S', 'treatment', 'initial')).toBe(cssColor(dotTint('away', 'treatment', 'initial')));
    expect(miniColor('D', 'control', 'initial')).toBe('#898781');
    expect(miniColor('-', null, null)).toBeNull();
  });
});

// Unit tests for the pure pieces behind shocking a world in place: which couples differ from the world a
// fork came from on a day, the counter's words, the day the new world's replay starts on, the ring's
// width at every zoom, and the words for a run with no intervention.
import { describe, expect, it } from 'vitest';
import { DIFF_RING, DIFF_RING_CSS, differCounter, differingOnDay, matchCouples } from '../worldDiff';
import { REPLAY_LEAD_DAYS, replayStartDay } from '../shockForm';
import { ringWidth } from '../town/layout';
import { cssColor } from '../town/lens';
import { chanceWords, noIntervention, signedPoints, twinWords } from '../nullRun';
import type { Outcome, WorldResponse } from '../types';
import type { ShockForm } from '../validation';

function world(couples: number[], origin: WorldResponse['origin'], states: string[]): WorldResponse {
  return { days: states.length, couples, arms: couples.map((_, i) => (i % 2 ? 'treatment' : 'control')), origin, states, legend: {}, counts: [] };
}

describe('what differs between a fork and its parent', () => {
  // Three starting couples in each world; the child adds a remarriage that reuses an id the parent gave
  // to different people, and lists its couples in another order.
  const parent = world([0, 1, 2, 3], ['initial', 'initial', 'initial', 'remarriage'], ['MMM-', 'MCM-', 'MCDT']);
  const child = world([2, 0, 1, 3], ['initial', 'initial', 'initial', 'remarriage'], ['MMM-', 'CMM-', 'SMCB']);

  it('pairs each starting couple with the same couple id and leaves remarriages out', () => {
    const m = matchCouples(child, parent);
    expect(Array.from(m.other)).toEqual([2, 0, 1, -1]);
    expect(m.compared).toBe(3);
  });

  it('lists the couples of the drawn world whose state that day differs, by its own indices', () => {
    const m = matchCouples(child, parent);
    expect(differingOnDay(child, parent, m, 0)).toEqual([]);
    // Day 1: couple 0 is married in both, couple 1 fights only in the parent, couple 2 only in the child.
    expect(differingOnDay(child, parent, m, 1)).toEqual([0, 2]);
    // Day 2: couple 2 is separated in the child and divorced in the parent. The remarriage differs too,
    // but it is never compared.
    expect(differingOnDay(child, parent, m, 2)).toEqual([0]);
  });

  it('gives the same couples whichever world is drawn, and holds the last day past the end', () => {
    const back = matchCouples(parent, child);
    const ids = (w: WorldResponse, idx: number[]) => idx.map((i) => w.couples[i]).sort();
    expect(ids(parent, differingOnDay(parent, child, back, 1))).toEqual(ids(child, differingOnDay(child, parent, matchCouples(child, parent), 1)));
    expect(differingOnDay(child, parent, matchCouples(child, parent), 99)).toEqual(differingOnDay(child, parent, matchCouples(child, parent), 2));
  });

  it('finds nothing in two identical worlds, and nothing when the other world is empty', () => {
    const m = matchCouples(child, child);
    for (let d = 0; d < 3; d++) expect(differingOnDay(child, child, m, d)).toEqual([]);
    const empty = world([], [], []);
    expect(matchCouples(child, empty).compared).toBe(0);
    expect(differingOnDay(child, empty, matchCouples(child, empty), 1)).toEqual([]);
  });

  it('words the counter for any count', () => {
    expect(differCounter(37, 1000, 'example')).toBe('37 of 1,000 couples differ from example today');
    expect(differCounter(1, 1000, 'example')).toBe('1 of 1,000 couples differs from example today');
    expect(differCounter(0, 1000, 'example')).toBe('0 of 1,000 couples differ from example today');
  });
});

describe('where the new world replay starts', () => {
  const row = (start: number, effects?: number[]): ShockForm => ({
    id: start,
    kind: effects ? 'custom' : 'job_loss',
    target: 'treatment',
    member: 'random',
    start_day: start,
    end_day: null,
    magnitude: 1,
    trait: null,
    ...(effects ? { label: 'x', effects: effects.map((s) => ({ channel: 'stress' as const, op: 'add' as const, amount: 0.1, cadence: 'daily' as const, who: 'both' as const, start_day: s })) } : {}),
  });

  it('starts ten days before the first shock acts', () => {
    expect(REPLAY_LEAD_DAYS).toBe(10);
    expect(replayStartDay([row(90)], 365)).toBe(80);
    expect(replayStartDay([row(200), row(120)], 365)).toBe(110);
    // A custom shock acts from its earliest effect, which may start after the shock does.
    expect(replayStartDay([row(60, [95, 100])], 365)).toBe(85);
  });

  it('starts on the first day without shocks or when the shock is early, and inside the run', () => {
    expect(replayStartDay([], 365)).toBe(0);
    expect(replayStartDay([row(4)], 365)).toBe(0);
    expect(replayStartDay([row(400)], 365)).toBe(364);
  });
});

describe('the ring around a house that differs', () => {
  it('is one colour for the town, the grid and the page, the one the contract names', () => {
    expect(DIFF_RING_CSS).toBe('#ff2bd6');
    expect(cssColor(DIFF_RING)).toBe(DIFF_RING_CSS);
  });

  it('stays about three screen pixels wide when zoomed out and never thinner than three world units', () => {
    for (const scale of [0.2, 0.35, 0.5, 0.75]) expect(ringWidth(scale) * scale).toBeCloseTo(3, 5);
    expect(ringWidth(1)).toBe(3);
    expect(ringWidth(4)).toBe(3);
    expect(ringWidth(0)).toBeGreaterThan(1000);
  });
});

describe('a run with no intervention', () => {
  const divorce = { ate: -0.012, ci_low: -0.03, ci_high: 0.006, ci_level: 0.95 } as Outcome;

  it('is one whose arms share memory and have no shock aimed at either arm alone', () => {
    const same = { parameter: 'none', control_value: null, treatment_value: null };
    expect(noIntervention(same, [])).toBe(true);
    expect(noIntervention(same, undefined)).toBe(true);
    const everyone = { kind: 'job_loss', target: 'all' as const, member: 'random' as const, start_day: 9, end_day: null, magnitude: 1 };
    expect(noIntervention(same, [everyone])).toBe(true);
    expect(noIntervention({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 }, [])).toBe(false);
    expect(noIntervention(same, [{ ...everyone, target: 'treatment' }])).toBe(false);
    // A shock the engine aims at the control arm alone is an intervention too.
    expect(noIntervention(same, [everyone, { ...everyone, target: 'control' }])).toBe(false);
  });

  it('without twins, says the gap comes from splitting the couples, with the gap, its range and whether it includes zero', () => {
    expect(chanceWords(divorce, 1000)).toEqual({
      lead: 'Both halves follow identical rules, so the gap between them comes only from splitting 1,000 different couples in two.',
      detail: 'The divorce gap, treatment minus control, is -1.2 points, with a 95% range of -3.0 to +0.6, which includes zero.',
    });
    expect(chanceWords({ ...divorce, ate: 0.021, ci_low: 0.003, ci_high: 0.039 }, 1000).detail).toContain('which does not include zero. With identical rules that happens by chance in about one run in 20.');
    expect(chanceWords(null, 500)).toEqual({ lead: 'Both halves follow identical rules, so the gap between them comes only from splitting 500 different couples in two.', detail: null });
    expect(chanceWords({ ...divorce, ci_low: null }, 1000).detail).toBeNull();
  });

  it('with twins, leads with the same couples coming out the same under both settings', () => {
    const paired = ['divorce_rate', 'final_trust'].map((name) => ({ name, mean_diff: 0, ci_low: 0, ci_high: 0, n_pairs: 1000, share_changed: 0 }));
    const same = { paired, identical_parameters: true, dynamics_hashes_equal: true };
    expect(twinWords(same, 1000)).toBe('Run on the same 1,000 couples, the two settings give identical results, and 0 of 1,000 couples end differently.');
    const words = chanceWords(divorce, 1000, same);
    expect(words.lead).toBe(twinWords(same, 1000));
    expect(words.detail).toBe(
      'The two halves of the town are different couples, and two different groups never come out exactly even. Their divorce gap, treatment minus control, is -1.2 points, with a 95% range of -3.0 to +0.6, which includes zero.',
    );
    // An older summary without the behaviour-table check still counts every outcome unchanged as identical.
    expect(twinWords({ paired }, 1000)).toContain('give identical results');
    // Twins that did come out differently are never called identical.
    const apart = { paired: paired.map((r) => (r.name === 'divorce_rate' ? { ...r, share_changed: 0.012 } : r)), dynamics_hashes_equal: false };
    expect(twinWords(apart, 1000)).toBe('Run on the same 1,000 couples, the two settings do not give identical results, and 12 of 1,000 couples divorce under one and not the other.');
    expect(twinWords({ paired: paired.map((r) => ({ ...r, share_changed: undefined })) }, 1000)).toBe('Run on the same 1,000 couples, the two settings do not give identical results.');
    expect(twinWords(null, 1000)).toBeNull();
    expect(twinWords({ paired: [] }, 1000)).toBeNull();
  });

  it('writes signed points with one decimal and no negative zero', () => {
    expect(signedPoints(-0.012)).toBe('-1.2');
    expect(signedPoints(0.006)).toBe('+0.6');
    expect(signedPoints(0)).toBe('0.0');
    expect(signedPoints(-0.0001)).toBe('0.0');
  });
});

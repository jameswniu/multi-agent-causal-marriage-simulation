// Tests for the LoveWorld dashboard components, the pages that show a simulated marriage experiment:
// labels and plain-words copy, charts, the developer log, validation and run requests.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AteTable from '../components/AteTable';
import ForestPlot from '../components/ForestPlot';
import { buildSegments } from '../components/StateGantt';
import { changedOnDay, charStyle } from '../components/WorldGrid';
import { probabilities } from '../components/UnderTheHood';
import { buildRequest } from '../pages/NewExperiment';
import { renderHook, waitFor } from '@testing-library/react';
import { useAsync } from '../useAsync';
import StateGantt from '../components/StateGantt';
import { fmtCi, fmtP } from '../format';
import { oneInN } from '../components/Scoreboard';
import { framingSentence, gridTitles, splitTicker, takeaway } from '../pages/World';
import { armLabels, differenceClause, humanDuration, interventionOf, interventionSummary, memoryWords, sharedClause, shockBrief, shockShort, shockWords, whatDiffers, toCatalog, type Catalog } from '../arms';
import { validateRun, type RunForm } from '../validation';
import { legacySentence, orphanNote, previousRecords, unionOfDays } from '../components/UnderTheHood';
import * as api from '../api';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
import shocksCatalog from '../fixtures/shocksCatalog.json';
import experimentsFixture from '../fixtures/experiments.json';
import type { ExperimentsResponse, ShockKind, ShockSpec } from '../types';
import type { DailyRow, Outcome } from '../types';
import experiment from '../fixtures/experiment.json';

const outcomes = (experiment as { summary: { outcomes: Outcome[] } }).summary.outcomes;

describe('AteTable', () => {
  it('formats confidence intervals and small p-values', () => {
    render(<AteTable outcomes={outcomes.slice(0, 1)} />);
    expect(screen.getByText('[3.4%, 9.8%]')).toBeInTheDocument();
    expect(screen.getByText('95% CI')).toBeInTheDocument();
    expect(screen.getByText('< 0.001')).toBeInTheDocument();
    expect(screen.getByText('5.2%')).toBeInTheDocument();
    expect(screen.getByText('+6.6%')).toBeInTheDocument();
  });
  it('formats helpers', () => {
    expect(fmtCi(-0.5, 0.25, 2)).toBe('[-0.50, 0.25]');
    expect(fmtP(0.0432)).toBe('0.043');
    expect(fmtP(null)).toBe('n/a');
  });
});

describe('ForestPlot', () => {
  it('renders one row per outcome', () => {
    render(<ForestPlot outcomes={outcomes} width={600} />);
    expect(screen.getAllByTestId('forest-row').length).toBe(outcomes.length);
  });
});

describe('buildSegments', () => {
  it('collapses a daily series into state runs split by conflict', () => {
    const base: Omit<DailyRow, 'day' | 'state' | 'in_conflict'> = {
      couple_id: 1, conflict_days: 0, intensity: 0, positive_episode: false, trust_a: 0.5, trust_b: 0.5, affect_a: 0, affect_b: 0,
      satisfaction_a: 0.5, satisfaction_b: 0.5, neg_a: 0, neg_b: 0, pos_a: 0, pos_b: 0, stress_a: 0, stress_b: 0,
    };
    const daily: DailyRow[] = [
      { ...base, day: 0, state: 'married', in_conflict: false },
      { ...base, day: 1, state: 'married', in_conflict: false },
      { ...base, day: 2, state: 'married', in_conflict: true },
      { ...base, day: 3, state: 'married', in_conflict: true },
      { ...base, day: 4, state: 'separated', in_conflict: false },
      { ...base, day: 5, state: 'divorced', in_conflict: false },
    ];
    const segs = buildSegments(daily);
    expect(segs).toEqual([
      { state: 'married', start: 0, end: 1, inConflict: false },
      { state: 'married', start: 2, end: 3, inConflict: true },
      { state: 'separated', start: 4, end: 4, inConflict: false },
      { state: 'divorced', start: 5, end: 5, inConflict: false },
    ]);
  });
});

describe('charStyle', () => {
  it('maps every legend letter to a tile style', () => {
    expect(charStyle('M').label).toBe('married');
    expect(charStyle('C')).toMatchObject({ inner: true, label: 'married, in conflict' });
    expect(charStyle('M').inner).toBe(false);
    expect(charStyle('C').fill).toBe(charStyle('M').fill);
    expect(charStyle('D').fill).not.toBe(charStyle('B').fill);
    expect(charStyle('B').slash).toBe(true);
    expect(charStyle('D').slash).toBe(false);
    expect(charStyle('S').label).toBe('separated');
    expect(charStyle('T').label).toBe('dating');
    expect(charStyle('D').label).toBe('divorced');
    expect(charStyle('B').label).toBe('broken up');
    expect(charStyle('-')).toMatchObject({ empty: true, label: 'not formed yet' });
    const fills = new Set(['M', 'S', 'T', 'D', 'B'].map((c) => charStyle(c).fill));
    expect(fills.size).toBe(5);
  });
});

describe('World copy', () => {
  const spec = { parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 };
  const catalog: Catalog = toCatalog((shocksCatalog as { kinds: ShockKind[] }).kinds)!;
  it('fills the framing sentence and grid titles from the intervention', () => {
    const iv = interventionOf(spec, []);
    expect(framingSentence(1000, iv, catalog, 'randomized')).toBe(
      'Both grids start from the same 1,000 couples on the same day. On the left a fight fades from memory in 14 days. On the right it lingers for 90. Nothing else differs.',
    );
    expect(gridTitles(armLabels(spec))).toEqual(['Forgets fights in 2 weeks', 'Holds onto fights for 3 months']);
    expect(framingSentence(1000, iv, catalog, 'twins')).toMatch(/one couple shown twice/);
  });
  it('frames a shock-only experiment by its shocks', () => {
    const shocks: ShockSpec[] = [
      { kind: 'job_loss', target: 'treatment', member: 'random', start_day: 60, end_day: 210, magnitude: 1.5, trait: null },
      { kind: 'date_nights', target: 'all', member: 'random', start_day: 0, end_day: null, magnitude: 1, trait: null },
    ];
    const iv = interventionOf({ parameter: 'none', control_value: null, treatment_value: null }, shocks);
    expect(framingSentence(1000, iv, catalog, 'randomized')).toBe(
      'Both grids start from the same 1,000 couples on the same day. Only this, one partner loses their job (a random partner, treatment arm), days 60 to 210, magnitude 1.5 (stress). Memory is identical in both arms. Everyone also lives through every seventh day both partners store a positive memory of an evening together (both partners, everyone), from day 0 to the end of the run, magnitude 1 (warmth).',
    );
    expect(framingSentence(1000, iv, catalog, 'twins')).toContain('the only difference is one partner loses their job (a random partner, treatment arm), days 60 to 210, magnitude 1.5 (stress). Memory is identical in both arms.');
  });
  it('phrases divorce as 1 in N and writes the takeaway', () => {
    expect(oneInN(26, 500)).toBe('1 in 19');
    expect(oneInN(0, 500)).toBe('none');
    const c = { married: 470, conflict: 20, separated: 4, divorced: 26 };
    const t = { married: 420, conflict: 30, separated: 10, divorced: 59 };
    expect(takeaway(364, c, t, 500, 500, 'randomized')).toBe(
      'By day 365, 5.2% of control couples had divorced against 11.8% of treatment couples. The only difference was how long a fight stayed in memory.',
    );
    expect(takeaway(364, c, t, 500, 500, 'randomized', 'this, one partner loses their job on day 60')).toMatch(/The only difference was this, one partner loses their job on day 60\.$/);
  });
});

describe('arm labels', () => {
  it('rounds durations to weeks under 60 days and months above', () => {
    expect(humanDuration(14)).toBe('2 weeks');
    expect(humanDuration(7)).toBe('1 week');
    expect(humanDuration(45)).toBe('6 weeks');
    expect(humanDuration(60)).toBe('2 months');
    expect(humanDuration(90)).toBe('3 months');
    expect(humanDuration(3)).toBe('3 days');
  });
  it('derives plain labels with the technical word in small text', () => {
    const l = armLabels({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 });
    expect(l.control).toEqual({ plain: 'Forgets fights in 2 weeks', small: 'control, 14-day memory half-life' });
    expect(l.treatment).toEqual({ plain: 'Holds onto fights for 3 months', small: 'treatment, 90-day memory half-life' });
    expect(whatDiffers(interventionOf({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 }, []), null)).toBe('Only how long a fight stays in memory, 14 days versus 90');
    const other = armLabels({ parameter: 'positive_half_life_days', control_value: 20, treatment_value: 40 });
    expect(other.control.plain).toBe('Control, positive half life days 20');
    expect(armLabels(undefined).control.plain).toBe('Control');
  });
});

describe('pulses, probabilities, requests, async', () => {
  it('a tile pulses only on the day its state changed', () => {
    const states = ['MM', 'MC', 'MC', 'MD'];
    expect(changedOnDay(states, 0, 1)).toBe(false);
    expect(changedOnDay(states, 1, 1)).toBe(true);
    expect(changedOnDay(states, 2, 1)).toBe(false);
    expect(changedOnDay(states, 3, 1)).toBe(true);
    expect(changedOnDay(states, 3, 0)).toBe(false);
  });
  it('decision probabilities sum to one over the available actions', () => {
    const d = { u_repair: 1.0, u_hold: 0.5, u_escalate: null, u_withdraw: null, u_leave: -3 } as unknown as Parameters<typeof probabilities>[0];
    const p = probabilities(d, 0.7);
    expect(p.map(([n]) => n)).toEqual(['repair', 'hold', 'leave']);
    expect(p.reduce((a, [, x]) => a + x, 0)).toBeCloseTo(1, 9);
    expect(p[0][1]).toBeGreaterThan(p[1][1]);
  });
  it('builds the run request with treatment and world shocks split by target', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    const req = buildRequest({
      name: ' x ', nCouples: 200, days: 100, treatmentHalfLife: 30, overwrite: false,
      shocks: [
        { id: 1, kind: 'job_loss', target: 'treatment', member: 'a', start_day: 10, end_day: 50, magnitude: 1, trait: null },
        { id: 2, kind: 'date_nights', target: 'all', member: 'random', start_day: 0, end_day: null, magnitude: 1, trait: null },
        { id: 3, kind: 'trait_shift', target: 'treatment', member: 'b', start_day: 5, end_day: null, magnitude: 0.3, trait: 'neuroticism' },
      ],
    }, kinds);
    expect(req.name).toBe('x');
    expect(req.treatment.shocks?.[0]).toEqual({ kind: 'job_loss', member: 'a', start_day: 10, end_day: 50, magnitude: 1 });
    expect(req.treatment.shocks?.[1]).toEqual({ kind: 'trait_shift', member: 'b', start_day: 5, end_day: null, magnitude: 0.3, trait: 'neuroticism' });
    expect(req.world?.shocks[0].kind).toBe('date_nights');
    expect(req.analysis).toEqual({ n_boot: 500, n_perm: 500 });
  });
  it('useAsync drops old data when a new key fails', async () => {
    let fail = false;
    const load = () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve('ok'));
    const { result, rerender } = renderHook(({ k }: { k: number }) => useAsync(load, [k]), { initialProps: { k: 1 } });
    await waitFor(() => expect(result.current.data).toBe('ok'));
    fail = true;
    rerender({ k: 2 });
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });
  it('the Gantt labels its last axis tick with the last day', () => {
    const base = { couple_id: 1, in_conflict: false, conflict_days: 0, intensity: 0, positive_episode: false, trust_a: 0.5, trust_b: 0.5, affect_a: 0, affect_b: 0, satisfaction_a: 0.5, satisfaction_b: 0.5, neg_a: 0, neg_b: 0, pos_a: 0, pos_b: 0, stress_a: 0, stress_b: 0 };
    const daily: DailyRow[] = [0, 1, 2, 3, 4].map((day) => ({ ...base, day, state: 'married' as const }));
    render(<StateGantt daily={daily} width={400} lastDay={4} />);
    const labels = screen.getAllByTestId('gantt-label').map((l) => l.textContent);
    expect(labels[labels.length - 1]).toBe('Day 4');
  });

  it('labels a shock-only experiment by the shocks aimed at the treatment arm', () => {
    const catalog = toCatalog((shocksCatalog as { kinds: ShockKind[] }).kinds);
    const shocks: ShockSpec[] = [
      { kind: 'job_loss', target: 'treatment', member: 'random', start_day: 60, end_day: 210, magnitude: 1.5, trait: null },
      { kind: 'date_nights', target: 'all', member: 'random', start_day: 0, end_day: null, magnitude: 1, trait: null },
    ];
    const none = { parameter: 'none', control_value: null, treatment_value: null };
    const l = armLabels(none, shocks, catalog);
    expect(l.control.plain).toBe('No job loss');
    expect(l.treatment.plain).toBe('One partner loses their job on day 60 (1.5 stress)');
    expect(l.control.small).toBe('control, no job loss day 60');
    expect(l.treatment.small).toBe('treatment, job loss day 60');
    const iv = interventionOf(none, shocks);
    expect(whatDiffers(iv, catalog)).toBe(
      'Only this, one partner loses their job (a random partner, treatment arm), days 60 to 210, magnitude 1.5 (stress). Memory is identical in both arms. Everyone also lives through every seventh day both partners store a positive memory of an evening together (both partners, everyone), from day 0 to the end of the run, magnitude 1 (warmth).',
    );
    const two: ShockSpec[] = [...shocks, { kind: 'temptation', target: 'treatment', member: 'a', start_day: 100, end_day: 200, magnitude: 0.2, trait: null }];
    expect(armLabels(none, two, catalog).control.plain).toBe('No job loss, temptation');
    expect(armLabels(none, two, catalog).treatment.plain).toBe('One partner loses their job on day 60 (1.5 stress), one partner keeps meeting attractive alternatives on day 100 (0.2 daily probability)');
    const both = armLabels({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 }, shocks, catalog);
    expect(both.treatment.plain).toBe('Holds onto fights for 3 months, one partner loses their job on day 60 (1.5 stress)');
    expect(whatDiffers(interventionOf({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 }, shocks), catalog)).toContain(
      'Only how long a fight stays in memory, 14 days versus 90, and one partner loses their job (a random partner, treatment arm), days 60 to 210, magnitude 1.5 (stress). Everyone also',
    );
    expect(differenceClause(iv, catalog)).toBe('this, one partner loses their job (a random partner, treatment arm), days 60 to 210, magnitude 1.5 (stress)');
    expect(differenceClause(interventionOf({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 }, []), catalog)).toBe('how long a fight stayed in memory');
    expect(armLabels(none, [], catalog).control.plain).toBe('Control');
    expect(armLabels(none, [], catalog).treatment.plain).toBe('Treatment');
    // Without a catalog the kind itself is the fallback.
    expect(armLabels(none, shocks, null).treatment.plain).toBe('Job loss on day 60 (1.5)');
  });
  it('summarises the intervention for the dropdown', () => {
    const items = (experimentsFixture as unknown as ExperimentsResponse).items;
    expect(interventionSummary(items[0])).toBe('memory 14 to 90');
    expect(interventionSummary(items[1])).toBe('memory 14 to 90, everyone: job loss on day 90');
    expect(interventionSummary(items[2])).toBe('job loss on day 60, everyone: date nights on day 0');
  });

  it('validateRun covers names, bounds, day order, magnitude and traits', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    const good: RunForm = { name: 'ok-1', nCouples: 100, days: 50, treatmentHalfLife: 14, overwrite: false, shocks: [] };
    expect(validateRun(good, kinds)).toEqual([]);
    expect(validateRun({ ...good, name: 'bad name!' }, kinds)[0]).toMatch(/Name must start/);
    expect(validateRun({ ...good, nCouples: 2500 }, kinds)[0]).toMatch(/Couples must be a whole number from 1 to 2,000/);
    expect(validateRun({ ...good, days: 10.5 }, kinds)[0]).toMatch(/Days must be a whole number/);
    expect(validateRun({ ...good, treatmentHalfLife: 0 }, kinds)[0]).toMatch(/positive number of days/);
    const shock = { id: 1, kind: 'job_loss', target: 'treatment' as const, member: 'a' as const, start_day: 10, end_day: 20, magnitude: 1, trait: null };
    expect(validateRun({ ...good, shocks: [{ ...shock, start_day: 60 }] }, kinds)[0]).toMatch(/start day must be inside the run \(0 to 49\)/);
    expect(validateRun({ ...good, shocks: [{ ...shock, end_day: 5 }] }, kinds)[0]).toMatch(/end day must be on or after the start day/);
    expect(validateRun({ ...good, shocks: [{ ...shock, end_day: 49.5 }] }, kinds)[0]).toMatch(/end day must be a whole number/);
    expect(validateRun({ ...good, shocks: [{ ...shock, magnitude: 9 }] }, kinds)[0]).toMatch(/magnitude must be between 0.2 and 3 stress/);
    expect(validateRun({ ...good, shocks: [{ ...shock, trait: 'openness' }] }, kinds)[0]).toMatch(/only a trait shift takes a trait/);
    const shift = { ...shock, kind: 'trait_shift', magnitude: 0.3, trait: null };
    expect(validateRun({ ...good, shocks: [shift] }, kinds)[0]).toMatch(/choose the trait it moves/);
    expect(validateRun({ ...good, shocks: [{ ...shift, trait: 'charisma' }] }, kinds)[0]).toMatch(/trait must be one of/);
    expect(validateRun({ ...good, shocks: [{ ...shift, trait: 'openness' }] }, kinds)).toEqual([]);
  });

  it('memory wording follows the values and falls back to neutral when equal', () => {
    const shorter = armLabels({ parameter: 'conflict_half_life_days', control_value: 90, treatment_value: 14 });
    expect(shorter.control.plain).toBe('Holds onto fights for 3 months');
    expect(shorter.treatment.plain).toBe('Forgets fights in 2 weeks');
    expect(memoryWords({ parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 14 }, 'treatment')).toBe('Memory half-life is 14 days');
    const iv = interventionOf({ parameter: 'conflict_half_life_days', control_value: 90, treatment_value: 14 }, []);
    expect(framingSentence(1000, iv, null, 'randomized')).toBe(
      'Both grids start from the same 1,000 couples on the same day. On the left a fight lingers in memory for 90 days. On the right it fades faster, in 14. Nothing else differs.',
    );
  });

  it('a trait shift names the trait in every label', () => {
    const catalog = toCatalog((shocksCatalog as { kinds: ShockKind[] }).kinds);
    const shift: ShockSpec = { kind: 'trait_shift', target: 'treatment', member: 'a', start_day: 30, end_day: null, magnitude: 0.3, trait: 'neuroticism' };
    expect(shockShort(shift, catalog)).toBe('trait shift (neuroticism)');
    const l = armLabels({ parameter: 'none', control_value: null, treatment_value: null }, [shift], catalog);
    expect(l.control.plain).toBe('No trait shift (neuroticism)');
    expect(l.treatment.plain).toBe("One partner's neuroticism shifts on day 30 (+0.3 trait units)");
    const item = { ...(experimentsFixture as unknown as ExperimentsResponse).items[0], intervention: { memory: null, shocks: [shift] } };
    expect(interventionSummary(item, catalog)).toBe('trait shift (neuroticism) on day 30');
  });

  it('a run whose only intervention is a world shock is described as shared, not as a difference', () => {
    const catalog = toCatalog((shocksCatalog as { kinds: ShockKind[] }).kinds);
    const world: ShockSpec = { kind: 'date_nights', target: 'all', member: 'random', start_day: 0, end_day: null, magnitude: 1, trait: null };
    const iv = interventionOf({ parameter: 'none', control_value: null, treatment_value: null }, [world]);
    expect(whatDiffers(iv, catalog)).toBe('Nothing differs between the arms. Everyone lives through every seventh day both partners store a positive memory of an evening together (both partners, everyone), from day 0 to the end of the run, magnitude 1 (warmth).');
    expect(differenceClause(iv, catalog)).toBeNull();
    expect(sharedClause(iv, catalog)).toBe('everyone lived through every seventh day both partners store a positive memory of an evening together (both partners, everyone), from day 0 to the end of the run, magnitude 1 (warmth)');
    const c = { married: 480, conflict: 10, separated: 2, divorced: 8 };
    expect(takeaway(364, c, c, 500, 500, 'randomized', differenceClause(iv, catalog), sharedClause(iv, catalog))).toBe(
      'By day 365, 1.6% of control couples had divorced against 1.6% of treatment couples. Nothing differed between the arms; everyone lived through every seventh day both partners store a positive memory of an evening together (both partners, everyone), from day 0 to the end of the run, magnitude 1 (warmth).',
    );
    expect(framingSentence(1000, iv, catalog, 'twins')).toMatch(/nothing differs between the two runs; everyone lived through/);
  });

  it('the developer log unions days from every source and diffs against the previous logged record', () => {
    const members = [{ id: 1, label: 'A', days: [{ day: 0, trust: 0.5, affect: 0, stress: 0, neg: 0, pos: 0 }, { day: 2, trust: 0.6, affect: 0.1, stress: 0, neg: 0, pos: 0 }] }];
    const episodes = [{ day: -400, couple_id: 0, agent_id: 1, partner_id: 2, kind: 'positive', intensity: 0.2, source: 'history', amplified: false }];
    const decisions = [{ day: 5 } as unknown as Parameters<typeof unionOfDays>[2][number]];
    const events = [{ day: 7, seq: 0, couple_id: 0, agent_id: null, kind: 'shock_financial_crisis', from_state: null, to_state: null, value: 1 }];
    expect(unionOfDays(members, episodes, decisions, events)).toEqual([-400, 0, 2, 5, 7]);
    const prev = previousRecords(members);
    expect(prev.get(1)?.get(2)?.day).toBe(0);
    expect(prev.get(1)?.get(0)).toBeUndefined();
  });

  it('the developer log words a sealed marriage and the orphan state plainly', () => {
    const row = { day: 210, couple_id: 4, agent_id: 9, partner_id: 8, ended_by: 'partner' as const, conflicts: 7, reconciled: 4, final_trust: 0.214, final_neg_load: 0.9, final_pos_load: 0.1, match_quality: 0.7, commitment_shift: 0.3, trust_prior: 0.402 };
    expect(legacySentence(row)).toBe(
      'Day 210: agent 9 sealed the marriage with agent 8 after 7 conflicts, 4 reconciled, the partner left. Final trust 0.21. The next relationship starts at trust 0.40, and leaving is 0.30 easier in later relationships.',
    );
    expect(legacySentence({ ...row, conflicts: 1, ended_by: 'time', commitment_shift: 0 })).toMatch(/after 1 conflict, 4 reconciled, the separation ran out\. Final trust 0\.21\. The next relationship starts at trust 0\.40\.$/);
    expect(orphanNote(undefined, 21)).toBeNull();
    expect(orphanNote(0, 21)).toBeNull();
    expect(orphanNote(1, 21)).toBe('No warm memory on both sides for 1 day, leaving opens after 21.');
    expect(orphanNote(25, 21)).toBe('No warm memory on both sides for 25 days, leaving is now possible.');
    expect(orphanNote(5, null)).toBe('No warm memory on both sides for 5 days.');
  });

  it('the day ticker keeps memory housekeeping out of the list and counts it instead', () => {
    const ev = (seq: number, kind: string) => ({ day: 7, seq, couple_id: seq, agent_id: null, kind, from_state: null, to_state: null, value: null });
    const { shown, housekeeping } = splitTicker([ev(0, 'conflict_started'), ev(1, 'memory_consolidated'), ev(2, 'sealed'), ev(3, 'memory_consolidated')]);
    expect(shown.map((e) => e.kind)).toEqual(['conflict_started', 'sealed']);
    expect(housekeeping).toBe(2);
  });

  it('chart text and scoreboard sublines are at least 0.875rem', () => {
    render(<ForestPlot outcomes={outcomes.slice(0, 2)} width={600} />);
    const sizes = [...document.querySelectorAll('svg text')].map((t) => Number(t.getAttribute('font-size')));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
    expect(styles).toMatch(/\.score \.sub \{[^}]*font-size: 0\.875rem/);
    expect(styles).not.toMatch(/font-size: 0\.8[0-6]/);
  });

  it('the review-named unused exports are gone', () => {
    const a = api as Record<string, unknown>;
    expect(a.health).toBeUndefined();
    expect(a.getEventsRange).toBeUndefined();
    expect(a.getCurrentExperiment).toBeUndefined();
  });
});


describe('shock words', () => {
  const catalog = toCatalog((shocksCatalog as { kinds: ShockKind[] }).kinds);

  it('names every field of a shock, so shocks that differ in any field never read the same', () => {
    const s: ShockSpec = { kind: 'job_loss', target: 'treatment', member: 'b', start_day: 60, end_day: 210, magnitude: 1.5, trait: null };
    const text = shockWords(s, catalog);
    expect(text).toContain('loses their job');
    expect(text).toContain('partner B');
    expect(text).toContain('treatment arm');
    expect(text).toContain('days 60 to 210');
    expect(text).toContain('magnitude 1.5');
    expect(text).toContain(catalog.job_loss.magnitude.unit);
    const small = shockWords({ ...s, magnitude: 0.1 }, catalog);
    const big = shockWords({ ...s, magnitude: 5 }, catalog);
    expect(small).not.toBe(big);
    expect(shockWords({ ...s, target: 'control' }, catalog)).toContain('control arm');
    expect(shockWords({ ...s, target: 'all' }, catalog)).toContain('everyone');
    expect(shockWords({ ...s, member: 'a' }, catalog)).toContain('partner A');
    expect(shockWords({ ...s, member: 'random' }, catalog)).toContain('a random partner');
    expect(shockWords({ ...s, end_day: 60 }, catalog)).toContain('day 60,');
    expect(shockBrief(small === big ? s : { ...s, magnitude: 0.1 }, catalog)).not.toBe(shockBrief({ ...s, magnitude: 5 }, catalog));
  });

  it('names the trait and its signed shift for a trait shift, and both partners for a couple-wide kind', () => {
    const shift: ShockSpec = { kind: 'trait_shift', target: 'treatment', member: 'a', start_day: 30, end_day: null, magnitude: 0.3, trait: 'neuroticism' };
    const text = shockWords(shift, catalog);
    expect(text).toContain('neuroticism');
    expect(text).toContain('magnitude +0.3');
    expect(text).toContain('from day 30');
    const crisis: ShockSpec = { kind: 'financial_crisis', target: 'all', member: 'random', start_day: 90, end_day: 120, magnitude: 1, trait: null };
    expect(shockWords(crisis, catalog)).toContain('both partners');
  });

  it('resolves an open end day the way the engine does', () => {
    const k = catalog.job_loss;
    const len = k.default_length_days ?? (k.default_end_day != null ? k.default_end_day - k.default_start_day : null);
    const s: ShockSpec = { kind: 'job_loss', target: 'treatment', member: 'random', start_day: 10, end_day: null, magnitude: 1, trait: null };
    expect(shockWords(s, catalog)).toContain(len == null ? 'from day 10 to the end of the run' : `days 10 to ${10 + len}`);
    expect(shockWords(s, null)).toContain('from day 10 on');
  });
});

// Tests for how the dashboard describes custom shocks, the shocks a model writes from plain words:
// every effect in plain words, the arm labels and the "what differs" sentence.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from './mockApi';
import App from '../App';
import { buildRequest } from '../shockForm';
import { labelSlug, validateRun, type RunForm, type ShockForm } from '../validation';
import { armLabels, effectWords, interventionOf, shockBrief, shockShort, shockWords, whatDiffers, toCatalog } from '../arms';
import shocksCatalog from '../fixtures/shocksCatalog.json';
import type { EffectCatalog, EffectSpec, ShockKind, ShockSpec } from '../types';

vi.mock('../api', () => import('./mockApi'));

beforeEach(() => {
  mock.resetMockState();
});

const catalog = toCatalog((shocksCatalog as { kinds: ShockKind[] }).kinds);

const motherMovesIn: ShockSpec = {
  kind: 'custom',
  target: 'treatment',
  member: 'random',
  start_day: 60,
  end_day: 120,
  magnitude: 0,
  label: 'mother moves in',
  description: "His mother moves in for two months.",
  effects: [
    { channel: 'stress', op: 'add', amount: 0.4, cadence: 'daily', who: 'both' },
    { channel: 'onset_hazard', op: 'multiply', amount: 1.3, cadence: 'daily', who: 'both' },
    { channel: 'episode', op: 'add', amount: 0.3, cadence: 'weekly', who: 'member', class: 'conflict' },
  ],
};

describe('custom shock words', () => {
  it('reads each effect as a plain sentence with how much, how often, for whom and when', () => {
    const [stress, hazard, memory] = motherMovesIn.effects as EffectSpec[];
    expect(effectWords(stress, motherMovesIn)).toBe('Stress goes up 0.4 every day for both partners from day 60 to day 120.');
    expect(effectWords(hazard, motherMovesIn)).toBe('Fights start 1.3 times as often from day 60 to day 120.');
    expect(effectWords(memory, motherMovesIn)).toBe('One partner picked at random stores a hurtful memory of strength 0.3 every week from day 60 to day 120.');
  });

  it('names the other partner, signs, windows and every channel', () => {
    const s: ShockSpec = { ...motherMovesIn, member: 'a', end_day: null };
    const e = (over: Partial<EffectSpec>): EffectSpec => ({ channel: 'affect', op: 'add', amount: -0.05, cadence: 'daily', who: 'partner', ...over });
    expect(effectWords(e({}), s)).toBe('Mood goes down 0.05 every day for partner B from day 60 to the end of the run.');
    expect(effectWords(e({ channel: 'trust', amount: 0.2, cadence: 'once', who: 'member' }), s)).toBe('Trust goes up 0.2 for partner A on day 60.');
    expect(effectWords(e({ channel: 'trait', trait: 'conflict_engagement', amount: -0.2, cadence: 'yearly', who: 'both' }), s)).toContain('Conflict engagement goes down 0.2 every year for both partners');
    expect(effectWords(e({ channel: 'outside', amount: 0.25 }), s)).toContain('Partner B has a 0.25 chance each day of meeting someone attractive');
    expect(effectWords(e({ channel: 'repair_propensity', op: 'multiply', amount: 2 }), s)).toContain('Partner B has 2 times the usual odds of making up');
    expect(effectWords(e({ start_day: 70, end_day: 80 }), s)).toContain('from day 70 to day 80');
  });

  it('carries the label into every summary without needing a magnitude', () => {
    const words = shockWords(motherMovesIn, catalog);
    expect(words).toBe(
      'Mother moves in for every treatment couple from day 60 to day 120, so stress goes up 0.4 every day for both partners, fights start 1.3 times as often and one partner picked at random stores a hurtful memory of strength 0.3 every week.',
    );
    expect(words).not.toContain('magnitude');
    expect(shockBrief(motherMovesIn, catalog)).toBe('Mother moves in on day 60 (3 effects)');
    expect(shockShort(motherMovesIn, catalog)).toBe('mother moves in');
    const labels = armLabels({ parameter: 'none', control_value: null, treatment_value: null } as never, [motherMovesIn], catalog);
    expect(labels.control.plain).toBe('No mother moves in');
    expect(labels.treatment.plain).toBe('Mother moves in on day 60 (3 effects)');
    expect(labels.treatment.small).toContain('mother moves in day 60');
    expect(whatDiffers(interventionOf(null, [motherMovesIn]), catalog)).toBe(`Only a shock to the treatment arm. ${words} Memory is identical in both arms.`);
    // A custom shock both arms live through keeps its label's capital and reads as its own sentence.
    expect(whatDiffers(interventionOf(null, [{ ...motherMovesIn, target: 'all' }]), catalog)).toBe(
      'Nothing differs between the arms. Both arms live through the same shock. Mother moves in for every couple in town from day 60 to day 120, so stress goes up 0.4 every day for both partners, fights start 1.3 times as often and one partner picked at random stores a hurtful memory of strength 0.3 every week.',
    );
    // Effects with windows of their own each say theirs.
    const staggered: ShockSpec = { ...motherMovesIn, effects: [{ ...(motherMovesIn.effects as EffectSpec[])[0], start_day: 70, end_day: 90 }, (motherMovesIn.effects as EffectSpec[])[1]] };
    expect(shockWords(staggered, catalog)).toBe(
      'Mother moves in for every treatment couple, so stress goes up 0.4 every day for both partners from day 70 to day 90 and fights start 1.3 times as often from day 60 to day 120.',
    );
  });

  it('says a partner is picked at random before any effect names the other partner', () => {
    const [stress, hazard, memory] = motherMovesIn.effects as EffectSpec[];
    // One effect on one partner: the other partner of a random pick is a random pick too.
    expect(shockWords({ ...motherMovesIn, effects: [stress, hazard, { ...memory, who: 'partner' }] }, catalog)).toBe(
      'Mother moves in for every treatment couple from day 60 to day 120, so stress goes up 0.4 every day for both partners, fights start 1.3 times as often and one partner picked at random stores a hurtful memory of strength 0.3 every week.',
    );
    // More than one: the pick is said once, first, and the effects name the chosen partner and the other one.
    const both: ShockSpec = { ...motherMovesIn, effects: [{ ...memory, who: 'partner' }, { ...stress, who: 'member' }] };
    expect(shockWords(both, catalog)).toBe(
      'Mother moves in for every treatment couple from day 60 to day 120, with one partner in each couple picked at random, so the other partner stores a hurtful memory of strength 0.3 every week and stress goes up 0.4 every day for the chosen partner.',
    );
    // Partner A or B is named outright, with no pick to say.
    expect(shockWords({ ...both, member: 'a' }, catalog)).toBe(
      'Mother moves in for every treatment couple from day 60 to day 120, so partner B stores a hurtful memory of strength 0.3 every week and stress goes up 0.4 every day for partner A.',
    );
    // A sure meeting reads as one.
    expect(effectWords({ channel: 'outside', op: 'add', amount: 1, cadence: 'daily', who: 'both' }, motherMovesIn)).toBe('Both partners meet someone attractive every day from day 60 to day 120.');
  });

  it('names a partner a named kind picks, and keeps the job loss label as it read before', () => {
    const job: ShockSpec = { kind: 'job_loss', target: 'treatment', member: 'b', start_day: 60, end_day: 210, magnitude: 1.5, trait: null };
    expect(shockWords(job, catalog)).toBe('In every treatment couple, partner B loses their job on day 60, so their stress jumps by 1.5 that day and stays raised until day 210.');
    expect(shockBrief(job, catalog)).toBe('Partner B loses their job on day 60 (1.5 stress)');
    expect(shockBrief({ ...job, member: 'random' }, catalog)).toBe('One partner loses their job on day 60 (1.5 stress)');
  });
});

const effectCatalog = (shocksCatalog as unknown as { effects: EffectCatalog }).effects;

function customRow(over: Partial<ShockForm> = {}): ShockForm {
  return {
    id: 1,
    kind: 'custom',
    target: 'treatment',
    member: 'random',
    start_day: 30,
    end_day: 90,
    magnitude: 0,
    trait: null,
    label: 'mother moves in',
    description: 'His mother moves in.',
    effects: [{ channel: 'stress', op: 'add', amount: 0.3, cadence: 'daily', who: 'both' }],
    ...over,
  };
}

function formWith(shock: ShockForm): RunForm {
  return { name: 'custom-run', nCouples: 100, days: 365, treatmentHalfLife: 90, shocks: [shock], overwrite: false };
}

describe('custom shocks in the run form', () => {
  it('validates names, effect counts, amounts, cadences, targets and windows against the catalog', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    expect(validateRun(formWith(customRow()), kinds, effectCatalog)).toEqual([]);
    const errs = (over: Partial<ShockForm>) => validateRun(formWith(customRow(over)), kinds, effectCatalog).join(' ');
    expect(errs({ label: '<script>' })).toContain('the name must be');
    expect(errs({ effects: [] })).toContain('needs 1 to 8 effects');
    expect(errs({ effects: [{ channel: 'stress', op: 'add', amount: 2, cadence: 'daily', who: 'both' }] })).toContain('between -1.5 and 1.5');
    expect(errs({ effects: [{ channel: 'outside', op: 'add', amount: 0.2, cadence: 'weekly', who: 'both' }] })).toContain('cannot act weekly');
    expect(errs({ effects: [{ channel: 'onset_hazard', op: 'multiply', amount: 2, cadence: 'daily', who: 'member' }] })).toContain('hits both');
    expect(errs({ effects: [{ channel: 'episode', op: 'add', amount: 0.2, cadence: 'once', who: 'both' }] })).toContain('kind of memory');
    expect(errs({ effects: [{ channel: 'stress', op: 'add', amount: 0.2, cadence: 'once', who: 'both', start_day: 10 }] })).toContain("inside the shock's days");
    expect(errs({ effects: [{ channel: 'stress', op: 'multiply', amount: 0.3, cadence: 'daily', who: 'both' }] })).toContain('stress must use add, not multiply');
    expect(errs({ effects: [{ channel: 'onset_hazard', op: 'add', amount: 1.3, cadence: 'daily', who: 'both' }] })).toContain('onset_hazard must use multiply, not add');
  });

  it('refuses custom shocks when the server sends no effect catalog', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    expect(validateRun(formWith(customRow()), kinds, null).join(' ')).toContain('list of effect channels');
    expect(validateRun(formWith(customRow()), kinds).join(' ')).toContain('list of effect channels');
  });

  it('refuses two custom shocks whose names share a log name', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    expect(labelSlug("Mother's  move-in")).toBe('mother_s_move_in');
    const two = (a: string, b: string): RunForm => ({ ...formWith(customRow({ label: a })), shocks: [customRow({ label: a }), customRow({ id: 2, label: b })] });
    expect(validateRun(two('in-law move', 'in_law_move'), kinds, effectCatalog).join(' ')).toContain('the same as shock 1');
    expect(validateRun(two('mother moves in', 'father moves in'), kinds, effectCatalog)).toEqual([]);
  });

  it('refuses a fork whose new custom shock shares a log name with one the parent world already runs', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    const parentShocks: ShockSpec[] = [
      { kind: 'custom', target: 'all', member: 'random', start_day: 10, end_day: 40, magnitude: 0, label: "Mother's move-in", effects: [] },
      { kind: 'job_loss', target: 'treatment', member: 'a', start_day: 60, end_day: 180, magnitude: 1.5 },
    ];
    const form = formWith(customRow({ label: 'mother s move in' }));
    const forkRules = { fork: true, parentShocks };
    expect(validateRun(form, kinds, effectCatalog, forkRules).join(' ')).toContain('the parent world already runs');
    expect(validateRun(formWith(customRow({ label: 'father moves in' })), kinds, effectCatalog, forkRules)).toEqual([]);
    // A run that is not a fork keeps no parent shocks, so the same name is fine there.
    expect(validateRun(form, kinds, effectCatalog, { parentShocks })).toEqual([]);
  });

  it('sends a custom shock with its name and effects and no magnitude', () => {
    const kinds = (shocksCatalog as { kinds: ShockKind[] }).kinds;
    const req = buildRequest(formWith(customRow()), kinds);
    const shock = req.treatment.shocks?.[0];
    expect(shock).toMatchObject({ kind: 'custom', label: 'mother moves in', description: 'His mother moves in.', start_day: 30, end_day: 90 });
    expect(shock && 'magnitude' in shock).toBe(false);
    expect(shock?.effects?.[0]).toEqual({ channel: 'stress', op: 'add', amount: 0.3, cadence: 'daily', who: 'both' });
  });

  it('opens a translated custom shock as an editable effect list and records the edit', async () => {
    const spy = vi.spyOn(mock, 'runExperiment');
    render(
      <MemoryRouter initialEntries={['/new']}>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'New experiment' });
    fireEvent.change(screen.getByLabelText('Describe what happens'), { target: { value: 'His mother moves in for two months' } });
    fireEvent.click(screen.getByTestId('translate'));
    const card = await screen.findByTestId('translation-card');
    expect(within(card).getByTestId('translation-words')).toHaveTextContent('Mother moves in for every treatment couple from day 30 to day 90, so stress goes up 0.3 every day for both partners and fights start 1.4 times as often.');
    expect(within(card).getByTestId('translation-description')).toHaveTextContent('moves into the couple');
    const effects = screen.getAllByTestId('effect-row');
    expect(effects).toHaveLength(2);
    expect(within(effects[1]).getByTestId('effect-words')).toHaveTextContent('Fights start 1.4 times as often from day 30 to day 90.');
    expect(within(card).queryByTestId('translation-edited')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Effect 2 amount'), { target: { value: '1.8' } });
    expect(within(effects[1]).getByTestId('effect-words')).toHaveTextContent('Fights start 1.8 times as often');
    expect(within(card).getByTestId('translation-edited')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mother-run' } });
    fireEvent.click(screen.getByTestId('run'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0][0];
    expect(body.translations).toEqual([{ translation_id: 'tr-mother', shock_index: 0 }]);
    expect(body.treatment.shocks?.[0]).toMatchObject({ kind: 'custom', label: 'mother moves in' });
    expect(body.treatment.shocks?.[0].effects?.[1].amount).toBe(1.8);
    spy.mockRestore();
  });
});

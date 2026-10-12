// Tests for how the dashboard describes custom shocks, the shocks a model writes from plain words:
// every effect in plain words, the arm labels and the "what differs" sentence.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from './mockApi';
import App from '../App';
import { buildRequest } from '../pages/NewExperiment';
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
  it('reads each effect in plain words with whom, how much, how often and when', () => {
    const [stress, hazard, memory] = motherMovesIn.effects as EffectSpec[];
    expect(effectWords(stress, motherMovesIn)).toBe('both partners: stress up 0.4 every day, days 60 to 120');
    expect(effectWords(hazard, motherMovesIn)).toBe('both partners: fights start 1.3 times as often, days 60 to 120');
    expect(effectWords(memory, motherMovesIn)).toBe('a random partner: a hurtful memory of strength 0.3 every week, days 60 to 120');
  });

  it('names the other partner, signs, windows and every channel', () => {
    const s: ShockSpec = { ...motherMovesIn, member: 'a', end_day: null };
    const e = (over: Partial<EffectSpec>): EffectSpec => ({ channel: 'affect', op: 'add', amount: -0.05, cadence: 'daily', who: 'partner', ...over });
    expect(effectWords(e({}), s)).toBe('partner B: mood down 0.05 every day, from day 60 to the end of the run');
    expect(effectWords(e({ channel: 'trust', amount: 0.2, cadence: 'once', who: 'member' }), s)).toBe('partner A: trust up 0.2 once, on day 60');
    expect(effectWords(e({ channel: 'trait', trait: 'conflict_engagement', amount: -0.2, cadence: 'yearly', who: 'both' }), s)).toContain('conflict engagement down 0.2 every year');
    expect(effectWords(e({ channel: 'outside', amount: 0.25 }), s)).toContain('a 0.25 chance a day of meeting someone attractive');
    expect(effectWords(e({ channel: 'repair_propensity', op: 'multiply', amount: 2 }), s)).toContain('2 times the odds of making up');
    expect(effectWords(e({ start_day: 70, end_day: 80 }), s)).toContain('days 70 to 80');
  });

  it('carries the label into every summary without needing a magnitude', () => {
    const words = shockWords(motherMovesIn, catalog);
    expect(words.startsWith('Mother moves in (treatment arm): both partners: stress up 0.4 every day')).toBe(true);
    expect(words).not.toContain('magnitude');
    expect(shockBrief(motherMovesIn, catalog)).toBe('Mother moves in on day 60 (3 effects)');
    expect(shockShort(motherMovesIn, catalog)).toBe('mother moves in');
    const labels = armLabels({ parameter: 'none', control_value: null, treatment_value: null } as never, [motherMovesIn], catalog);
    expect(labels.control.plain).toBe('No mother moves in');
    expect(labels.treatment.plain).toBe('Mother moves in on day 60 (3 effects)');
    expect(labels.treatment.small).toContain('mother moves in day 60');
    expect(whatDiffers(interventionOf(null, [motherMovesIn]), catalog)).toContain('mother moves in (treatment arm): both partners: stress up 0.4 every day');
  });

  it('keeps named kinds exactly as they read before', () => {
    const job: ShockSpec = { kind: 'job_loss', target: 'treatment', member: 'b', start_day: 60, end_day: 210, magnitude: 1.5, trait: null };
    expect(shockWords(job, catalog)).toContain('magnitude 1.5');
    expect(shockBrief(job, catalog)).toBe('One partner loses their job on day 60 (1.5 stress)');
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
    expect(within(card).getByTestId('translation-words')).toHaveTextContent('Mother moves in (treatment arm): both partners: stress up 0.3 every day, days 30 to 90');
    expect(within(card).getByTestId('translation-description')).toHaveTextContent('moves into the couple');
    const effects = screen.getAllByTestId('effect-row');
    expect(effects).toHaveLength(2);
    expect(within(effects[1]).getByTestId('effect-words')).toHaveTextContent('both partners: fights start 1.4 times as often, days 30 to 90');
    expect(within(card).queryByTestId('translation-edited')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Effect 2 amount'), { target: { value: '1.8' } });
    expect(within(effects[1]).getByTestId('effect-words')).toHaveTextContent('fights start 1.8 times as often');
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

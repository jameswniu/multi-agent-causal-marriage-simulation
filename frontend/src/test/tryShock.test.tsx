// Tests for the read-only demo's "Try a shock" (components/TryShock.tsx) and its static build: one card per
// shock run in advance, saying what someone asked for, where the shock came from, the shock as it ran and
// which houses it hits; and picking one switches the World page to that world in place, replaying it from
// just before the shock with the couples that differ counted, exactly as a finished run does in the live app.
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from './mockApi';
import type { DemoCard } from '../staticApi';
import type { Outcome, ShockSpec } from '../types';
import experimentFixture from '../fixtures/experiment.json';

const JOB_LOSS = { kind: 'job_loss', target: 'treatment' as const, member: 'random' as const, start_day: 30, end_day: 50, magnitude: 1.5 };
const MOTHER: ShockSpec = {
  kind: 'custom',
  target: 'treatment',
  member: 'random',
  start_day: 40,
  end_day: 60,
  magnitude: 0,
  label: 'mother moves in',
  description: null,
  effects: [{ channel: 'stress', op: 'add', amount: 0.5, cadence: 'daily', who: 'both', start_day: 40, end_day: 60 }],
};
const DATE_NIGHTS: ShockSpec = { kind: 'date_nights', target: 'all', member: 'random', start_day: 12, end_day: null, magnitude: 1 };

const CARDS: DemoCard[] = [
  {
    name: 'demo-layoff',
    order: 2,
    title: 'One partner is laid off',
    words: 'One partner is laid off on day 30 and stays out of work for twenty days',
    typed: false,
    parent: 'retention-90d',
    hits: 'treatment',
    shocks: [JOB_LOSS],
    note: '',
    translation: { translation_id: 'b'.repeat(32), model: 'claude-haiku-5-5', recorded: '2026-10-11T20:28:58-07:00', rationale: 'A layoff.', words: 'One partner loses their job' },
  },
  {
    name: 'demo-mother-moves-in',
    order: 1,
    title: 'His mother moves in',
    words: 'His mother moves in for two months starting in month four',
    typed: true,
    parent: 'retention-90d',
    hits: 'treatment',
    shocks: [MOTHER],
    note: '',
    translation: { translation_id: 'a'.repeat(32), model: 'claude-haiku-5-5', recorded: '2026-10-12T01:33:33-07:00', rationale: 'A parent moving in.', words: 'Mother moves in' },
  },
  {
    name: 'demo-date-nights',
    order: 3,
    title: 'Weekly date nights for everyone',
    words: 'Every couple in town starts a weekly date night on day 12',
    typed: false,
    parent: 'retention-90d',
    hits: 'all',
    shocks: [DATE_NIGHTS],
    note: '',
    translation: null,
  },
];

function Probe() {
  const loc = useLocation();
  const state = loc.state as { replayFrom?: number } | null;
  return (
    <div data-testid="loc" data-replay={state?.replayFrom ?? ''}>
      {loc.pathname + loc.search}
    </div>
  );
}

/** Render the static build of the app: VITE_STATIC=1, the mock API (with any reads replaced) and the pre-run shocks above. */
async function staticApp(path: string, reads: Partial<typeof mock> = {}) {
  vi.stubEnv('VITE_STATIC', '1');
  vi.resetModules();
  vi.doMock('../api', () => ({ ...mock, ...reads }));
  vi.doMock('../staticApi', () => ({ demoCards: async () => [...CARDS].sort((a, b) => a.order - b.order) }));
  const { default: App } = await import('../App');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A ResizeObserver that reports a 390 by 700 phone screen as soon as it observes, for the town's district switch. */
class PhoneResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.cb([{ target, contentRect: { width: 390, height: 700 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * The app on a phone with WebGL, static or live, whose town renderer never finishes starting, so the district
 * switch above the town can be read before any camera moves.
 */
async function phoneApp(path: string, isStatic: boolean) {
  if (isStatic) vi.stubEnv('VITE_STATIC', '1');
  vi.resetModules();
  vi.doMock('../api', () => mock);
  vi.doMock('../staticApi', () => ({ demoCards: async () => [...CARDS].sort((a, b) => a.order - b.order) }));
  vi.doMock('../town/webgl', () => ({ supportsWebGL: () => true }));
  vi.doMock('pixi.js', () => ({
    Application: class {
      init(): Promise<void> {
        return new Promise<void>(() => {});
      }
      destroy(): void {}
    },
  }));
  vi.stubGlobal('ResizeObserver', PhoneResizeObserver);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(390);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(700);
  const { default: App } = await import('../App');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The district the phone's switch has pressed, by its place in the switch: control, the plaza, then treatment. */
async function pressedDistrict(): Promise<string> {
  const group = await screen.findByRole('group', { name: 'District' });
  const buttons = within(group).getAllByRole('button');
  expect(buttons).toHaveLength(3);
  const pressed = buttons.flatMap((b, i) => (b.getAttribute('aria-pressed') === 'true' ? [['control', 'plaza', 'treatment'][i]] : []));
  expect(pressed).toHaveLength(1);
  return pressed[0];
}

const dayShown = () => Number(/Day (\d+)/.exec(screen.getByTestId('day-label').textContent ?? '')?.[1] ?? -1);

beforeEach(() => {
  mock.resetMockState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('../api');
  vi.doUnmock('../staticApi');
  vi.doUnmock('../town/webgl');
  vi.doUnmock('pixi.js');
  vi.resetModules();
});

describe('the words on a card', () => {
  it('says where each shock came from, and which houses it hits', async () => {
    const { hitsWords, recordedDate, sourceWords } = await import('../components/TryShock');
    expect(recordedDate('2026-10-12T01:33:33-07:00')).toBe('12 October 2026');
    expect(sourceWords(CARDS[1], null)).toBe('Typed into the shock box and turned into this shock by claude-haiku-5-5 on 12 October 2026.');
    expect(sourceWords(CARDS[0], null)).toBe('Turned into this shock by claude-haiku-5-5 on 11 October 2026. Only a fingerprint of the words typed was kept, so the sentence above was written for this demo.');
    expect(sourceWords(CARDS[2], { date_nights: { label: 'Date nights' } } as never)).toBe("Built by hand from the catalog's date nights kind, with no model.");
    expect(hitsWords(CARDS[0])).toBe('The treatment arm only: the district on the right, or its tab on a phone.');
    expect(hitsWords(CARDS[2])).toBe('Every house: both arms, and the couples who remarry during the year.');
  });
});

describe('Try a shock in the static build', () => {
  it('shows the banner on every page and no way to start a run', async () => {
    await staticApp('/overview?experiment=retention-90d');
    const banner = await screen.findByTestId('static-banner');
    // It says what LoveWorld is before what the site cannot do.
    expect(banner.textContent).toMatch(/^LoveWorld runs 1,000 agent couples for one year as a randomized trial of one setting, how long each partner remembers a fight\. This read-only demo replays that run/);
    expect(within(screen.getByTestId('static-banner')).getByRole('link', { name: 'README quickstart' })).toHaveAttribute('href', 'https://github.com/jameswniu/multi-agent-causal-marriage-simulation#run-it');
    expect(screen.queryByRole('link', { name: 'New experiment' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Couples' }));
    expect(await screen.findByTestId('static-banner')).toBeInTheDocument();
  });

  it('replaces the New experiment page with one line', async () => {
    await staticApp('/new?experiment=retention-90d');
    const note = await screen.findByTestId('static-new-note');
    expect(note).toHaveTextContent('New experiments need the simulator, which this read-only demo leaves out');
    expect(screen.queryByLabelText('Describe what happens')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run')).not.toBeInTheDocument();
  });

  it('lists the shocks run in advance, one card each, in their order', async () => {
    await staticApp('/world?experiment=retention-90d');
    expect(screen.queryByTestId('shock-this-world')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Try a shock' }));
    const panel = await screen.findByTestId('try-shock');
    const cards = await within(panel).findAllByRole('article');
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual(['His mother moves in', 'One partner is laid off', 'Weekly date nights for everyone']);
    const mother = within(panel).getByTestId('demo-card-demo-mother-moves-in');
    expect(mother).toHaveTextContent('“His mother moves in for two months starting in month four”');
    expect(mother).toHaveTextContent('Typed into the shock box and turned into this shock by claude-haiku-5-5 on 12 October 2026.');
    expect(mother).toHaveTextContent('Ran as: Mother moves in (treatment arm): both partners: stress up 0.5 every day, days 40 to 60');
    expect(mother).toHaveTextContent('Hits: The treatment arm only: the district on the right, or its tab on a phone.');
    const layoff = within(panel).getByTestId('demo-card-demo-layoff');
    expect(layoff).not.toHaveTextContent('“');
    expect(layoff).toHaveTextContent('One partner loses their job (a random partner, treatment arm), days 30 to 50');
    const dates = within(panel).getByTestId('demo-card-demo-date-nights');
    expect(dates).toHaveTextContent('with no model');
    expect(dates).toHaveTextContent('Hits: Every house: both arms');
    expect(panel).toHaveTextContent('README quickstart');
    // Nothing in the panel can type or run a shock.
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('run')).not.toBeInTheDocument();
  });

  it('switches the page to the shocked world in place and replays it from just before the shock, counting what differs', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-layoff', shocks: [JOB_LOSS] });
    await staticApp('/world?experiment=retention-90d');
    fireEvent.click(await screen.findByRole('button', { name: 'Try a shock' }));
    fireEvent.click(await screen.findByTestId('pick-demo-layoff'));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/world?experiment=demo-layoff'));
    // Ten days of lead-in before the layoff's first day, 30, as a finished run opens in the live app.
    expect(screen.getByTestId('loc')).toHaveAttribute('data-replay', '20');
    expect(await screen.findByRole('heading', { name: 'World replay' })).toBeInTheDocument();
    await waitFor(() => expect((screen.getByTestId('experiment-select') as HTMLSelectElement).value).toBe('demo-layoff'));
    expect(screen.queryByTestId('try-shock')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Pause' });
    expect(dayShown()).toBeGreaterThanOrEqual(20);
    expect((screen.getByLabelText('Speed in days per second') as HTMLSelectElement).value).toBe('10');
    const count = await screen.findByTestId('differ-count');
    await waitFor(() => expect(count).toHaveTextContent('2 of 6 couples differ from retention-90d today.'), { timeout: 8000 });
  });

  it('replays the world being watched from its card, and offers the way back to the example town', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-layoff', shocks: [JOB_LOSS] });
    await staticApp('/world?experiment=demo-layoff');
    fireEvent.click(await screen.findByRole('button', { name: 'Try a shock' }));
    const panel = await screen.findByTestId('try-shock');
    const card = await within(panel).findByTestId('demo-card-demo-layoff');
    expect(card).toHaveTextContent('You are watching this world.');
    fireEvent.click(within(card).getByRole('button', { name: 'Replay this world' }));
    await screen.findByRole('button', { name: 'Pause' });
    expect(screen.queryByTestId('try-shock')).not.toBeInTheDocument();
    expect(dayShown()).toBeGreaterThanOrEqual(20);
    expect(screen.getByTestId('loc')).toHaveTextContent('/world?experiment=demo-layoff');
    fireEvent.click(await screen.findByRole('button', { name: 'Try a shock' }));
    fireEvent.click(await screen.findByTestId('back-to-parent'));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/world?experiment=retention-90d'));
  });
});

describe('the town on a phone', () => {
  it('opens a shock that reaches only the treatment arm on the treatment district, where every ring is', async () => {
    const { phoneDistrictFor } = await import('../pages/World');
    const record = (shocks: ShockSpec[]) => ({
      parent: 'retention-90d',
      parent_determinism_hash: 'h',
      parent_engine_version: 'v',
      appended_shocks: shocks,
      comparison: { comparable: false as const, reason: 'not compared in this test' },
    });
    expect(phoneDistrictFor(record([JOB_LOSS]))).toBe('treatment');
    expect(phoneDistrictFor(record([MOTHER, JOB_LOSS]))).toBe('treatment');
    expect(phoneDistrictFor(record([DATE_NIGHTS]))).toBe('control');
    expect(phoneDistrictFor(record([JOB_LOSS, DATE_NIGHTS]))).toBe('control');
    expect(phoneDistrictFor(record([]))).toBe('control');
    expect(phoneDistrictFor(null)).toBe('control');
  });

  it('presses the treatment tab for the layoff in the static build, and control for the example town', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-layoff', shocks: [JOB_LOSS] });
    const first = await phoneApp('/world?experiment=demo-layoff', true);
    expect(await pressedDistrict()).toBe('treatment');
    first.unmount();
    await phoneApp('/world?experiment=retention-90d', true);
    expect(await pressedDistrict()).toBe('control');
  });

  it('presses control for date nights, which reaches both arms', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-date-nights', shocks: [{ ...DATE_NIGHTS, target: 'all' }] });
    await phoneApp('/world?experiment=demo-date-nights', true);
    expect(await pressedDistrict()).toBe('control');
  });

  it('keeps the live app opening every world on control', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-layoff', shocks: [JOB_LOSS] });
    await phoneApp('/world?experiment=demo-layoff', false);
    expect(await pressedDistrict()).toBe('control');
  });
});

describe('a shock run in advance on everyone', () => {
  const words = 'Every couple in town starts a weekly date night on day 12';
  const memory = { parameter: 'conflict_half_life_days', control_value: 14, treatment_value: 90 };

  it("is said in its card's plain sentence when the demo gives one, and in the shock's own words otherwise", async () => {
    const { interventionOf, sharedClause, whatDiffers } = await import('../arms');
    const { framingSentence } = await import('../pages/World');
    const both = interventionOf(memory, [DATE_NIGHTS]);
    expect(whatDiffers(both, null, words)).toBe(`Only how long a fight stays in memory, 14 days versus 90. ${words}.`);
    expect(whatDiffers(both, null)).toMatch(/\. Everyone also lives through date nights/);
    const onlyEveryone = interventionOf(null, [DATE_NIGHTS]);
    expect(whatDiffers(onlyEveryone, null, words)).toBe(`Nothing differs between the arms. ${words}.`);
    expect(sharedClause(onlyEveryone, null, words)).toBe('every couple in town starts a weekly date night on day 12');
    expect(sharedClause(onlyEveryone, null)).toMatch(/^everyone lived through date nights/);
    expect(framingSentence(1000, both, null, 'randomized', 'districts', words)).toBe(
      `Both districts start from the same 1,000 couples on the same day. On the left a fight fades from memory in 14 days. On the right it lingers for 90. Nothing else differs. ${words}.`,
    );
    expect(framingSentence(1000, both, null, 'randomized', 'districts')).toMatch(/Nothing else differs\. Everyone lived through date nights/);
  });

  it('reads as that sentence on the World page and the Overview of the static build', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-date-nights', shocks: [{ ...DATE_NIGHTS, target: 'all' }] });
    // The server lists the fork's shock in its summary; the mock reuses the parent's, so add it here.
    const getExperiment: typeof mock.getExperiment = async () => {
      const base = await mock.getExperiment();
      return base.summary ? { ...base, summary: { ...base.summary, experiment: { ...base.summary.experiment, shocks: [DATE_NIGHTS] } } } : base;
    };
    const { unmount } = await staticApp('/world?experiment=demo-date-nights', { getExperiment });
    await waitFor(() => expect(screen.getByTestId('framing')).toHaveTextContent(`Nothing else differs. ${words}.`));
    expect(screen.getByTestId('framing')).not.toHaveTextContent('lived through');
    unmount();
    await staticApp('/overview?experiment=demo-date-nights', { getExperiment });
    await waitFor(() => expect(screen.getByText(`Only how long a fight stays in memory, 14 days versus 90. ${words}.`)).toBeInTheDocument());
  });

  it('reads as that sentence after picking the card on the example town, since every page loads again for the world picked', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-date-nights', shocks: [{ ...DATE_NIGHTS, target: 'all' }] });
    // Only the fork lists the date nights shock, as the server's summary of each world does.
    const getExperiment: typeof mock.getExperiment = async () => {
      const base = await mock.getExperiment();
      return base.parent && base.summary ? { ...base, summary: { ...base.summary, experiment: { ...base.summary.experiment, shocks: [DATE_NIGHTS] } } } : base;
    };
    await staticApp('/world?experiment=retention-90d', { getExperiment });
    await waitFor(() => expect(screen.getByTestId('framing')).toHaveTextContent('Nothing else differs.'));
    expect(screen.getByTestId('framing')).not.toHaveTextContent(words);
    fireEvent.click(await screen.findByRole('button', { name: 'Try a shock' }));
    fireEvent.click(await screen.findByTestId('pick-demo-date-nights'));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/world?experiment=demo-date-nights'));
    await waitFor(() => expect(screen.getByTestId('framing')).toHaveTextContent(`Nothing else differs. ${words}.`));
    expect(screen.getByTestId('framing')).not.toHaveTextContent('lived through');
  });
});

describe('the other pages of the static build', () => {
  it("heads the Overview with the name the world is listed under, and the run's own name beside it when they differ", async () => {
    const { listedHeading } = await import('../pages/Overview');
    expect(listedHeading('retention-90d', 'example')).toBe('example (run name retention-90d)');
    expect(listedHeading('demo-layoff', 'demo-layoff')).toBe('demo-layoff');
    expect(listedHeading('retention-90d', null)).toBe('retention-90d');
    // The static build heads the page that way: here a world listed as example whose run is named retention-90d.
    await mock.forkExperiment({ parent: 'retention-90d', name: 'example', shocks: [] });
    const getExperiment: typeof mock.getExperiment = async () => {
      const base = await mock.getExperiment();
      return { ...base, manifest: { ...base.manifest, name: 'retention-90d' }, parent: null };
    };
    await staticApp('/overview?experiment=example', { getExperiment });
    expect(await screen.findByRole('heading', { level: 1, name: 'example (run name retention-90d)' })).toBeInTheDocument();
  });

  it("points a shocked world's Governance page to the placebo of the world it was forked from", async () => {
    await mock.forkExperiment({ parent: 'retention-90d', name: 'demo-layoff', shocks: [JOB_LOSS] });
    const getExperiment: typeof mock.getExperiment = async () => {
      const base = await mock.getExperiment();
      return base.summary ? { ...base, summary: { ...base.summary, governance: { ...base.summary.governance, placebo: null } } } : base;
    };
    await staticApp('/governance?experiment=demo-layoff', { getExperiment });
    const note = await screen.findByTestId('placebo-in-parent');
    expect(note).toHaveTextContent('This world was run without a placebo of its own. The placebo for these same couples is on the Governance page of retention-90d, the world it was forked from.');
    expect(within(note).getByRole('link')).toHaveAttribute('href', '/governance?experiment=retention-90d');
    expect(screen.queryByText(/loveworld placebo/)).not.toBeInTheDocument();
  });
});

describe('the charts', () => {
  const outcomes = (experimentFixture as { summary: { outcomes: Outcome[] } }).summary.outcomes;
  const effectXs = () =>
    [...document.querySelectorAll('svg text')].filter((t) => /^[+-]?\d/.test(t.textContent ?? '')).map((t) => Number(t.getAttribute('x')));

  it("write their words at 16px in the static build, and keep the forest plot's effects inside a phone's width", async () => {
    vi.stubEnv('VITE_STATIC', '1');
    vi.resetModules();
    const { CHART_TEXT_PX } = await import('../chartText');
    const { default: ForestPlot } = await import('../components/ForestPlot');
    expect(CHART_TEXT_PX).toBe(16);
    render(<ForestPlot outcomes={outcomes} width={320} />);
    expect([...document.querySelectorAll('svg text')].every((t) => t.getAttribute('font-size') === '16')).toBe(true);
    // 103px of the 320 are kept for each effect, such as +76.8%, right of its interval.
    expect(Math.max(...effectXs())).toBe(320 - 103 + 8);
  });

  it("keep the live app's 14px words and layout", async () => {
    vi.resetModules();
    const { CHART_TEXT_PX } = await import('../chartText');
    const { default: ForestPlot } = await import('../components/ForestPlot');
    expect(CHART_TEXT_PX).toBe(14);
    render(<ForestPlot outcomes={outcomes} width={320} />);
    expect([...document.querySelectorAll('svg text')].every((t) => t.getAttribute('font-size') === '14')).toBe(true);
    // A 160px label column, a 120px plot, then the effect, as before.
    expect(Math.max(...effectXs())).toBe(160 + 120 + 8);
  });
});

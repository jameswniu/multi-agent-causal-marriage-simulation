// Tests for shocking a world in place on the World page, and for what the new world then shows. The
// panel forks the world being watched through a mocked fork and job, the page switches to the child
// world and replays it, and the child is compared with its parent day by day.
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from './mockApi';
import App from '../App';
import { jobPolling } from '../jobs';
import type { ExperimentResponse, Outcome, TwinsRun, TwinsWorldResponse } from '../types';
import { DIFF_RING_CSS, DIFF_RING_PX, RING_WORDS } from '../worldDiff';
import { strokesOn } from './setup';

vi.mock('../api', () => import('./mockApi'));

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );
}

const MOTHER = 'His mother moves in for two months starting in month four';
const dayShown = () => Number(/Day (\d+)/.exec(screen.getByTestId('day-label').textContent ?? '')?.[1] ?? -1);
const JOB_LOSS = { kind: 'job_loss', target: 'treatment' as const, member: 'random' as const, start_day: 30, end_day: 50, magnitude: 1.5 };

/** Where a grid draws its rings in the frame it shows now, as positions in the grid's own order (12 px tiles 2 px apart, one row here). */
function ringedTiles(testId: string): number[] {
  const rings = strokesOn(screen.getByTestId(testId) as HTMLCanvasElement).filter((s) => s.style === DIFF_RING_CSS);
  return rings.map((s) => Math.round((s.x - s.width / 2) / 14)).sort((a, b) => a - b);
}

beforeEach(() => {
  mock.resetMockState();
});

describe('shocking a world in place', () => {
  it('runs the shock from the World page, shows the run waiting and running inline, then switches to the child world and replays it', async () => {
    const saved = { ...jobPolling };
    jobPolling.pollMs = 5;
    const realFork = mock.forkExperiment;
    const realJob = mock.getJob;
    // The fork lands in the mock at once, but the page is told it is queued, then running, then done.
    const fork = vi.spyOn(mock, 'forkExperiment').mockImplementation(async (body) => ({ ...(await realFork(body)), state: 'queued', position: 1, finished: null }));
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const job = vi
      .spyOn(mock, 'getJob')
      .mockImplementationOnce(async (id) => ({ ...(await realJob(id)), state: 'running', finished: null }))
      .mockImplementationOnce(async (id) => {
        await gate;
        return realJob(id);
      });
    at('/world?experiment=retention-90d');
    fireEvent.click(await screen.findByTestId('shock-this-world'));
    const panel = await screen.findByTestId('shock-panel');
    const box = await within(panel).findByLabelText('Describe what happens');
    // Nothing described yet: the same validation as the New experiment page stops the run.
    fireEvent.click(within(panel).getByTestId('run'));
    expect(await within(panel).findByTestId('validation-errors')).toHaveTextContent('Add at least one shock');
    expect(fork).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: MOTHER } });
    fireEvent.click(within(panel).getByTestId('translate'));
    const card = await within(panel).findByTestId('translation-card');
    expect(card).toHaveTextContent(`From your words: "${MOTHER}"`);
    expect(within(card).getByTestId('translation-words')).toHaveTextContent('Mother moves in (treatment arm)');
    fireEvent.click(within(panel).getByTestId('run'));
    await waitFor(() => expect(within(panel).getByTestId('progress')).toHaveTextContent('Waiting its turn, number 1 in line'));
    await waitFor(() => expect(within(panel).getByTestId('progress')).toHaveTextContent('Running the engine'));
    // Still the parent's World page while the run is going.
    expect(screen.getByTestId('loc')).toHaveTextContent('/world?experiment=retention-90d');
    finish();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/world?experiment=retention-90d-fork'));
    // The fork is of the world being watched, carries only the shock, and leaves the name to the server.
    expect(fork).toHaveBeenCalledTimes(1);
    const body = fork.mock.calls[0][0];
    expect(body.parent).toBe('retention-90d');
    expect('name' in body).toBe(false);
    expect(body.shocks).toHaveLength(1);
    expect(body.shocks[0]).toMatchObject({ kind: 'custom', target: 'treatment', label: 'mother moves in', start_day: 30 });
    expect(body.translations).toEqual([{ translation_id: 'tr-mother', shock_index: 0 }]);
    // The same page, now on the child world: the panel is gone and the experiment in the bar is the child.
    expect(await screen.findByRole('heading', { name: 'World replay' })).toBeInTheDocument();
    await waitFor(() => expect((screen.getByTestId('experiment-select') as HTMLSelectElement).value).toBe('retention-90d-fork'));
    expect(screen.queryByTestId('shock-panel')).not.toBeInTheDocument();
    // It replays from ten days before the shock's first day (30) at ten days a second.
    await screen.findByRole('button', { name: 'Pause' });
    expect(dayShown()).toBeGreaterThanOrEqual(20);
    expect((screen.getByLabelText('Speed in days per second') as HTMLSelectElement).value).toBe('10');
    Object.assign(jobPolling, saved);
    fork.mockRestore();
    job.mockRestore();
  });

  it('counts the couples that differ from the parent each day, flips the picture to the parent on the same day, and links the table', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', shocks: [{ kind: 'job_loss', target: 'treatment', member: 'random', start_day: 30, end_day: 50, magnitude: 1.5 }] });
    at('/world?experiment=retention-90d-fork');
    const compare = await screen.findByTestId('compare');
    expect(compare).toHaveTextContent('Compared with the world it came from');
    const count = await within(compare).findByTestId('differ-count');
    // Before the fork's worlds part ways nothing differs, and from that day on two couples do.
    expect(count).toHaveTextContent('0 of 6 couples differ from retention-90d today.');
    const slider = screen.getByLabelText('Day');
    fireEvent.change(slider, { target: { value: String(mock.FORK_DIVERGES_FROM_DAY - 1) } });
    expect(count).toHaveTextContent('0 of 6 couples differ from retention-90d today.');
    fireEvent.change(slider, { target: { value: String(mock.FORK_DIVERGES_FROM_DAY) } });
    expect(count).toHaveTextContent('2 of 6 couples differ from retention-90d today.');
    fireEvent.change(slider, { target: { value: '40' } });
    expect(count).toHaveTextContent('2 of 6 couples differ from retention-90d today.');
    // Couple 1 is the first treatment tile: in a fight in this world on day 40, married in the parent.
    const grid = screen.getByTestId('grid-treatment');
    fireEvent.focus(grid);
    expect(screen.getByTestId('grid-treatment-live')).toHaveTextContent('Couple 1: married, in conflict.');
    const shows = within(compare).getByRole('group', { name: 'The town shows' });
    expect(within(shows).getByRole('button', { name: 'This world' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(shows).getByRole('button', { name: 'retention-90d' }));
    expect(within(shows).getByRole('button', { name: 'retention-90d' })).toHaveAttribute('aria-pressed', 'true');
    expect(compare).toHaveTextContent('The town now shows retention-90d on day 40. The scoreboard, the counts and the events on this page stay with this world.');
    // The counts and the events under the town say whose they are while the town shows the parent.
    expect(screen.getByRole('heading', { name: 'Counts on day 40 in this world' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Events on day 40 in this world' })).toBeInTheDocument();
    fireEvent.focus(screen.getByTestId('grid-treatment'));
    expect(screen.getByTestId('grid-treatment-live')).toHaveTextContent('Couple 1: married.');
    // The same couples differ whichever of the two worlds is drawn, and the day did not move.
    expect(count).toHaveTextContent('2 of 6 couples differ from retention-90d today.');
    expect(dayShown()).toBe(40);
    fireEvent.click(within(shows).getByRole('button', { name: 'This world' }));
    expect(compare).not.toHaveTextContent('The town now shows');
    expect(screen.getByRole('heading', { name: 'Events on day 40' })).toBeInTheDocument();
    fireEvent.click(within(compare).getByRole('link', { name: 'Overview, under Versus its parent' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/overview?experiment=retention-90d-fork'));
    expect(await screen.findByTestId('versus-parent')).toHaveTextContent('Forked from retention-90d');
  });

  it('rings the grid tiles of the couples that differ, in the town ring colour, whichever world the grid draws', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', shocks: [JOB_LOSS] });
    at('/world?experiment=retention-90d-fork');
    const count = await screen.findByTestId('differ-count');
    const slider = screen.getByLabelText('Day');
    fireEvent.change(slider, { target: { value: String(mock.FORK_DIVERGES_FROM_DAY - 1) } });
    expect(count).toHaveTextContent('0 of 6 couples differ from retention-90d today.');
    for (const grid of ['grid-control', 'grid-treatment', 'grid-remarriage']) expect(ringedTiles(grid)).toEqual([]);
    fireEvent.change(slider, { target: { value: '40' } });
    expect(count).toHaveTextContent('2 of 6 couples differ from retention-90d today.');
    // The fixture alternates arms: couple 1 is the first treatment tile and couple 2 the second control tile.
    expect(ringedTiles('grid-treatment')).toEqual([0]);
    expect(ringedTiles('grid-control')).toEqual([1]);
    expect(ringedTiles('grid-remarriage')).toEqual([]);
    // The ring sits inside its tile, three pixels wide, as the town draws it around a house.
    const [ring] = strokesOn(screen.getByTestId('grid-treatment') as HTMLCanvasElement).filter((s) => s.style === DIFF_RING_CSS);
    expect(ring).toEqual({ style: DIFF_RING_CSS, width: DIFF_RING_PX, x: 1.5, y: 1.5, w: 9, h: 9 });
    expect(screen.getByTestId('ring-key')).toHaveTextContent(RING_WORDS);
    expect(screen.getByTestId('compare')).toHaveTextContent('A ring marks each tile whose couple is in a different state today than the same couple in retention-90d.');
    fireEvent.focus(screen.getByTestId('grid-treatment'));
    expect(screen.getByTestId('grid-treatment-live')).toHaveTextContent(`Couple 1: married, in conflict. ${RING_WORDS}.`);
    fireEvent.focus(screen.getByTestId('grid-control'));
    expect(screen.getByTestId('grid-control-live')).toHaveTextContent('Couple 0: married.');
    expect(screen.getByTestId('grid-control-live')).not.toHaveTextContent('Ringed');
    // Drawn as the parent on the same day, the grid rings the very same couples.
    fireEvent.click(within(screen.getByRole('group', { name: 'The town shows' })).getByRole('button', { name: 'retention-90d' }));
    expect(ringedTiles('grid-treatment')).toEqual([0]);
    expect(ringedTiles('grid-control')).toEqual([1]);
  });

  it('shows no comparison and no rings on a world that is not a fork', async () => {
    at('/world?experiment=retention-90d');
    await screen.findByRole('heading', { name: 'World replay' });
    await screen.findByTestId('grid-control');
    expect(screen.queryByTestId('compare')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '40' } });
    expect(ringedTiles('grid-control')).toEqual([]);
    expect(ringedTiles('grid-treatment')).toEqual([]);
    expect(screen.queryByTestId('ring-key')).not.toBeInTheDocument();
  });

  it('says so when the parent world cannot be loaded, and still shows the child', async () => {
    await mock.forkExperiment({ parent: 'retention-90d', shocks: [{ kind: 'job_loss', target: 'treatment', member: 'random', start_day: 30, end_day: 50, magnitude: 1.5 }] });
    const real = mock.getWorld;
    const world = vi.spyOn(mock, 'getWorld').mockImplementation(async (experiment?: string) => {
      if (experiment === 'retention-90d') throw new Error('404 unknown experiment');
      return real(experiment);
    });
    at('/world?experiment=retention-90d-fork');
    const compare = await screen.findByTestId('compare');
    await waitFor(() => expect(compare).toHaveTextContent('Could not load retention-90d to compare: 404 unknown experiment'));
    expect(within(compare).queryByTestId('differ-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('grid-control')).toBeInTheDocument();
    world.mockRestore();
  });
});

describe('a run with no intervention', () => {
  const divorce: Partial<Outcome> = { ate: -0.012, ci_low: -0.03, ci_high: 0.006, ci_level: 0.95, control_mean: 0.026, treatment_mean: 0.014 };
  const names = ['divorce_rate', 'separation_rate', 'days_married', 'final_trust', 'mean_trust', 'conflict_rate'];
  /** The twins block a run's summary links when its twins ran the same couples under both settings. */
  const sameTwins: TwinsRun = {
    path: 'same-twins',
    paired: names.map((name) => ({ name, mean_diff: 0, ci_low: 0, ci_high: 0, n_pairs: 1000, share_changed: 0 })),
    identical_parameters: true,
    dynamics_hashes_equal: true,
  };

  async function noInterventionRun(gap: Partial<Outcome> = divorce, twins: TwinsRun | null = null) {
    const base = await mock.getExperiment();
    const summary = base.summary!;
    const same: ExperimentResponse = {
      ...base,
      summary: {
        ...summary,
        experiment: { ...summary.experiment, treatment: { parameter: 'none', control_value: null, treatment_value: null }, shocks: [] },
        outcomes: summary.outcomes.map((o) => (o.name === 'divorce_rate' ? { ...o, ...gap } : o)),
        governance: { ...summary.governance, twins },
      },
    };
    return vi.spyOn(mock, 'getExperiment').mockResolvedValue(same);
  }

  it('leads the World page with its twins giving identical results, then the gap between its two halves and its range', async () => {
    const spy = await noInterventionRun(divorce, sameTwins);
    at('/world');
    const box = await screen.findByTestId('null-run');
    expect(box.querySelector('.takeaway-lead')).toHaveTextContent('Run on the same 1,000 couples, the two settings give identical results, and 0 of 1,000 couples end differently.');
    expect(box.querySelector('.takeaway-detail')).toHaveTextContent(
      'The two halves of the town are different couples, and two different groups never come out exactly even. Their divorce gap, treatment minus control, is -1.2 points, with a 95% range of -3.0 to +0.6, which includes zero.',
    );
    // It stays through the end of the replay, in place of a takeaway that would name a difference.
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '59' } });
    await waitFor(() => expect(screen.getByTestId('day-label')).toHaveTextContent('Day 59'));
    expect(screen.getByTestId('null-run')).toBeInTheDocument();
    expect(screen.queryByTestId('takeaway')).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('without twins, says both halves follow identical rules, with the gap, its range and whether it includes zero', async () => {
    const spy = await noInterventionRun();
    at('/world');
    const box = await screen.findByTestId('null-run');
    expect(box.querySelector('.takeaway-lead')).toHaveTextContent('Both halves follow identical rules, so the gap between them comes only from splitting 6 different couples in two.');
    expect(box.querySelector('.takeaway-detail')).toHaveTextContent('The divorce gap, treatment minus control, is -1.2 points, with a 95% range of -3.0 to +0.6, which includes zero.');
    spy.mockRestore();
  });

  it('leads the Overview with the same words, and says when the range does not include zero', async () => {
    const spy = await noInterventionRun({ ate: 0.021, ci_low: 0.003, ci_high: 0.039, ci_level: 0.95 }, sameTwins);
    at('/overview');
    const head = await screen.findByTestId('chance-headline');
    expect(head.querySelector('.takeaway-lead')).toHaveTextContent('Run on the same 1,000 couples, the two settings give identical results, and 0 of 1,000 couples end differently.');
    expect(head.querySelector('.takeaway-detail')).toHaveTextContent('is +2.1 points, with a 95% range of +0.3 to +3.9, which does not include zero.');
    expect(head).toHaveTextContent('by chance in about one run in 20');
    spy.mockRestore();
  });

  it('keeps those words off a run that does have an intervention', async () => {
    at('/world');
    await screen.findByTestId('grid-control');
    expect(screen.queryByTestId('null-run')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '59' } });
    expect(await screen.findByTestId('takeaway')).toHaveTextContent('The only difference was how long a fight stayed in memory.');
  });

  it('shows exactly 0 of 1,000 couples differing in the same couples view, since every couple lives the same rules twice', async () => {
    const spy = await noInterventionRun(divorce, sameTwins);
    const n = 1000;
    const row = 'M'.repeat(n);
    const counts = { married: n, conflict: 0, separated: 0, divorced: 0 };
    const twins: TwinsWorldResponse = {
      available: true,
      days: 3,
      couples: Array.from({ length: n }, (_, i) => i),
      states_control: [row, row, row],
      states_treatment: [row, row, row],
      diverged: [0, 0, 0],
      counts_control: [counts, counts, counts],
      counts_treatment: [counts, counts, counts],
      paired: [],
    };
    const twinsSpy = vi.spyOn(mock, 'getTwinsWorld').mockResolvedValue(twins);
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    const button = screen.getByRole('button', { name: 'Same couples, both arms' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId('diverged')).toHaveTextContent('Couples whose fate differs today, 0 of 1,000');
    for (const day of ['1', '2']) {
      fireEvent.change(screen.getByLabelText('Day'), { target: { value: day } });
      expect(screen.getByTestId('diverged')).toHaveTextContent('Couples whose fate differs today, 0 of 1,000');
    }
    twinsSpy.mockRestore();
    spy.mockRestore();
  });
});

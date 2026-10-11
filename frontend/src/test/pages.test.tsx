import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasStats, resetCanvasStats } from './setup';
import * as mock from './mockApi';
import App from '../App';
import { BANNER_TEXT } from '../components/Banner';

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

beforeEach(() => {
  resetCanvasStats();
  mock.resetMockState();
});

describe('pages', () => {
  it('Overview shows the banner, the experiment name and every outcome', async () => {
    at('/overview');
    expect(await screen.findByText(BANNER_TEXT)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'retention-90d' })).toBeInTheDocument();
    expect(screen.getByText('Only how long a fight stays in memory, 14 days versus 90')).toBeInTheDocument();
    expect(screen.getAllByText('Forgets fights in 2 weeks').length).toBeGreaterThan(0);
    for (const label of ['Divorced within the year', 'Trust on the last day', 'Conflicts per couple-year', 'Days to reconciliation', 'Divorced agents who remarried']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('Conditional').length).toBe(4);
    expect(screen.getAllByTestId('forest-row').length).toBe(10);
  });

  it('Comparisons renders every chart title', async () => {
    at('/comparisons');
    for (const t of ['Marriages surviving', 'Trust over the year', 'Couples in open conflict', 'Retained negative memory', 'Days to reconciliation', 'Conflicts per couple']) {
      expect(await screen.findByText(t)).toBeInTheDocument();
    }
  });

  it('Couples lists rows and filters by state', async () => {
    at('/couples');
    expect(await screen.findByText('6 couples')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'divorced' } });
    expect(await screen.findByText('1 couples')).toBeInTheDocument();
  });

  it('CoupleDetail shows the timeline, members and decisions', async () => {
    at('/couples/3');
    expect(await screen.findByRole('heading', { name: 'Couple 3' })).toBeInTheDocument();
    expect(screen.getAllByTestId('gantt-segment').length).toBeGreaterThan(2);
    expect(screen.getByRole('table', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Decisions' })).toBeInTheDocument();
    expect(screen.getByText(/Day 45: divorced/)).toBeInTheDocument();
  });

  it('AgentDetail shows traits and history', async () => {
    at('/agents/7');
    expect(await screen.findByRole('heading', { name: 'Agent 7' })).toBeInTheDocument();
    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Traits' })).toBeInTheDocument();
  });

  it('Policy lists what the policy never sees', async () => {
    at('/policy');
    expect(await screen.findByText('The policy never sees')).toBeInTheDocument();
    expect(screen.getByText('treatment arm')).toBeInTheDocument();
    expect(screen.getByText('rep_negmem')).toBeInTheDocument();
  });

  it('Governance shows placebo, twins and balance', async () => {
    at('/governance');
    expect(await screen.findByText(/intervals cover zero/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Paired effects' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Balance' })).toBeInTheDocument();
  });

  it('World renders the framing, scoreboard and counters from the fixture and steps days with the keyboard', async () => {
    at('/world');
    expect(await screen.findByRole('heading', { name: 'World replay' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('framing')).toHaveTextContent('On the left a fight fades from memory in 14 days. On the right it lingers for 90.'));
    expect(screen.getByText('Forgets fights in 2 weeks')).toBeInTheDocument();
    expect(screen.getByText('Holds onto fights for 3 months')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('control-married')).toHaveTextContent('3'));
    // The asserting canvas mock: every initial couple tile plus the remarriage strip was painted.
    expect(canvasStats.contexts).toBeGreaterThan(0);
    expect(canvasStats.fillRect).toBeGreaterThanOrEqual(6);
    expect(screen.getByTestId('score-divorced')).toHaveTextContent('none');
    expect(screen.getByTestId('score-trust')).toHaveTextContent('0.80');
    expect(screen.getByText(/After divorce, dating and remarriage: 0 dating, 0 married today/)).toBeInTheDocument();
    expect(screen.queryByTestId('takeaway')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'End' });
    await waitFor(() => expect(screen.getByTestId('day-label')).toHaveTextContent('59'));
    expect(screen.getByTestId('treatment-divorced')).toHaveTextContent('1');
    expect(screen.getByTestId('score-divorced')).toHaveTextContent('1 in 3');
    expect(screen.getByTestId('takeaway')).toHaveTextContent('By day 60, 0.0% of control couples had divorced against 33.3% of treatment couples.');
    expect(screen.getByText(/After divorce, dating and remarriage: 0 dating, 1 married today/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('day-label')).toHaveTextContent('49'));
  });

  it('World twins mode shows both twins of the same couples and the diverged counter', async () => {
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    const btn = await screen.findByRole('button', { name: 'Same couples, both arms' });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(screen.getByTestId('framing')).toHaveTextContent('one couple shown twice');
    fireEvent.keyDown(window, { key: 'End' });
    await waitFor(() => expect(screen.getByTestId('diverged')).toHaveTextContent('Couples whose fate differs today, 2 of 6'));
    expect(screen.getByTestId('score-divorced')).toHaveTextContent('Holds onto fights for 3 months run');
    expect(screen.queryByTestId('score-trust')).not.toBeInTheDocument();
    expect(screen.getByTestId('takeaway')).toHaveTextContent('in their control run against');
  });

  it('World ticker lists the day events in plain words with the couple id, and recovers from a failure', async () => {
    const spy = vi.spyOn(mock, 'getEventsForDay');
    spy.mockRejectedValueOnce(new Error('503 upstream (/events?day=0)'));
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    expect(await screen.findByTestId('ticker-error')).toHaveTextContent('503 upstream');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('ticker')).toBeInTheDocument());
    expect(screen.getByText(/Day 0, couple 0: intervention applied by agent 0/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('day-label')).toHaveTextContent('40'));
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('day-label')).toHaveTextContent('50'));
    expect(await screen.findByText(/Day 50, couple 6: matched/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it('World shortcuts ignore buttons and the canvas handles its own keys', async () => {
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    const play = screen.getByRole('button', { name: 'Play' });
    fireEvent.keyDown(play, { key: 'End' });
    expect(screen.getByTestId('day-label')).toHaveTextContent('0');
    const grid = screen.getByTestId('grid-control');
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('grid-control-live')).toHaveTextContent('Couple 2: married'));
    expect(screen.getByTestId('day-label')).toHaveTextContent('0');
  });

  it('Top bar lists experiments and persists the choice in the URL', async () => {
    at('/overview');
    const select = (await screen.findByTestId('experiment-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(select.value).toBe('retention-90d');
    fireEvent.change(select, { target: { value: 'job-loss-everyone' } });
    await waitFor(() => expect((screen.getByTestId('experiment-select') as HTMLSelectElement).value).toBe('job-loss-everyone'));
    const link = screen.getByRole('link', { name: 'New experiment' });
    expect(link.getAttribute('href')).toContain('experiment=job-loss-everyone');
  });

  it('New experiment panel builds shocks from the catalog and runs', async () => {
    const original = mock.runExperiment;
    const spy = vi.spyOn(mock, 'runExperiment').mockImplementation(async (body) => {
      await new Promise((r) => setTimeout(r, 300));
      return original(body);
    });
    at('/new');
    expect(await screen.findByRole('heading', { name: 'New experiment' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add shock' }));
    const row = screen.getByTestId('shock-row');
    expect(within(row).getByTestId('shock-blurb')).toHaveTextContent('loses their job');
    fireEvent.change(within(row).getByLabelText('Shock kind'), { target: { value: 'financial_crisis' } });
    expect(within(row).getByTestId('shock-blurb')).toHaveTextContent('Money trouble');
    expect(within(row).queryByLabelText('Which partner')).not.toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('Hits'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'crisis-test' } });
    fireEvent.change(screen.getByLabelText('Treatment conflict half-life'), { target: { value: '60' } });
    fireEvent.click(screen.getByTestId('run'));
    expect(await screen.findByTestId('progress')).toHaveTextContent('Running the engine');
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0][0];
    expect(body.name).toBe('crisis-test');
    expect(body.treatment.conflict_half_life_days).toBe(60);
    expect(body.world?.shocks[0].kind).toBe('financial_crisis');
    expect('trait' in body.world!.shocks[0]).toBe(false);
    expect(body.treatment.shocks).toBeUndefined();
    // The list is refetched before the new experiment is selected, and the URL carries it.
    await waitFor(() => expect(mock.listCalls.count).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/overview?experiment=crisis-test'));
    await waitFor(() => expect((screen.getByTestId('experiment-select') as HTMLSelectElement).value).toBe('crisis-test'));
    spy.mockRestore();
  });

  it('New experiment panel shows a clear error and a retry', async () => {
    const spy = vi.spyOn(mock, 'runExperiment').mockRejectedValueOnce(new Error('409 experiment exists (/experiments/run)'));
    at('/new');
    await screen.findByRole('heading', { name: 'New experiment' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'dup' } });
    fireEvent.click(screen.getByTestId('run'));
    expect(await screen.findByTestId('run-error')).toHaveTextContent('409 experiment exists');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('Under the hood renders nothing until opened, then lists days with episodes and decisions', async () => {
    at('/couples/3');
    await screen.findByRole('heading', { name: 'Couple 3' });
    expect(screen.queryByTestId('hood-day')).not.toBeInTheDocument();
    const details = screen.getByTestId('under-the-hood') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(screen.getAllByTestId('hood-day').length).toBeGreaterThan(5));
    expect(screen.getByText('Day 5')).toBeInTheDocument();
    expect(screen.getAllByText(/conflict 0\.48/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/repair \d+%/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('From day'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('To day'), { target: { value: '31' } });
    await waitFor(() => expect(screen.getAllByTestId('hood-day').length).toBe(2));
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: '7' } });
    expect(screen.getAllByRole('row').filter((r) => r.textContent?.startsWith('Agent 6')).length).toBe(0);
  });

  it('Under the hood shows a shock on the day it hit', async () => {
    at('/couples/1');
    await screen.findByRole('heading', { name: 'Couple 1' });
    const details = screen.getByTestId('under-the-hood') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    fireEvent.change(await screen.findByLabelText('From day'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('To day'), { target: { value: '20' } });
    expect(await screen.findByText(/Shock: job loss on agent 2, magnitude 1.00/)).toBeInTheDocument();
  });

  it('Overview and World render a shock-only experiment without throwing', async () => {
    at('/overview?experiment=job-loss-api');
    expect(await screen.findByRole('heading', { name: 'job-loss-api' })).toBeInTheDocument();
    expect(screen.getByText('Only this, one partner loses their job on day 60. Memory is identical in both arms. Everyone also lives through every seventh day both partners store a positive memory of an evening together on day 0.')).toBeInTheDocument();
    expect(screen.getAllByText('No job loss').length).toBeGreaterThan(0);
    expect(screen.getAllByText('One partner loses their job on day 60').length).toBeGreaterThan(0);
    // The remarriage outcome carries nulls in this run and must render as n/a, not crash.
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
    expect(screen.getByText('not estimable in this run')).toBeInTheDocument();
  });

  it('World frames a shock-only experiment by its shocks', async () => {
    at('/world?experiment=job-loss-api');
    await screen.findByRole('heading', { name: 'World replay' });
    await waitFor(() => expect(screen.getByTestId('framing')).toHaveTextContent('Only this, one partner loses their job on day 60. Memory is identical in both arms.'));
    expect(screen.getByText('No job loss')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'End' });
    await waitFor(() => expect(screen.getByTestId('takeaway')).toHaveTextContent('The only difference was this, one partner loses their job on day 60.'));
    const select = screen.getByTestId('experiment-select') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map((o) => o.textContent)).toContain('job-loss-api (job loss on day 60, everyone: date nights on day 0)');
  });

  it('every link and navigation carries the experiment query', async () => {
    at('/couples?experiment=job-loss-api');
    await screen.findByText('6 couples');
    fireEvent.click(screen.getAllByRole('row').find((r) => r.textContent?.startsWith('3'))!);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/couples/3?experiment=job-loss-api'));
    await screen.findByRole('heading', { name: 'Couple 3' });
    expect(screen.getByRole('link', { name: 'All couples' }).getAttribute('href')).toBe('/couples?experiment=job-loss-api');
    expect(screen.getByRole('link', { name: '6' }).getAttribute('href')).toBe('/agents/6?experiment=job-loss-api');
    fireEvent.click(screen.getByRole('link', { name: '6' }));
    await screen.findByRole('heading', { name: 'Agent 6' });
    expect(screen.getByRole('link', { name: 'All agents' }).getAttribute('href')).toBe('/agents?experiment=job-loss-api');
    expect(screen.getByRole('link', { name: '3' }).getAttribute('href')).toBe('/couples/3?experiment=job-loss-api');
    fireEvent.click(screen.getByRole('link', { name: 'All agents' }));
    await screen.findByRole('heading', { name: 'Agents' });
    expect(screen.getByRole('link', { name: 'couples' }).getAttribute('href')).toBe('/couples?experiment=job-loss-api');
    fireEvent.change(screen.getByLabelText('Agent id'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/agents/7?experiment=job-loss-api'));
    await screen.findByRole('heading', { name: 'Agent 7' });
  });

  it('a World tile opens the couple with the experiment query', async () => {
    at('/world?experiment=job-loss-api');
    await screen.findByRole('heading', { name: 'World replay' });
    const grid = screen.getByTestId('grid-control');
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/couples/2?experiment=job-loss-api'));
  });

  it('an unknown experiment in the URL renders a top-level error once the list loads', async () => {
    at('/overview?experiment=nope');
    expect(await screen.findByTestId('unknown-experiment')).toHaveTextContent('there is no experiment named "nope"');
    expect(screen.queryByRole('heading', { name: 'retention-90d' })).not.toBeInTheDocument();
    const select = screen.getByTestId('experiment-select') as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'retention-90d' } });
    expect(await screen.findByRole('heading', { name: 'retention-90d' })).toBeInTheDocument();
  });

  it('New experiment supports a trait shift with a required trait selector', async () => {
    const spy = vi.spyOn(mock, 'runExperiment');
    at('/new');
    await screen.findByRole('heading', { name: 'New experiment' });
    fireEvent.click(screen.getByRole('button', { name: 'Add shock' }));
    const row = screen.getByTestId('shock-row');
    expect(within(row).queryByLabelText('Trait')).not.toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('Shock kind'), { target: { value: 'trait_shift' } });
    const trait = within(row).getByLabelText('Trait') as HTMLSelectElement;
    expect(trait).toBeRequired();
    expect(trait.options.length).toBe(9);
    fireEvent.change(trait, { target: { value: 'agreeableness' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'shift-test' } });
    fireEvent.click(screen.getByTestId('run'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0][0];
    expect(body.treatment.shocks?.[0]).toMatchObject({ kind: 'trait_shift', trait: 'agreeableness', start_day: 30, magnitude: 0.3 });
    spy.mockRestore();
  });

  it('New experiment validates before running and before retrying', async () => {
    const spy = vi.spyOn(mock, 'runExperiment');
    at('/new');
    await screen.findByRole('heading', { name: 'New experiment' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'bad name!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add shock' }));
    const row = screen.getByTestId('shock-row');
    fireEvent.change(within(row).getByLabelText('Start day'), { target: { value: '300' } });
    fireEvent.change(within(row).getByLabelText('End day'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('run'));
    const errors = await screen.findByTestId('validation-errors');
    expect(errors).toHaveTextContent('Name must start with a letter or digit');
    expect(errors).toHaveTextContent('end day must be on or after the start day');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('Under the hood keeps history days reachable, uses the previous logged record for deltas, and filters shocks by member', async () => {
    at('/couples/1');
    await screen.findByRole('heading', { name: 'Couple 1' });
    const details = screen.getByTestId('under-the-hood') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const from = await screen.findByLabelText('From day');
    expect((from as HTMLInputElement).value).toBe('0');
    fireEvent.change(from, { target: { value: '-1000' } });
    fireEvent.change(screen.getByLabelText('To day'), { target: { value: '-1' } });
    await waitFor(() => expect(screen.getAllByTestId('hood-day').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/history/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('From day'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('To day'), { target: { value: '20' } });
    expect(await screen.findByText(/Shock: job loss on agent 2/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: '3' } });
    await waitFor(() => expect(screen.queryByText(/Shock: job loss on agent 2/)).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: '2' } });
    expect(await screen.findByText(/Shock: job loss on agent 2/)).toBeInTheDocument();
  });
});

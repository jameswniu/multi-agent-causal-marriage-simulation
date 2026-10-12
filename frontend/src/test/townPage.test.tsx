// Page tests for the World page's Town and Grid views: the grid stays when the browser has no
// WebGL, and a town that cannot start falls back to the grid with a note instead of a blank card.
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mock from './mockApi';
import App from '../App';

const couples = vi.hoisted(() => ({ hang: false }));
vi.mock('../api', async () => {
  const m = await import('./mockApi');
  return { ...m, listCouples: (...args: Parameters<typeof m.listCouples>) => (couples.hang ? new Promise<never>(() => {}) : m.listCouples(...args)) };
});

const gl = vi.hoisted(() => ({ supported: false, startFails: true }));
vi.mock('../town/webgl', () => ({ supportsWebGL: () => gl.supported }));

// jsdom has no WebGL, so the renderer is replaced by one whose start either fails or never ends.
vi.mock('pixi.js', () => ({
  Application: class {
    init(): Promise<void> {
      return gl.startFails ? Promise.reject(new Error('no WebGL renderer in this test')) : new Promise<void>(() => {});
    }
    destroy(): void {}
  },
}));

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock.resetMockState();
  gl.supported = false;
  gl.startFails = true;
  couples.hang = false;
  vi.useRealTimers();
});

describe('World town view', () => {
  it('keeps the grid and disables the town when the browser has no WebGL', async () => {
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    await waitFor(() => expect(screen.getByTestId('grid-control')).toBeInTheDocument());
    const town = screen.getByRole('button', { name: 'Town' });
    expect(town).toBeDisabled();
    expect(town).toHaveAttribute('title', 'The town needs WebGL, which this browser does not offer.');
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('framing')).toHaveTextContent('Both grids start from the same');
    expect(screen.queryByTestId('town')).not.toBeInTheDocument();
  });

  it('opens on the town where WebGL exists, and falls back to the grid with a note when the town cannot start', async () => {
    gl.supported = true;
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    expect(screen.getByRole('button', { name: 'Town' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('town-note')).toHaveTextContent('Showing the grid because the town could not start (no WebGL renderer in this test).'));
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('grid-control')).toBeInTheDocument();
    expect(screen.queryByTestId('town')).not.toBeInTheDocument();
  });

  it('shows the town card with its legend and footnote while it starts, and the switch goes back to the grid', async () => {
    gl.supported = true;
    gl.startFails = false;
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    const town = await screen.findByTestId('town');
    expect(town).toHaveTextContent('Positions are a layout.');
    expect(town).toHaveTextContent('In a conflict, both outside and apart');
    // The camera keeps zoom and the whole town; there is no separate plaza view, and no ring key on a world that is not a fork.
    const camera = within(town).getByRole('group', { name: 'Town camera' });
    expect(within(camera).getAllByRole('button').map((b) => b.textContent)).toEqual(['+', '-', 'Whole town']);
    expect(screen.queryByRole('button', { name: /plaza/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('ring-key')).not.toBeInTheDocument();
    expect(screen.getByTestId('framing')).toHaveTextContent('Both districts start from the same');
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    await waitFor(() => expect(screen.getByTestId('grid-control')).toBeInTheDocument());
    expect(screen.queryByTestId('town')).not.toBeInTheDocument();
  });

  it('keeps the twins mode on the grid, since the town shows the randomized run', async () => {
    gl.supported = true;
    at('/world');
    await screen.findByRole('heading', { name: 'World replay' });
    const twins = screen.getByRole('button', { name: 'Same couples, both arms' });
    await waitFor(() => expect(twins).not.toBeDisabled());
    fireEvent.click(twins);
    await waitFor(() => expect(screen.getByTestId('diverged')).toBeInTheDocument());
    expect(screen.queryByTestId('town')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Town' })).not.toBeInTheDocument();
  });

  it('draws stand-in people when the couples table never arrives, instead of building forever', async () => {
    gl.supported = true;
    gl.startFails = false;
    couples.hang = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    at('/world');
    await screen.findByTestId('town');
    await vi.advanceTimersByTimeAsync(8100);
    await waitFor(() => expect(screen.getByTestId('town')).toHaveTextContent('The couples table did not arrive within 8 seconds'));
    vi.useRealTimers();
  });
});

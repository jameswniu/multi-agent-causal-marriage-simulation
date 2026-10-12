// The World replay page of a simulated trial of married couples redraws its town every day while
// the replay plays. The density strip under the scrubber only changes with the run, so the page
// must hand it the same drawn series on every day; fresh arrays each day made the strip redraw
// its bars on every frame, which cost most of the frame rate on machines without a GPU.
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCanvasStats } from './setup';
import * as mock from './mockApi';
import App from '../App';

vi.mock('../api', () => import('./mockApi'));

const seen = vi.hoisted(() => [] as Array<{ day: number; density: unknown; bands: unknown[] }>);

vi.mock('../components/TimeStrip', () => ({
  default: (props: { day: number; density: unknown; bands: unknown[] }) => {
    seen.push({ day: props.day, density: props.density, bands: props.bands });
    return <div data-testid="timestrip" />;
  },
}));

beforeEach(() => {
  resetCanvasStats();
  mock.resetMockState();
  seen.length = 0;
});

describe('time strip inputs', () => {
  it('keeps the same drawn series while the day moves, so the strip is not redrawn each day', async () => {
    render(
      <MemoryRouter initialEntries={['/world?experiment=job-loss-api']}>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'World replay' });
    await waitFor(() => expect(seen.at(-1)?.bands.length ?? 0).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('day-label')).toHaveTextContent('Day 0, week 1'));
    // Let the digest settle before taking the day-0 inputs, since loading it rightly rebuilds them.
    await new Promise((r) => setTimeout(r, 50));
    const before = seen.at(-1)!;
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    await waitFor(() => expect(seen.at(-1)?.day).toBe(10));
    const after = seen.at(-1)!;
    expect(after.density).toBe(before.density);
    expect(after.bands).toBe(before.bands);
  });
});

// Tests for the "versus its parent" table on a forked world's Overview: differences in each outcome's
// own unit, and a plain reason when the fork cannot be compared couple by couple with its parent.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import VersusParent, { fmtDiff } from '../components/VersusParent';
import type { ParentRecord } from '../types';

const base: Omit<ParentRecord, 'comparison'> = {
  parent: 'example',
  parent_determinism_hash: 'abcdef0123456789',
  parent_engine_version: '0.3.0',
  appended_shocks: [{ kind: 'job_loss', target: 'all', member: 'random', start_day: 5, end_day: 40, magnitude: 1, trait: null }],
};

describe('versus its parent', () => {
  it('writes shares as points and other outcomes as signed numbers', () => {
    expect(fmtDiff('divorce_rate', 0.012)).toBe('+1.2 pts');
    expect(fmtDiff('separation_rate', -0.05)).toBe('-5.0 pts');
    expect(fmtDiff('final_trust', -0.0314)).toBe('-0.031');
    expect(fmtDiff('conflict_rate', 0.5)).toBe('+0.500');
    expect(fmtDiff('days_married', 2)).toBe('+2.0');
    expect(fmtDiff('divorce_rate', null)).toBe('n/a');
  });

  it('says why a fork cannot be compared', () => {
    const record: ParentRecord = { ...base, comparison: { comparable: false, reason: 'the parent was run again while this fork waited' } };
    render(
      <MemoryRouter>
        <VersusParent record={record} outcomes={[]} catalog={null} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No couple-by-couple comparison: the parent was run again while this fork waited.');
    expect(screen.getByRole('link', { name: 'example' })).toHaveAttribute('href', '/overview?experiment=example');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// The "versus its parent" table on a forked world's Overview. A fork runs the very same couples on the
// very same random numbers as its parent with only the added shocks changed, so each couple is compared
// with itself in the parent world, for all couples and for each arm, with a bootstrap interval.
import { Link } from 'react-router-dom';
import type { Outcome, PairedRow, ParentRecord } from '../types';
import { shortHash } from '../format';
import { shocksIntroduced, type Catalog } from '../arms';

const ARMS: { key: 'all' | 'control' | 'treatment'; label: string }[] = [
  { key: 'all', label: 'All couples' },
  { key: 'control', label: 'Control couples' },
  { key: 'treatment', label: 'Treatment couples' },
];

/** A difference in its outcome's own unit: shares as percentage points, everything else as a number. */
export function fmtDiff(name: string, x: number | null): string {
  if (x === null || Number.isNaN(x)) return 'n/a';
  const share = name.endsWith('_rate') && name !== 'conflict_rate';
  const v = share ? x * 100 : x;
  const digits = share ? 1 : name === 'days_married' ? 1 : 3;
  const s = v.toFixed(digits);
  const signed = v > 0 ? `+${s}` : s;
  return share ? `${signed} pts` : signed;
}

function cell(row: PairedRow | undefined): string {
  if (!row) return 'n/a';
  const ci = row.ci_low === null || row.ci_high === null ? '' : ` [${fmtDiff(row.name, row.ci_low)}, ${fmtDiff(row.name, row.ci_high)}]`;
  return `${fmtDiff(row.name, row.mean_diff)}${ci}`;
}

export default function VersusParent({ record, outcomes, catalog }: { record: ParentRecord; outcomes: Outcome[]; catalog: Catalog | null }) {
  const labels = new Map(outcomes.map((o) => [o.name, o.label]));
  const c = record.comparison;
  return (
    <section aria-label="Versus its parent" data-testid="versus-parent">
      <h2>Versus its parent</h2>
      <p className="muted">
        Forked from <Link to={`/overview?experiment=${encodeURIComponent(record.parent)}`}>{record.parent}</Link> (determinism hash {shortHash(record.parent_determinism_hash, 8)}, engine{' '}
        {record.parent_engine_version}). Same couples, seeds and settings, and the only change is{' '}
        {shocksIntroduced(record.appended_shocks.length === 1 ? 'the shock it added' : 'the shocks it added', record.appended_shocks, catalog)}
      </p>
      {c.comparable ? (
        <>
          <p className="muted">
            Each of the {c.n_couples.toLocaleString()} couples is compared with itself in the parent world, so a difference is what the added shocks did to those couples. Intervals resample couples (or blocks).
          </p>
          <div className="card table-wrap">
            <table className="data" aria-label="Difference from the parent world">
              <thead>
                <tr>
                  <th>Outcome</th>
                  {ARMS.map((a) => (
                    <th key={a.key} className="num">
                      {a.label}
                    </th>
                  ))}
                  <th className="num">Couples changed</th>
                </tr>
              </thead>
              <tbody>
                {c.arms.all.map((row) => (
                  <tr key={row.name}>
                    <td>{labels.get(row.name) ?? row.name.replace(/_/g, ' ')}</td>
                    {ARMS.map((a) => (
                      <td key={a.key} className="num">
                        {cell(c.arms[a.key].find((r) => r.name === row.name))}
                      </td>
                    ))}
                    <td className="num">{row.share_changed === null ? 'n/a' : `${(row.share_changed * 100).toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="status" role="status">
          No couple-by-couple comparison: {c.reason}.
        </div>
      )}
    </section>
  );
}

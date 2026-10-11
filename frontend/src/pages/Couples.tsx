import { useState } from 'react';
import { useExpNavigate } from '../nav';
import { listCouples } from '../api';
import type { Arm, Origin, RelState } from '../types';
import { useAsync } from '../useAsync';
import { ErrorBox, Loading } from '../components/Status';
import { safeFixed } from '../format';

const PAGE = 50;

export default function Couples() {
  const navigate = useExpNavigate();
  const [arm, setArm] = useState<Arm | ''>('');
  const [state, setState] = useState<RelState | ''>('');
  const [origin, setOrigin] = useState<Origin | ''>('');
  const [page, setPage] = useState(0);
  const { data, error, loading } = useAsync(() => listCouples({ arm, state, origin, limit: PAGE, offset: page * PAGE }), [arm, state, origin, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  return (
    <div>
      <h1>Couples</h1>
      <div className="filters" role="group" aria-label="Filters">
        <label>
          Arm
          <select value={arm} onChange={(e) => { setArm(e.target.value as Arm | ''); setPage(0); }}>
            <option value="">All</option>
            <option value="control">Control</option>
            <option value="treatment">Treatment</option>
          </select>
        </label>
        <label>
          State
          <select value={state} onChange={(e) => { setState(e.target.value as RelState | ''); setPage(0); }}>
            <option value="">All</option>
            <option value="married">Married</option>
            <option value="dating">Dating</option>
            <option value="separated">Separated</option>
            <option value="divorced">Divorced</option>
            <option value="broken_up">Broken up</option>
          </select>
        </label>
        <label>
          Origin
          <select value={origin} onChange={(e) => { setOrigin(e.target.value as Origin | ''); setPage(0); }}>
            <option value="">All</option>
            <option value="initial">Initial</option>
            <option value="remarriage">Remarriage</option>
          </select>
        </label>
        <span className="muted">{data ? `${data.total.toLocaleString()} couples` : ''}</span>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {!data && !error ? <Loading what="couples" /> : null}
      {data ? (
        <div className={`card ${loading ? 'stale' : ''}`}>
          <div className="table-wrap">
            <table className="data" aria-label="Couples">
              <thead>
                <tr>
                  <th className="num">Couple</th>
                  <th>Arm</th>
                  <th>Origin</th>
                  <th>Final state</th>
                  <th className="num">Compatibility</th>
                  <th className="num">Formed day</th>
                  <th className="num">Ended day</th>
                  <th className="num">Agents</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.couple_id} className="clickable" onClick={() => navigate(`/couples/${c.couple_id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/couples/${c.couple_id}`)}>
                    <td className="num">{c.couple_id}</td>
                    <td>{c.arm ?? 'mixed'}</td>
                    <td>{c.origin}</td>
                    <td>{c.final_state.replace('_', ' ')}</td>
                    <td className="num">{safeFixed(c.compatibility, 2)}</td>
                    <td className="num">{c.formed_day}</td>
                    <td className="num">{c.ended_day ?? ''}</td>
                    <td className="num">{c.agent_a}, {c.agent_b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="filters" style={{ marginTop: '0.75rem' }}>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</button>
            <span className="muted">Page {page + 1} of {pages}</span>
            <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>Next</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

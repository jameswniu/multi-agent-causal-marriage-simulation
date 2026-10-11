import { getPolicy } from '../api';
import { useAsync } from '../useAsync';
import { ErrorBox, Loading } from '../components/Status';

const GROUPS: [string, string][] = [
  ['aff_', 'Calm days: affiliate'],
  ['rep_', 'Conflict: repair'],
  ['hold_', 'Conflict: hold'],
  ['esc_', 'Conflict: escalate'],
  ['wd_', 'Conflict: withdraw'],
  ['leave_', 'Leave'],
  ['sep_', 'Separation bases'],
];

export default function Policy() {
  const { data, error, loading } = useAsync(getPolicy, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what="the policy" />;
  const weights = Object.entries(data.weights);
  const grouped = GROUPS.map(([prefix, title]) => ({ title, rows: weights.filter(([k]) => k.startsWith(prefix)) }));
  const rest = weights.filter(([k]) => !GROUPS.some(([p]) => k.startsWith(p)));
  return (
    <div className={loading ? 'stale' : ''}>
      <h1>Decision policy</h1>
      <p>
        Kind: <code>{data.kind}</code>. Sampling: {data.sampling.rule} at temperature {data.sampling.temperature}. The policy never sees the treatment arm; the intervention changes memory retention, and the policy only reads what the agent remembers.
      </p>
      <div className="grid-2">
        <div className="card">
          <h3>The policy sees</h3>
          <ul>
            {data.visibility.sees.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>The policy never sees</h3>
          <ul>
            {data.visibility.never_sees.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
      <h2>Utilities by context</h2>
      {Object.entries(data.contexts).map(([ctx, actions]) => (
        <div className="card" key={ctx}>
          <h3>{ctx}</h3>
          {Object.entries(actions).map(([action, formula]) => (
            <div key={action} style={{ marginBottom: '0.5rem' }}>
              <strong>{action}</strong>
              <div className="formula">{formula}</div>
            </div>
          ))}
        </div>
      ))}
      <h2>Weights</h2>
      <div className="grid-2">
        {[...grouped, { title: 'Other', rows: rest }].filter((g) => g.rows.length > 0).map((g) => (
          <div className="card" key={g.title}>
            <h3>{g.title}</h3>
            <table className="data" aria-label={g.title}>
              <tbody>
                {g.rows.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <code>{k}</code>
                    </td>
                    <td className="num">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

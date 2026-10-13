// Governance page: three checks that a measured effect comes from the setting the two arms differ in and not
// from the simulation harness. A placebo run gives both arms the same setting and should find no effect, twin
// runs put every couple under both settings on the same random draws, and covariate balance shows the arms
// started alike. When a run has no placebo or twins beside it, the page names the command that makes them,
// from loveworld, the project's command line tool (python/loveworld/cli.py).
import { Link } from 'react-router-dom';
import { getExperiment } from '../api';
import { useAsync } from '../useAsync';
import Banner from '../components/Banner';
import AteTable from '../components/AteTable';
import { ErrorBox, Loading, Empty } from '../components/Status';
import { fmt } from '../format';
import { armLabels } from '../arms';

/** The read-only demo (VITE_STATIC=1), where nobody can run a placebo, says where the placebo is instead. */
const STATIC = import.meta.env.VITE_STATIC === '1';

export default function Governance() {
  const { data, error, loading } = useAsync(getExperiment, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what="governance checks" />;
  const summary = data.summary;
  if (!summary) return <Empty>No summary.json yet, so no governance checks to show.</Empty>;
  const { placebo, twins } = summary.governance;
  const labels = armLabels(summary.experiment.treatment);
  const coversZero = placebo ? placebo.outcomes.filter((o) => o.ci_low !== null && o.ci_high !== null && o.ci_low <= 0 && o.ci_high >= 0).length : 0;
  return (
    <div className={loading ? 'stale' : ''}>
      <Banner />
      <h1>Governance checks</h1>
      <p className="muted">Three checks that the effect is the intervention's and not the harness's: a placebo run with identical arms, twin runs on shared random streams, and covariate balance after randomization.</p>
      <p>
        The two arms: <strong>{labels.control.plain}</strong> <small className="muted">({labels.control.small})</small> and <strong>{labels.treatment.plain}</strong> <small className="muted">({labels.treatment.small})</small>.
      </p>
      <h2>Placebo</h2>
      {placebo ? (
        <div className="card">
          <p>
            {placebo.note ?? 'Treatment parameters set equal to control.'} {coversZero} of {placebo.outcomes.length} intervals cover zero.
          </p>
          <AteTable outcomes={placebo.outcomes} />
        </div>
      ) : STATIC && data.parent ? (
        <Empty>
          <span data-testid="placebo-in-parent">
            This world was run without a placebo of its own. The placebo for these same couples is on{' '}
            <Link to={`/governance?experiment=${encodeURIComponent(data.parent.parent)}`}>the Governance page of {data.parent.parent}</Link>, the world it was forked from.
          </span>
        </Empty>
      ) : STATIC ? (
        <Empty>This world was published without a placebo run.</Empty>
      ) : (
        <Empty>No placebo run linked. Run <code>loveworld placebo</code> beside this experiment and re-analyze.</Empty>
      )}
      <h2>Twins</h2>
      {twins ? (
        <div className="card">
          <p>{twins.note ?? 'Every couple simulated under both arms.'}</p>
          <div className="table-wrap">
            <table className="data" aria-label="Paired effects">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th className="num">Mean paired difference</th>
                  <th className="num">95% CI</th>
                  <th className="num">Pairs</th>
                </tr>
              </thead>
              <tbody>
                {twins.paired.map((p) => (
                  <tr key={p.name}>
                    <td>{p.label ?? p.name}</td>
                    <td className="num">{fmt(p.mean_diff)}</td>
                    <td className="num">{`[${fmt(p.ci_low)}, ${fmt(p.ci_high)}]`}</td>
                    <td className="num">{p.n_pairs.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Empty>No twins run linked. Run <code>loveworld twins</code> beside this experiment and re-analyze.</Empty>
      )}
      <h2>Covariate balance</h2>
      <div className="card table-wrap">
        <table className="data" aria-label="Balance">
          <thead>
            <tr>
              <th>Covariate</th>
              <th className="num">
                {labels.control.plain}
                <div className="muted" style={{ fontWeight: 400 }}>{labels.control.small}, mean</div>
              </th>
              <th className="num">
                {labels.treatment.plain}
                <div className="muted" style={{ fontWeight: 400 }}>{labels.treatment.small}, mean</div>
              </th>
              <th className="num">Standardized difference</th>
            </tr>
          </thead>
          <tbody>
            {summary.balance.map((b) => (
              <tr key={b.covariate}>
                <td>{b.covariate.replace(/_/g, ' ')}</td>
                <td className="num">{fmt(b.control_mean)}</td>
                <td className="num">{fmt(b.treatment_mean)}</td>
                <td className="num">
                  {fmt(b.smd)}
                  {Math.abs(b.smd) > 0.1 ? <span className="tag">above 0.1</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">A standardized mean difference under 0.1 is the usual mark of balance.</p>
      </div>
    </div>
  );
}

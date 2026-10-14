// The Overview page: one experiment's setup, its average treatment effects with intervals and the
// run manifest, plus, for a forked world, the couple-by-couple comparison with the world it came from.
// A run with no intervention says up front that its gap is what splitting the couples in two produces.
import { getExperiment } from '../api';
import { useAsync } from '../useAsync';
import Banner from '../components/Banner';
import StatTile from '../components/StatTile';
import AteTable from '../components/AteTable';
import ForestPlot from '../components/ForestPlot';
import ChartFrame from '../components/ChartFrame';
import { ErrorBox, Loading } from '../components/Status';
import { fmtShare, safeFixed, shortHash } from '../format';
import { useArmContext, whatDiffers } from '../arms';
import VersusParent from '../components/VersusParent';
import { chanceWords, noIntervention } from '../nullRun';
import { useExperiment } from '../experiment';

/** The read-only demo (VITE_STATIC=1) heads each world with the name every other part of the demo calls it. */
const STATIC = import.meta.env.VITE_STATIC === '1';

/**
 * The read-only demo's heading for a world: the name it is listed under, with the run's own name beside it
 * when the two differ (the example town's run is named retention-90d). The live app heads it with the run's name.
 */
export function listedHeading(runName: string, listed: string | null): string {
  return listed && listed !== runName ? `${listed} (run name ${runName})` : runName;
}

export default function Overview() {
  const { data, error, loading } = useAsync(getExperiment, []);
  const arms = useArmContext();
  const listed = useExperiment().name;
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what="the experiment" />;
  const { manifest, summary } = data;
  const exp = summary?.experiment;
  const divorce = summary?.outcomes.find((o) => o.name === 'divorce_rate');
  const trust = summary?.outcomes.find((o) => o.name === 'final_trust');
  const labels = arms.labels;
  // A run with no intervention leads with its twins, then the gap between its two halves of different couples.
  const chance = exp && noIntervention(exp.treatment, exp.shocks) ? chanceWords(divorce, manifest.n_couples, summary?.governance?.twins) : null;
  return (
    <div className={loading ? 'stale' : ''}>
      <Banner />
      <h1>{STATIC ? listedHeading(manifest.name, listed) : manifest.name}</h1>
      {chance ? (
        <div className="takeaway" data-testid="chance-headline">
          <p className="takeaway-lead">{chance.lead}</p>
          {chance.detail ? <p className="takeaway-detail">{chance.detail}</p> : null}
        </div>
      ) : null}
      <p className="muted">{summary?.disclaimer ?? 'Simulation output; no analysis summary has been written yet.'}</p>
      <div className="kpis">
        <StatTile label="Couples" value={manifest.n_couples.toLocaleString()} sub={`${(summary?.arms.control.couples ?? manifest.n_couples / 2).toLocaleString()} control, ${(summary?.arms.treatment.couples ?? manifest.n_couples / 2).toLocaleString()} treatment`} />
        <StatTile label="Days simulated" value={String(manifest.days)} />
        <StatTile label="What differs" value={whatDiffers(arms.intervention, arms.catalog)} sub={exp ? `${labels.control.small}; ${labels.treatment.small}` : undefined} text />
        <StatTile label="Seeds" value={`${manifest.seeds.population} / ${manifest.seeds.assignment} / ${manifest.seeds.dynamics}`} sub="population / assignment / dynamics" />
        <StatTile label="Determinism hash" value={shortHash(manifest.determinism_hash, 8)} sub={manifest.determinism_hash} />
        {divorce ? <StatTile label="Divorced within the year" value={`${fmtShare(divorce.control_mean)} vs ${fmtShare(divorce.treatment_mean)}`} sub={`${labels.control.plain} vs ${labels.treatment.plain}`} /> : null}
        {trust ? <StatTile label="Trust on the last day" value={`${safeFixed(trust.control_mean, 2)} vs ${safeFixed(trust.treatment_mean, 2)}`} sub={`${labels.control.plain} vs ${labels.treatment.plain}, 0 to 1`} /> : null}
      </div>
      {data.parent ? <VersusParent record={data.parent} outcomes={summary?.outcomes ?? []} catalog={arms.catalog} /> : null}
      {summary ? (
        <>
          <h2>Average treatment effects</h2>
          <p className="muted">
            Effect is {labels.treatment.plain.toLowerCase()} minus {labels.control.plain.toLowerCase()} ({labels.treatment.small.split(',')[0]} minus {labels.control.small.split(',')[0]}). Intervals are {Math.round((summary.outcomes[0]?.ci_level ?? 0.95) * 100)}% {summary.outcomes[0]?.ci_method.replace(/_/g, ' ')} over {summary.outcomes[0]?.n_boot.toLocaleString()} resamples; p is a permutation test over {summary.outcomes[0]?.n_perm.toLocaleString()} relabelings. Conditional outcomes are computed on events that happened after assignment, so they describe survivors, not the randomized population.
          </p>
          <div className="card">
            <AteTable outcomes={summary.outcomes} />
          </div>
          <ChartFrame title="Forest plot" subtitle="Each outcome on its own scale, centred on zero. Whiskers are the confidence interval; the dot is the point estimate." height={summary.outcomes.length * 34 + 24}>
            {(w) => <ForestPlot outcomes={summary.outcomes} width={w} />}
          </ChartFrame>
        </>
      ) : (
        <div className="status">No summary.json yet. Run the analysis step to populate effects.</div>
      )}
      <h2>Run manifest</h2>
      <div className="card table-wrap">
        <table className="data" aria-label="Output files">
          <thead>
            <tr>
              <th>File</th>
              <th className="num">Rows</th>
              <th>SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(manifest.files).map(([name, f]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="num">{f.rows.toLocaleString()}</td>
                <td>
                  <code>{shortHash(f.sha256, 16)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Engine {manifest.engine_version}. Evidence class: {manifest.evidence_class}.</p>
      </div>
    </div>
  );
}

// The Comparisons page: one LoveWorld run's two arms side by side. LoveWorld randomises 1,000 simulated couples
// into a control and a treatment arm that differ in how long a fight stays in memory (and in any shock added), and
// this page charts each arm over the year: marriages surviving, trust with a 95% band, couples in open conflict and
// retained negative memory, plus histograms of days to reconciliation and conflicts per couple. Every chart has a
// table view below it.
import { getCurves, getDistributions } from '../api';
import { useAsync } from '../useAsync';
import Banner from '../components/Banner';
import ChartFrame from '../components/ChartFrame';
import SurvivalChart, { toRows as toArmRows } from '../components/SurvivalChart';
import TrustBandChart, { toRows as toBandRows } from '../components/TrustBandChart';
import Histogram, { toRows as toHistRows } from '../components/Histogram';
import { ErrorBox, Loading } from '../components/Status';
import type { ArmSeries, BandSeries, Histogram as HistogramData } from '../types';
import { safeFixed } from '../format';
import { useArmContext } from '../arms';

function ArmTable({ s, unit }: { s: ArmSeries; unit: string }) {
  const rows = toArmRows(s).filter((_, i) => i % 7 === 0);
  return (
    <table className="data">
      <thead>
        <tr>
          <th className="num">Day</th>
          <th className="num">Control ({unit})</th>
          <th className="num">Treatment ({unit})</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.day}>
            <td className="num">{r.day}</td>
            <td className="num">{safeFixed(r.control, 3)}</td>
            <td className="num">{safeFixed(r.treatment, 3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BandTable({ s }: { s: BandSeries }) {
  const rows = toBandRows(s).filter((_, i) => i % 7 === 0);
  return (
    <table className="data">
      <thead>
        <tr>
          <th className="num">Day</th>
          <th className="num">Control mean</th>
          <th className="num">Control band</th>
          <th className="num">Treatment mean</th>
          <th className="num">Treatment band</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.day}>
            <td className="num">{r.day}</td>
            <td className="num">{safeFixed(r.control, 3)}</td>
            <td className="num">{`${safeFixed(r.controlBand[0], 3)} to ${safeFixed(r.controlBand[1], 3)}`}</td>
            <td className="num">{safeFixed(r.treatment, 3)}</td>
            <td className="num">{`${safeFixed(r.treatmentBand[0], 3)} to ${safeFixed(r.treatmentBand[1], 3)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistTable({ h, label }: { h: HistogramData; label: string }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th className="num">{label}</th>
          <th className="num">Control</th>
          <th className="num">Treatment</th>
        </tr>
      </thead>
      <tbody>
        {toHistRows(h).map((r) => (
          <tr key={r.bin}>
            <td className="num">{r.bin}</td>
            <td className="num">{safeFixed(r.control * 100, 1)}%</td>
            <td className="num">{safeFixed(r.treatment * 100, 1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Comparisons() {
  const { data, error, loading } = useAsync(() => Promise.all([getCurves(), getDistributions()]), []);
  // Every chart's key names the arms, so the page waits for this world's labels as well as its curves.
  const { ready, error: labelsError } = useArmContext();
  if (error) return <ErrorBox message={error} />;
  if (labelsError) return <ErrorBox message={labelsError} />;
  if (!data || !ready) return <Loading what="curves" />;
  const [curves, dists] = data;
  return (
    <div className={loading ? 'stale' : ''}>
      <Banner />
      <h1>Causal comparisons</h1>
      <p className="muted">Control and treatment keep the same colours on every chart. Each chart has a table view below it.</p>
      <div className="grid-2">
        <ChartFrame title="Marriages surviving" subtitle="Share of initial couples not yet divorced, by day" table={<ArmTable s={curves.survival} unit="share" />}>
          {(w, h) => <SurvivalChart series={curves.survival} width={w} height={h} yLabel="Still married" unit="share" step domain={[0, 1]} />}
        </ChartFrame>
        <ChartFrame title="Trust over the year" subtitle="Mean of both members across couples, with a 95% band" table={<BandTable s={curves.trust} />}>
          {(w, h) => <TrustBandChart series={curves.trust} width={w} height={h} />}
        </ChartFrame>
        <ChartFrame title="Couples in open conflict" subtitle="Share of active couples with a conflict open that day" table={<ArmTable s={curves.in_conflict} unit="share" />}>
          {(w, h) => <SurvivalChart series={curves.in_conflict} width={w} height={h} yLabel="In conflict" unit="share" />}
        </ChartFrame>
        <ChartFrame title="Retained negative memory" subtitle="Mean saturated negative load about the partner" table={<ArmTable s={curves.neg_load} unit="load" />}>
          {(w, h) => <SurvivalChart series={curves.neg_load} width={w} height={h} yLabel="Negative load" unit="load" />}
        </ChartFrame>
        <ChartFrame title="Days to reconciliation" subtitle="Distribution of reconciled conflict durations" table={<HistTable h={dists.recovery_days} label="Days" />}>
          {(w, h) => <Histogram data={dists.recovery_days} width={w} height={h} xLabel="Days" />}
        </ChartFrame>
        <ChartFrame title="Conflicts per couple" subtitle="Distribution over initial couples" table={<HistTable h={dists.conflicts_per_couple} label="Conflicts" />}>
          {(w, h) => <Histogram data={dists.conflicts_per_couple} width={w} height={h} xLabel="Conflicts in the year" />}
        </ChartFrame>
      </div>
    </div>
  );
}

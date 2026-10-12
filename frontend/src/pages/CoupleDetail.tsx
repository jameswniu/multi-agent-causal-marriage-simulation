// Detail page for one simulated couple in a LoveWorld run. A couple's arm is the memory setting it
// was randomised to (control forgets a fight faster than treatment). The page shows its members,
// state timeline, trust and affect, conflicts, events, decisions and the developer log.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ExpLink } from '../nav';
import { getCouple } from '../api';
import { useAsync } from '../useAsync';
import { ErrorBox, Loading } from '../components/Status';
import ChartFrame from '../components/ChartFrame';
import StateGantt from '../components/StateGantt';
import TrustLines from '../components/TrustLines';
import EventMarkers from '../components/EventMarkers';
import DecisionTable from '../components/DecisionTable';
import StatTile from '../components/StatTile';
import UnderTheHood from '../components/UnderTheHood';
import { useArmLabels } from '../arms';
import { safeFixed } from '../format';

export default function CoupleDetail() {
  const { id } = useParams();
  const coupleId = Number(id);
  const { data, error, loading } = useAsync(() => getCouple(coupleId), [coupleId]);
  const [metric, setMetric] = useState<'trust' | 'affect'>('trust');
  const labels = useArmLabels();
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what={`couple ${coupleId}`} />;
  const { couple, agents, daily, events, conflicts, decisions, episodes } = data;
  const lastDay = Math.max(0, ...daily.map((d) => d.day));
  return (
    <div className={loading ? 'stale' : ''}>
      <p>
        <ExpLink to="/couples">All couples</ExpLink>
      </p>
      <h1>Couple {couple.couple_id}</h1>
      <div className="kpis">
        <StatTile
          label="Arm"
          value={couple.arm ? labels[couple.arm].plain : 'Mixed'}
          sub={couple.arm ? `${labels[couple.arm].small}, ${couple.origin} couple` : 'remarriage couple, members keep their own arm'}
        />
        <StatTile label="Final state" value={couple.final_state.replace('_', ' ')} sub={couple.ended_day !== null ? `ended day ${couple.ended_day}` : 'still together at the end'} />
        <StatTile label="Compatibility" value={safeFixed(couple.compatibility, 2)} sub="1 minus mean trait distance" />
        <StatTile label="Formed" value={couple.formed_day < 0 ? `${Math.round(-couple.formed_day / 365)} yrs before` : `day ${couple.formed_day}`} sub={couple.married_day !== null ? `married day ${couple.married_day}` : 'not married'} />
      </div>
      <div className="card table-wrap">
        <table className="data" aria-label="Members">
          <thead>
            <tr>
              <th className="num">Agent</th>
              <th>Arm</th>
              <th className="num">Neuroticism</th>
              <th className="num">Agreeableness</th>
              <th className="num">Forgiveness</th>
              <th className="num">Commitment</th>
              <th className="num">Conflict half-life</th>
              <th className="num">Final trust</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.agent_id}>
                <td className="num">
                  <ExpLink to={`/agents/${a.agent_id}`}>{a.agent_id}</ExpLink>
                </td>
                <td>{labels[a.arm].plain} <small className="muted">({labels[a.arm].small.split(',')[0]})</small></td>
                <td className="num">{safeFixed(a.neuroticism, 2)}</td>
                <td className="num">{safeFixed(a.agreeableness, 2)}</td>
                <td className="num">{safeFixed(a.forgiveness, 2)}</td>
                <td className="num">{safeFixed(a.commitment, 2)}</td>
                <td className="num">{a.conflict_half_life_days} d</td>
                <td className="num">{safeFixed(a.final_trust, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ChartFrame title="Relationship timeline" subtitle="State by day">
        {(w) => <StateGantt daily={daily} width={w} lastDay={lastDay} />}
      </ChartFrame>
      <div className="pill-nav" role="group" aria-label="Metric">
        <button onClick={() => setMetric('trust')} aria-pressed={metric === 'trust'}>Trust</button>
        <button onClick={() => setMetric('affect')} aria-pressed={metric === 'affect'}>Affect</button>
      </div>
      <ChartFrame title={metric === 'trust' ? 'Trust of both members' : 'Affect of both members'} subtitle="Shaded spans are conflicts; dots mark transitions" height={300}>
        {(w, h) => <TrustLines daily={daily} conflicts={conflicts} events={events} width={w} height={h} metric={metric} agentA={couple.agent_a} agentB={couple.agent_b} />}
      </ChartFrame>
      <div className="grid-2">
        <div className="card">
          <h3>Conflicts</h3>
          {conflicts.length === 0 ? (
            <p className="muted">No conflicts.</p>
          ) : (
            <div className="table-wrap">
              <table className="data" aria-label="Conflicts">
                <thead>
                  <tr>
                    <th className="num">Start</th>
                    <th className="num">End</th>
                    <th>Outcome</th>
                    <th className="num">Peak</th>
                    <th className="num">Escalations</th>
                    <th className="num">Repairs</th>
                    <th className="num">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {conflicts.map((c, i) => (
                    <tr key={i}>
                      <td className="num">{c.started_day}</td>
                      <td className="num">{c.ended_day ?? 'open'}</td>
                      <td>{c.outcome.replace('_', ' ')}</td>
                      <td className="num">{safeFixed(c.peak_intensity, 2)}</td>
                      <td className="num">{c.escalations}</td>
                      <td className="num">{c.repair_attempts}</td>
                      <td className="num">{c.duration_days ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h3>Events</h3>
          <EventMarkers events={events} />
        </div>
      </div>
      <div className="card">
        <h3>Decisions in conflict and separation</h3>
        <DecisionTable decisions={decisions} />
      </div>
      <UnderTheHood
        members={[
          { id: couple.agent_a, label: `Agent ${couple.agent_a}`, days: daily.map((d) => ({ day: d.day, trust: d.trust_a, affect: d.affect_a, stress: d.stress_a, neg: d.neg_a, pos: d.pos_a, orphanDays: d.orphan_days })) },
          { id: couple.agent_b, label: `Agent ${couple.agent_b}`, days: daily.map((d) => ({ day: d.day, trust: d.trust_b, affect: d.affect_b, stress: d.stress_b, neg: d.neg_b, pos: d.pos_b, orphanDays: d.orphan_days })) },
        ]}
        decisions={decisions}
        episodes={episodes}
        events={events}
        legacies={data.legacies}
      />
    </div>
  );
}

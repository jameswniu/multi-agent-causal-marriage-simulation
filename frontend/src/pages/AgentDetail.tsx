// Detail page for one simulated agent in a LoveWorld run (agents are married partners whose memory
// of conflicts is the variable under test): traits, relationships, daily trust and affect, events,
// and the developer log.
import { useParams } from 'react-router-dom';
import { ExpLink } from '../nav';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { getAgent } from '../api';
import type { AgentDailyRow } from '../types';
import { useAsync } from '../useAsync';
import { ErrorBox, Loading } from '../components/Status';
import ChartFrame from '../components/ChartFrame';
import TraitRadar, { RADAR_SCALE_WORDS } from '../components/TraitRadar';
import EventMarkers from '../components/EventMarkers';
import StatTile from '../components/StatTile';
import UnderTheHood from '../components/UnderTheHood';
import Legend from '../components/Legend';
import ArmTooltip from '../components/ArmTooltip';
import { gridColor, axisColor } from '../palette';
import { safeFixed } from '../format';
import { CHART_TEXT_PX } from '../chartText';

const C1 = 'var(--control)';
const C2 = 'var(--treatment)';

function Lines({ rows, keys, labels, width, height, domain, yLabel }: { rows: AgentDailyRow[]; keys: (keyof AgentDailyRow)[]; labels: string[]; width: number; height: number; domain: [number, number] | ['auto', 'auto']; yLabel: string }) {
  const colors = [C1, C2];
  return (
    <div>
      <Legend items={keys.map((_, i) => ({ label: labels[i], color: i === 0 ? '#2a78d6' : '#eb6834', kind: 'line' as const }))} />
      <LineChart width={width} height={height} data={rows} margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
        <CartesianGrid stroke={gridColor()} vertical={false} />
        <XAxis dataKey="day" stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} label={{ value: 'Day', position: 'insideBottom', offset: -18, fontSize: CHART_TEXT_PX }} />
        <YAxis stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} domain={domain} width={56} label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: CHART_TEXT_PX }} />
        <Tooltip content={<ArmTooltip />} />
        {keys.map((k, i) => (
          <Line key={String(k)} dataKey={String(k)} name={labels[i]} stroke={colors[i]} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </div>
  );
}

export default function AgentDetail() {
  const { id } = useParams();
  const agentId = Number(id);
  const { data, error, loading } = useAsync(() => getAgent(agentId), [agentId]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading what={`agent ${agentId}`} />;
  const { agent, couples, events, daily, episodes, decisions } = data;
  return (
    <div className={loading ? 'stale' : ''}>
      <p>
        <ExpLink to="/agents">All agents</ExpLink>
      </p>
      <h1>Agent {agent.agent_id}</h1>
      <div className="kpis">
        <StatTile label="Arm" value={agent.arm} sub={`initial couple ${agent.couple_id}`} />
        <StatTile label="Conflict memory half-life" value={`${agent.conflict_half_life_days} days`} sub={`repair ${agent.repair_half_life_days} d, positive ${agent.positive_half_life_days} d`} />
        <StatTile label="History" value={`${agent.prior_relationships} prior, ${agent.prior_divorces} divorced`} sub={`${safeFixed(agent.years_married, 1)} years into the marriage at day 0`} />
        <StatTile label="In the simulation" value={`${agent.divorces_in_sim} divorces, ${agent.marriages_in_sim} marriages`} sub={`final trust ${safeFixed(agent.final_trust, 2)}, ${agent.final_memory_size} memories kept`} />
      </div>
      <div className="grid-2">
        <ChartFrame title="Personality and preferences" subtitle={RADAR_SCALE_WORDS} height={320}>
          {(w) => <TraitRadar agent={agent} size={Math.min(w, 360)} />}
        </ChartFrame>
        <div>
          <ChartFrame title="Trust and satisfaction" subtitle="Toward the current partner" height={220}>
            {(w, h) => <Lines rows={daily} keys={['trust', 'satisfaction']} labels={['Trust', 'Satisfaction']} width={w} height={h} domain={[0, 1]} yLabel="0 to 1" />}
          </ChartFrame>
          <ChartFrame title="Retained memory" subtitle="Saturated negative and positive load about the partner" height={220}>
            {(w, h) => <Lines rows={daily} keys={['neg', 'pos']} labels={['Negative load', 'Positive load']} width={w} height={h} domain={['auto', 'auto']} yLabel="Load" />}
          </ChartFrame>
          <ChartFrame title="Affect" subtitle="Daily emotional valence toward the partner" height={200}>
            {(w, h) => <Lines rows={daily} keys={['affect']} labels={['Affect']} width={w} height={h} domain={[-1, 1]} yLabel="-1 to 1" />}
          </ChartFrame>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Relationships</h3>
          <div className="table-wrap">
            <table className="data" aria-label="Relationships">
              <thead>
                <tr>
                  <th className="num">Couple</th>
                  <th>Origin</th>
                  <th>Final state</th>
                  <th className="num">Formed</th>
                  <th className="num">Ended</th>
                </tr>
              </thead>
              <tbody>
                {couples.map((c) => (
                  <tr key={c.couple_id}>
                    <td className="num">
                      <ExpLink to={`/couples/${c.couple_id}`}>{c.couple_id}</ExpLink>
                    </td>
                    <td>{c.origin}</td>
                    <td>{c.final_state.replace('_', ' ')}</td>
                    <td className="num">{c.formed_day}</td>
                    <td className="num">{c.ended_day ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3>Events where this agent acted</h3>
          <EventMarkers events={events} />
        </div>
      </div>
      <UnderTheHood
        members={[{ id: agent.agent_id, label: `Agent ${agent.agent_id}`, days: daily.map((d) => ({ day: d.day, trust: d.trust, affect: d.affect, stress: d.stress, neg: d.neg, pos: d.pos, orphanDays: d.orphan_days })) }]}
        decisions={decisions ?? []}
        episodes={episodes}
        events={events}
        legacies={data.legacies}
      />
    </div>
  );
}

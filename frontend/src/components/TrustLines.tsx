import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, Tooltip, XAxis, YAxis } from 'recharts';
import type { ConflictRow, DailyRow, EventRow } from '../types';
import { memberColor, gridColor, axisColor } from '../palette';
import ArmTooltip from './ArmTooltip';
import Legend from './Legend';

interface Props {
  daily: DailyRow[];
  conflicts: ConflictRow[];
  events: EventRow[];
  width: number;
  height: number;
  metric: 'trust' | 'affect';
  agentA: number;
  agentB: number;
}

const MARKED = new Set(['separated', 'reunited', 'divorced', 'broke_up', 'married', 'matched', 'reconciled']);

export function eventLabel(e: EventRow, withCouple = false): string {
  const who = e.agent_id === null ? '' : ` by agent ${e.agent_id}`;
  const val = e.value === null ? '' : ` (${Number(e.value).toFixed(2)})`;
  const couple = withCouple ? `, couple ${e.couple_id}` : '';
  return `Day ${e.day}${couple}: ${e.kind.replace(/_/g, ' ')}${who}${val}`;
}

export default function TrustLines({ daily, conflicts, events, width, height, metric, agentA, agentB }: Props) {
  const rows = daily.map((d) => ({ day: d.day, a: metric === 'trust' ? d.trust_a : d.affect_a, b: metric === 'trust' ? d.trust_b : d.affect_b }));
  const domain: [number, number] = metric === 'trust' ? [0, 1] : [-1, 1];
  const markers = events.filter((e) => MARKED.has(e.kind));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return (
    <div>
      <Legend items={[{ label: `Agent ${agentA}`, color: memberColor('a'), kind: 'line' }, { label: `Agent ${agentB}`, color: memberColor('b'), kind: 'line' }]} />
      <LineChart width={width} height={height} data={rows} margin={{ top: 16, right: 48, bottom: 28, left: 8 }}>
        <CartesianGrid stroke={gridColor()} vertical={false} />
        <XAxis dataKey="day" type="number" domain={['dataMin', 'dataMax']} stroke={axisColor()} tick={{ fontSize: 14 }} label={{ value: 'Day', position: 'insideBottom', offset: -18, fontSize: 14 }} />
        <YAxis stroke={axisColor()} tick={{ fontSize: 14 }} domain={domain} width={56} label={{ value: metric === 'trust' ? 'Trust (0 to 1)' : 'Affect (-1 to 1)', angle: -90, position: 'insideLeft', fontSize: 14 }} />
        <Tooltip content={<ArmTooltip unit={metric} />} />
        {conflicts.map((c, i) => (
          <ReferenceArea key={i} x1={c.started_day} x2={(c.ended_day ?? daily[daily.length - 1]?.day ?? c.started_day) + 1} fill="var(--treatment)" fillOpacity={0.1} stroke="none" />
        ))}
        <Line dataKey="a" name={`Agent ${agentA}`} stroke={memberColor('a')} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="b" name={`Agent ${agentB}`} stroke={memberColor('b')} strokeWidth={2} dot={false} isAnimationActive={false} />
        {markers.map((e, i) => {
          const r = byDay.get(e.day);
          const y = r ? (r.a + r.b) / 2 : domain[0];
          return <ReferenceDot key={i} x={e.day} y={y} r={5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} label={{ value: e.kind.replace(/_/g, ' '), position: 'top', fontSize: 14 }} />;
        })}
      </LineChart>
      <p className="muted">Shaded spans are open conflicts. Dots mark state transitions.</p>
    </div>
  );
}

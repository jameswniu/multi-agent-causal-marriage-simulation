// Line chart of one couple's two partners over the year: each partner's trust in the other (0 to 1) or their
// affect, which is their mood (-1 to 1), with every open conflict shaded and a dot at each change in the
// relationship, such as separated or reconciled. The couple page draws it. Every change keeps its dot, and each
// dot's name is written beside it only where it overlaps no other name and covers no other dot.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, Tooltip, XAxis, YAxis, useChartWidth, usePlotArea, useXAxisScale, useYAxisScale } from 'recharts';
import type { ConflictRow, DailyRow, EventRow } from '../types';
import { memberColor, gridColor, axisColor } from '../palette';
import ArmTooltip from './ArmTooltip';
import Legend from './Legend';
import { CHART_TEXT_PX } from '../chartText';
import { placeLabels } from '../labelLayout';

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
/** Which names win a crowded stretch: the rarer, bigger changes first, the everyday reconciliations last. */
const PRIORITY: Record<string, number> = { divorced: 0, married: 1, broke_up: 2, matched: 3, separated: 4, reunited: 5, reconciled: 6 };

export function eventLabel(e: EventRow, withCouple = false): string {
  const who = e.agent_id === null ? '' : ` by agent ${e.agent_id}`;
  const val = e.value === null ? '' : ` (${Number(e.value).toFixed(2)})`;
  const couple = withCouple ? `, couple ${e.couple_id}` : '';
  return `Day ${e.day}${couple}: ${e.kind.replace(/_/g, ' ')}${who}${val}`;
}

/** One changed day on the chart: where its dot sits and the name written beside it. */
export interface Marker {
  key: number;
  day: number;
  y: number;
  text: string;
  priority: number;
}

/** The dots' names, drawn inside the chart where they overlap no other name and cover no dot (labelLayout.ts). */
function MarkerLabels({ markers, onHidden }: { markers: Marker[]; onHidden: (n: number) => void }) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  const width = useChartWidth();
  const layout = useMemo(() => {
    if (!xScale || !yScale || !plot || !width) return null;
    const points = markers.flatMap((m) => {
      const x = xScale(m.day);
      const y = yScale(m.y);
      return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [{ key: m.key, x, y, text: m.text, priority: m.priority }] : [];
    });
    // Names stay right of the y axis and above the x axis's numbers, and never cover a dot.
    return placeLabels(points, { left: plot.x, right: width - 2, top: 2, bottom: plot.y + plot.height }, { fontPx: CHART_TEXT_PX, markerRadius: 6 });
  }, [markers, xScale, yScale, plot, width]);
  const hidden = layout ? layout.hidden : 0;
  useEffect(() => onHidden(hidden), [hidden, onHidden]);
  if (!layout) return null;
  return (
    <g className="marker-labels">
      {layout.placed.map((p) => (
        <text key={p.key} x={p.x} y={p.y} textAnchor="middle" fontSize={CHART_TEXT_PX} fill="var(--ink)" data-testid="marker-label">
          {p.text}
        </text>
      ))}
    </g>
  );
}

export default function TrustLines({ daily, conflicts, events, width, height, metric, agentA, agentB }: Props) {
  const rows = daily.map((d) => ({ day: d.day, a: metric === 'trust' ? d.trust_a : d.affect_a, b: metric === 'trust' ? d.trust_b : d.affect_b }));
  const domain: [number, number] = metric === 'trust' ? [0, 1] : [-1, 1];
  // Each dot sits between the two partners' lines on its day. Built once per couple and metric, so the names are
  // not placed again on every render.
  const markers: Marker[] = useMemo(() => {
    const mid = new Map(daily.map((d) => [d.day, metric === 'trust' ? (d.trust_a + d.trust_b) / 2 : (d.affect_a + d.affect_b) / 2]));
    return events
      .filter((e) => MARKED.has(e.kind))
      .map((e, i) => ({ key: i, day: e.day, y: mid.get(e.day) ?? (metric === 'trust' ? 0 : -1), text: e.kind.replace(/_/g, ' '), priority: PRIORITY[e.kind] ?? 9 }));
  }, [daily, events, metric]);
  const [hidden, setHidden] = useState(0);
  const onHidden = useCallback((n: number) => setHidden(n), []);
  return (
    <div>
      <Legend items={[{ label: `Agent ${agentA}`, color: memberColor('a'), kind: 'line' }, { label: `Agent ${agentB}`, color: memberColor('b'), kind: 'line' }]} />
      <LineChart width={width} height={height} data={rows} margin={{ top: 16, right: 48, bottom: 28, left: 8 }}>
        <CartesianGrid stroke={gridColor()} vertical={false} />
        <XAxis dataKey="day" type="number" domain={['dataMin', 'dataMax']} stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} label={{ value: 'Day', position: 'insideBottom', offset: -18, fontSize: CHART_TEXT_PX }} />
        <YAxis stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} domain={domain} width={56} label={{ value: metric === 'trust' ? 'Trust (0 to 1)' : 'Affect (-1 to 1)', angle: -90, position: 'insideLeft', fontSize: CHART_TEXT_PX }} />
        <Tooltip content={<ArmTooltip unit={metric} />} />
        {conflicts.map((c, i) => (
          <ReferenceArea key={i} x1={c.started_day} x2={(c.ended_day ?? daily[daily.length - 1]?.day ?? c.started_day) + 1} fill="var(--treatment)" fillOpacity={0.1} stroke="none" />
        ))}
        <Line dataKey="a" name={`Agent ${agentA}`} stroke={memberColor('a')} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="b" name={`Agent ${agentB}`} stroke={memberColor('b')} strokeWidth={2} dot={false} isAnimationActive={false} />
        {markers.map((m) => (
          <ReferenceDot
            key={m.key}
            x={m.day}
            y={m.y}
            r={5}
            fill="var(--ink)"
            stroke="var(--surface)"
            strokeWidth={2}
            shape={(p) => (
              <circle cx={p.cx} cy={p.cy} r={5} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} data-testid="marker-dot">
                <title>{`Day ${m.day}: ${m.text}`}</title>
              </circle>
            )}
          />
        ))}
        <MarkerLabels markers={markers} onHidden={onHidden} />
      </LineChart>
      <p className="muted">
        Shaded spans are open conflicts. Dots mark state transitions.
        {hidden > 0 ? ` Where they crowd, ${hidden} ${hidden === 1 ? 'dot goes' : 'dots go'} unnamed; the Events list below names every one.` : ''}
      </p>
    </div>
  );
}

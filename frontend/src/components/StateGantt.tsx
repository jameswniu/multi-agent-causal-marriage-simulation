import type { DailyRow, RelState } from '../types';
import { stateColor, inkColor } from '../palette';
import Legend from './Legend';

export interface Segment {
  state: RelState;
  start: number;
  end: number;
  inConflict: boolean;
}

/** Collapse a daily series into contiguous (state, in_conflict) segments. */
export function buildSegments(daily: DailyRow[]): Segment[] {
  const rows = [...daily].sort((a, b) => a.day - b.day);
  const out: Segment[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.state === r.state && last.inConflict === r.in_conflict && last.end === r.day - 1) {
      last.end = r.day;
    } else {
      out.push({ state: r.state, start: r.day, end: r.day, inConflict: r.in_conflict });
    }
  }
  return out;
}

const STATE_LABEL: Record<RelState, string> = {
  married: 'Married',
  dating: 'Dating',
  separated: 'Separated',
  divorced: 'Divorced',
  broken_up: 'Broken up',
};

export default function StateGantt({ daily, width, lastDay }: { daily: DailyRow[]; width: number; lastDay: number }) {
  const segments = buildSegments(daily);
  const left = 8;
  const plotW = Math.max(100, width - left - 8);
  const span = Math.max(1, lastDay + 1);
  const x = (d: number) => left + (d / span) * plotW;
  const h = 26;
  const ink = inkColor();
  const seen = new Set(segments.map((s) => s.state));
  return (
    <div>
      <Legend items={[...seen].map((s) => ({ label: STATE_LABEL[s], color: stateColor(s) }))} />
      <svg width={width} height={h + 34} role="img" aria-label="Relationship state timeline" style={{ maxWidth: '100%' }}>
        {segments.map((s, i) => (
          <rect
            key={i}
            data-testid="gantt-segment"
            x={x(s.start)}
            y={6}
            width={Math.max(1, x(s.end + 1) - x(s.start) - 1)}
            height={h}
            rx={3}
            fill={stateColor(s.state)}
            fillOpacity={s.inConflict ? 1 : 0.55}
          >
            <title>{`${STATE_LABEL[s.state]}${s.inConflict ? ', in conflict' : ''}: day ${s.start} to ${s.end}`}</title>
          </rect>
        ))}
        {[0, Math.floor(lastDay / 2), lastDay].map((d) => (
          <text key={d} x={d === lastDay ? x(d + 1) : x(d)} y={h + 26} fontSize={14} fill={ink} textAnchor={d === 0 ? 'start' : d === lastDay ? 'end' : 'middle'} data-testid="gantt-label">
            {`Day ${d}`}
          </text>
        ))}
      </svg>
      <p className="muted">Solid fill marks days in open conflict; lighter fill is calm.</p>
    </div>
  );
}

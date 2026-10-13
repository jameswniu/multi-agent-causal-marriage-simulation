import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import type { Histogram as HistogramData } from '../types';
import { armColor, gridColor, axisColor } from '../palette';
import { useArmLabels } from '../arms';
import Legend from './Legend';
import { CHART_TEXT_PX } from '../chartText';

interface Props {
  data: HistogramData;
  width: number;
  height: number;
  xLabel: string;
}

export function toRows(data: HistogramData) {
  return data.bins.map((b, i) => ({ bin: b, control: data.control[i] ?? 0, treatment: data.treatment[i] ?? 0 }));
}

function HistTooltip({ active, label, payload }: { active?: boolean; label?: string | number; payload?: { name?: string; value?: number; color?: string }[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="muted">Bin {String(label)}</div>
      {payload.map((p, i) => (
        <div key={i}>
          <span className="swatch" style={{ background: p.color }} aria-hidden="true" />
          <span className="v">{((p.value ?? 0) * 100).toFixed(1)}%</span> <span className="muted">{p.name}</span>
        </div>
      ))}
    </div>
  );
}

export default function Histogram({ data, width, height, xLabel }: Props) {
  const rows = toRows(data);
  const labels = useArmLabels();
  return (
    <div>
      <Legend items={[{ label: labels.control.plain, color: armColor('control') }, { label: labels.treatment.plain, color: armColor('treatment') }]} />
      <p className="muted" style={{ margin: '0 0 0.4rem' }}>{labels.control.small}; {labels.treatment.small}</p>
      <BarChart width={width} height={height} data={rows} margin={{ top: 8, right: 16, bottom: 28, left: 8 }} barGap={2} barCategoryGap="25%">
        <CartesianGrid stroke={gridColor()} vertical={false} />
        <XAxis dataKey="bin" stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} label={{ value: xLabel, position: 'insideBottom', offset: -18, fontSize: CHART_TEXT_PX }} />
        <YAxis stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} width={56} label={{ value: 'Share', angle: -90, position: 'insideLeft', fontSize: CHART_TEXT_PX }} />
        <Tooltip content={<HistTooltip />} cursor={{ fill: 'var(--grid)', opacity: 0.4 }} />
        <Bar dataKey="control" name={labels.control.plain} fill={armColor('control')} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="treatment" name={labels.treatment.plain} fill={armColor('treatment')} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </div>
  );
}

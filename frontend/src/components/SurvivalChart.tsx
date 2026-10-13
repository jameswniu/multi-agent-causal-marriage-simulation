import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { ArmSeries } from '../types';
import { armColor, gridColor, axisColor } from '../palette';
import { useArmLabels } from '../arms';
import ArmTooltip from './ArmTooltip';
import Legend from './Legend';
import { CHART_TEXT_PX } from '../chartText';

interface Props {
  series: ArmSeries;
  width: number;
  height: number;
  yLabel: string;
  unit?: string;
  step?: boolean;
  domain?: [number, number];
}

export function toRows(series: ArmSeries) {
  return series.day.map((d, i) => ({ day: d, control: series.control[i], treatment: series.treatment[i] }));
}

export default function SurvivalChart({ series, width, height, yLabel, unit, step, domain }: Props) {
  const rows = toRows(series);
  const labels = useArmLabels();
  return (
    <div>
      <Legend items={[{ label: labels.control.plain, color: armColor('control'), kind: 'line' }, { label: labels.treatment.plain, color: armColor('treatment'), kind: 'line' }]} />
      <p className="muted" style={{ margin: '0 0 0.4rem' }}>{labels.control.small}; {labels.treatment.small}</p>
      <LineChart width={width} height={height} data={rows} margin={{ top: 12, right: 16, bottom: 28, left: 8 }}>
        <CartesianGrid stroke={gridColor()} vertical={false} />
        <XAxis dataKey="day" stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} label={{ value: 'Day', position: 'insideBottom', offset: -18, fontSize: CHART_TEXT_PX }} />
        <YAxis stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} domain={domain ?? ['auto', 'auto']} width={56} label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: CHART_TEXT_PX }} />
        <Tooltip content={<ArmTooltip unit={unit} />} />
        <Line type={step ? 'stepAfter' : 'monotone'} dataKey="control" name={labels.control.plain} stroke={armColor('control')} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type={step ? 'stepAfter' : 'monotone'} dataKey="treatment" name={labels.treatment.plain} stroke={armColor('treatment')} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </div>
  );
}

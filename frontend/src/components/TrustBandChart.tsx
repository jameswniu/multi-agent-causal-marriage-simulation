import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';
import type { BandSeries } from '../types';
import { armColor, gridColor, axisColor } from '../palette';
import { useArmLabels } from '../arms';
import ArmTooltip from './ArmTooltip';
import Legend from './Legend';
import { CHART_TEXT_PX } from '../chartText';

export function toRows(series: BandSeries) {
  return series.day.map((d, i) => ({
    day: d,
    control: series.control_mean[i],
    controlBand: [series.control_lo[i], series.control_hi[i]] as [number, number],
    treatment: series.treatment_mean[i],
    treatmentBand: [series.treatment_lo[i], series.treatment_hi[i]] as [number, number],
  }));
}

export default function TrustBandChart({ series, width, height }: { series: BandSeries; width: number; height: number }) {
  const rows = toRows(series);
  const labels = useArmLabels();
  return (
    <div>
      <Legend items={[{ label: `${labels.control.plain} (mean, 95% band)`, color: armColor('control'), kind: 'line' }, { label: `${labels.treatment.plain} (mean, 95% band)`, color: armColor('treatment'), kind: 'line' }]} />
      <p className="muted" style={{ margin: '0 0 0.4rem' }}>{labels.control.small}; {labels.treatment.small}</p>
      <ComposedChart width={width} height={height} data={rows} margin={{ top: 12, right: 16, bottom: 28, left: 8 }}>
        <CartesianGrid stroke={gridColor()} vertical={false} />
        <XAxis dataKey="day" stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} label={{ value: 'Day', position: 'insideBottom', offset: -18, fontSize: CHART_TEXT_PX }} />
        <YAxis stroke={axisColor()} tick={{ fontSize: CHART_TEXT_PX }} domain={[0, 1]} width={56} label={{ value: 'Trust (0 to 1)', angle: -90, position: 'insideLeft', fontSize: CHART_TEXT_PX }} />
        <Tooltip content={<ArmTooltip unit="trust" />} />
        <Area dataKey="controlBand" name="Control band" stroke="none" fill={armColor('control')} fillOpacity={0.12} isAnimationActive={false} />
        <Area dataKey="treatmentBand" name="Treatment band" stroke="none" fill={armColor('treatment')} fillOpacity={0.12} isAnimationActive={false} />
        <Line dataKey="control" name={labels.control.plain} stroke={armColor('control')} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="treatment" name={labels.treatment.plain} stroke={armColor('treatment')} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </div>
  );
}

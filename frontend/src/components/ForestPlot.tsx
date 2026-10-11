import type { Outcome } from '../types';
import { fmtCiValue, fmtSignedValue } from '../format';
import { inkColor, axisColor } from '../palette';

/**
 * One row per outcome, each on its own symmetric scale around zero (outcomes carry different
 * units, so a shared axis would mislead). The whisker is the CI, the dot the point estimate.
 */
export default function ForestPlot({ outcomes, width }: { outcomes: Outcome[]; width: number }) {
  const rowH = 34;
  const labelW = Math.min(260, Math.max(160, width * 0.38));
  const plotW = Math.max(120, width - labelW - 90);
  const height = outcomes.length * rowH + 24;
  const ink = inkColor();
  const axis = axisColor();
  return (
    <svg width={width} height={height} role="img" aria-label="Forest plot of treatment effects" style={{ maxWidth: '100%' }}>
      {outcomes.map((o, i) => {
        const y = 12 + i * rowH + rowH / 2;
        if (o.ate === null || o.ci_low === null || o.ci_high === null) {
          return (
            <g key={o.name} data-testid="forest-row">
              <text x={0} y={y + 5} fontSize={14} fill={ink}>
                {truncate(o.label, Math.floor(labelW / 7.5))}
              </text>
              <text x={labelW} y={y + 5} fontSize={14} fill={ink}>
                not estimable in this run
              </text>
            </g>
          );
        }
        const span = Math.max(Math.abs(o.ci_low), Math.abs(o.ci_high), Math.abs(o.ate), 1e-9) * 1.15;
        const x = (v: number) => labelW + plotW / 2 + (v / span) * (plotW / 2);
        return (
          <g key={o.name} data-testid="forest-row">
            <text x={0} y={y + 5} fontSize={14} fill={ink}>
              {truncate(o.label, Math.floor(labelW / 7.5))}
            </text>
            <line x1={x(0)} x2={x(0)} y1={y - rowH / 2 + 4} y2={y + rowH / 2 - 4} stroke={axis} strokeWidth={1} />
            <line x1={x(o.ci_low)} x2={x(o.ci_high)} y1={y} y2={y} stroke={ink} strokeWidth={2} strokeLinecap="round">
              <title>{`${o.label}: ${fmtSignedValue(o.ate, o.unit)} ${fmtCiValue(o.ci_low, o.ci_high, o.unit)} ${o.unit}`}</title>
            </line>
            <circle cx={x(o.ate)} cy={y} r={5} fill={o.ate >= 0 ? 'var(--treatment)' : 'var(--control)'} stroke="var(--surface)" strokeWidth={2} />
            <text x={labelW + plotW + 8} y={y + 5} fontSize={14} fill={ink}>
              {fmtSignedValue(o.ate, o.unit)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

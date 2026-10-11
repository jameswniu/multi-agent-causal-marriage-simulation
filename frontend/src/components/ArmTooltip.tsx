import type { TooltipContentProps } from 'recharts';
import { safeFixed } from '../format';

interface Entry {
  name?: string | number;
  value?: number | string | ReadonlyArray<number | string>;
  color?: string;
}

/** Value-first tooltip rows keyed by a short line of the series colour. */
export default function ArmTooltip({ active, label, payload, unit, digits = 3 }: Partial<TooltipContentProps<number, string>> & { unit?: string; digits?: number }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="tooltip">
      <div className="muted">Day {String(label)}</div>
      {(payload as unknown as Entry[]).map((p, i) => {
        const v = Array.isArray(p.value) ? (p.value as number[]).map((x) => safeFixed(Number(x), digits)).join(' to ') : safeFixed(Number(p.value), digits);
        return (
          <div key={i}>
            <span className="linekey" style={{ color: p.color }} aria-hidden="true" />
            <span className="v">{v}</span> {unit ? <span className="muted">{unit}</span> : null} <span className="muted">{String(p.name)}</span>
          </div>
        );
      })}
    </div>
  );
}

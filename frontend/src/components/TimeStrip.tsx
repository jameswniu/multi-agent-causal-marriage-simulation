// The density strip under the day scrubber of a simulated trial of married couples, split into a
// control arm and a treatment arm. Each arm gets one row with a bar for the conflicts that started
// each day, ticks for separations and divorces, a shaded band while each shock is active, and a
// cursor on today. Clicking the strip jumps the replay to that day.
import { memo, useMemo, type MouseEvent } from 'react';
import type { Density, ShockBand } from '../town/timebar';

const ROW = 20;
const H = ROW * 2;
const BAND_FILL: Record<ShockBand['target'], string> = { control: 'var(--control)', treatment: 'var(--treatment)', all: 'var(--muted)' };

interface Props {
  days: number;
  day: number;
  density: Density;
  bands: ShockBand[];
  controlTitle: string;
  treatmentTitle: string;
  onSeek: (day: number) => void;
}

function bars(series: number[], max: number, bottom: number, height: number): string {
  let d = '';
  series.forEach((c, x) => {
    if (c <= 0) return;
    const h = Math.max(1.5, (height * c) / max).toFixed(2);
    d += `M${x},${bottom}v-${h}h1v${h}z`;
  });
  return d;
}

function ticks(series: number[], top: number, height: number): string {
  let d = '';
  series.forEach((c, x) => {
    if (c > 0) d += `M${x},${top}h1v${height}h-1z`;
  });
  return d;
}

/** The parts of the strip that only change with the run, drawn once. */
const StripBody = memo(function StripBody({ days, density, bands }: { days: number; density: Density; bands: ShockBand[] }) {
  const paths = useMemo(
    () => ({
      cConf: bars(density.control.conflicts, density.maxConflicts, ROW - 1, ROW - 7),
      tConf: bars(density.treatment.conflicts, density.maxConflicts, H - 1, ROW - 7),
      cSep: ticks(density.control.separations, 1, 2.5),
      tSep: ticks(density.treatment.separations, ROW + 1, 2.5),
      cDiv: ticks(density.control.divorces, 4, 2.5),
      tDiv: ticks(density.treatment.divorces, ROW + 4, 2.5),
    }),
    [density],
  );
  return (
    <>
      {bands.map((b, i) => (
        <rect
          key={i}
          x={b.start}
          y={b.target === 'treatment' ? ROW : 0}
          width={Math.max(1, b.end - b.start + 1)}
          height={b.target === 'all' ? H : ROW}
          fill={BAND_FILL[b.target]}
          fillOpacity={0.18}
          data-testid="shock-band"
        >
          <title>{`${b.label}, days ${b.start} to ${b.end}`}</title>
        </rect>
      ))}
      <line x1={0} x2={days} y1={ROW} y2={ROW} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <path d={paths.cConf} fill="var(--control)" fillOpacity={0.6} />
      <path d={paths.tConf} fill="var(--treatment)" fillOpacity={0.6} />
      <path d={paths.cSep} fill="var(--critical)" />
      <path d={paths.tSep} fill="var(--critical)" />
      <path d={paths.cDiv} fill="var(--ink)" />
      <path d={paths.tDiv} fill="var(--ink)" />
    </>
  );
});

export default function TimeStrip({ days, day, density, bands, controlTitle, treatmentTitle, onSeek }: Props) {
  const n = Math.max(1, days);
  const seek = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    onSeek(Math.min(n - 1, Math.floor(frac * n)));
  };
  const busiest = (s: number[]) => s.reduce((p, q) => Math.max(p, q), 0);
  const shocksPart = bands.length ? `, and ${bands.length} shock ${bands.length === 1 ? 'band' : 'bands'}` : '';
  const label = `Events per day for each arm over the run: at most ${busiest(density.control.conflicts)} conflicts started in a day for ${controlTitle}, ${busiest(density.treatment.conflicts)} for ${treatmentTitle}${shocksPart}. Click to jump to a day.`;
  return (
    <div className="timestrip" data-testid="timestrip">
      <div className="timestrip-labels" aria-hidden="true">
        <span title={controlTitle}>
          <span className="swatch" style={{ background: 'var(--control)' }} />
          Control
        </span>
        <span title={treatmentTitle}>
          <span className="swatch" style={{ background: 'var(--treatment)' }} />
          Treatment
        </span>
      </div>
      <svg viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} onClick={seek} className="timestrip-svg">
        <StripBody days={n} density={density} bands={bands} />
        <rect x={Math.min(day, n - 1)} y={0} width={Math.max(1, n / 300)} height={H} fill="var(--ink)" data-testid="timestrip-cursor" />
      </svg>
      <p className="muted timestrip-key">
        Bars are conflicts started each day, red ticks separations, dark ticks divorces, and a shaded band means a shock is active. Click to jump to a day.
      </p>
    </div>
  );
}

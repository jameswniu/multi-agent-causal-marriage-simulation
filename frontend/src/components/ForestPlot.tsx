// The Overview's forest plot: each outcome's average treatment effect (treatment minus control) as a dot on its
// own scale centred on zero, with its confidence interval as a whisker and the effect written beside it. Every
// outcome's name is written in full: in a column left of the whiskers when the widest name fits there, else, on
// a narrow screen, on its own lines above its whisker.
import type { Outcome } from '../types';
import { fmtCiValue, fmtSignedValue } from '../format';
import { inkColor, axisColor } from '../palette';
import { CHART_TEXT_PX } from '../chartText';

/** Height of a row's whisker, and of a whole row when the names sit in a column beside the whiskers. */
const ROW_H = 34;
/** Height of one line of a name written above its whisker. */
const LINE_H = 20;

/** Where one outcome goes: its name's lines and the baseline of the first, and the height of its whisker. */
export interface ForestRow {
  lines: string[];
  nameY: number;
  y: number;
}

/** The plot's layout at one width: the name column (0 when names sit above the whiskers), the whisker plot and each row. */
export interface ForestLayout {
  stacked: boolean;
  labelW: number;
  plotW: number;
  rows: ForestRow[];
  height: number;
}

/** A character of chart text is about 0.54 of its size wide, so 8.6px at 16px. */
const CHAR_W = (7.5 / 14) * CHART_TEXT_PX;

/** A name split at its spaces into lines of at most `max` characters; a longer word keeps a line to itself. */
export function wrapWords(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Lays the plot out for its width. The name column is as wide as the widest name, so no name is cut, as long as
 * that leaves the whiskers most of the width. When it would not, as on a phone, each name goes on its own lines
 * above its whisker, wrapped at its spaces, and the whiskers take the whole width.
 */
export function forestLayout(labels: string[], width: number): ForestLayout {
  // Room for each row's effect, such as +76.8%, written right of its interval: about twelve characters.
  const valueW = Math.round(12 * CHAR_W);
  const nameW = Math.ceil(Math.max(0, ...labels.map((l) => l.length)) * CHAR_W) + 8;
  if (nameW <= Math.max(160, width * 0.45)) {
    const rows = labels.map((label, i) => {
      const y = 12 + i * ROW_H + ROW_H / 2;
      return { lines: [label], nameY: y + 5, y };
    });
    return { stacked: false, labelW: nameW, plotW: Math.max(120, width - nameW - valueW), rows, height: labels.length * ROW_H + 24 };
  }
  const maxChars = Math.max(8, Math.floor(width / CHAR_W));
  let top = 4;
  const rows = labels.map((label) => {
    const lines = wrapWords(label, maxChars);
    const nameY = top + LINE_H - 4;
    const y = top + lines.length * LINE_H + ROW_H / 2 - 4;
    top = y + ROW_H / 2 + 6;
    return { lines, nameY, y };
  });
  return { stacked: true, labelW: 0, plotW: Math.max(120, width - valueW), rows, height: top + 4 };
}

/**
 * One row per outcome, each on its own symmetric scale around zero (outcomes carry different
 * units, so a shared axis would mislead). The whisker is the CI, the dot the point estimate.
 */
export default function ForestPlot({ outcomes, width }: { outcomes: Outcome[]; width: number }) {
  const layout = forestLayout(
    outcomes.map((o) => o.label),
    width,
  );
  const { labelW, plotW } = layout;
  const ink = inkColor();
  const axis = axisColor();
  return (
    <svg width={width} height={layout.height} role="img" aria-label="Forest plot of treatment effects" style={{ maxWidth: '100%' }}>
      {outcomes.map((o, i) => {
        const { lines, nameY, y } = layout.rows[i];
        const name = (
          <text x={0} y={nameY} fontSize={CHART_TEXT_PX} fill={ink} data-testid="forest-name">
            {lines.map((line, j) => (
              <tspan key={j} x={0} dy={j === 0 ? 0 : LINE_H}>
                {line}
              </tspan>
            ))}
          </text>
        );
        if (o.ate === null || o.ci_low === null || o.ci_high === null) {
          return (
            <g key={o.name} data-testid="forest-row">
              {name}
              <text x={labelW} y={y + 5} fontSize={CHART_TEXT_PX} fill={ink}>
                not estimable in this run
              </text>
            </g>
          );
        }
        const span = Math.max(Math.abs(o.ci_low), Math.abs(o.ci_high), Math.abs(o.ate), 1e-9) * 1.15;
        const x = (v: number) => labelW + plotW / 2 + (v / span) * (plotW / 2);
        return (
          <g key={o.name} data-testid="forest-row">
            {name}
            <line x1={x(0)} x2={x(0)} y1={y - ROW_H / 2 + 4} y2={y + ROW_H / 2 - 4} stroke={axis} strokeWidth={1} />
            <line x1={x(o.ci_low)} x2={x(o.ci_high)} y1={y} y2={y} stroke={ink} strokeWidth={2} strokeLinecap="round">
              <title>{`${o.label}: ${fmtSignedValue(o.ate, o.unit)} ${fmtCiValue(o.ci_low, o.ci_high, o.unit)} ${o.unit}`}</title>
            </line>
            <circle cx={x(o.ate)} cy={y} r={5} fill={o.ate >= 0 ? 'var(--treatment)' : 'var(--control)'} stroke="var(--surface)" strokeWidth={2} />
            <text x={labelW + plotW + 8} y={y + 5} fontSize={CHART_TEXT_PX} fill={ink}>
              {fmtSignedValue(o.ate, o.unit)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

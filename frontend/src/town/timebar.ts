// Pure helpers behind the LoveWorld World page's time bar: the day label, the density strip's
// per-day series by arm, the bands that show when each shock is active, the inspected couple's next
// event, and the day's counts the ticker shows while the replay plays.
import type { Catalog } from '../arms';
import type { DayDigest, EventRow, ShockSpec } from '../types';

/** Events kept out of a viewer's lists: memory housekeeping, logged for the developer view. */
export const HOUSEKEEPING = new Set(['memory_consolidated']);

/** "Day 143, week 21": the day as logged, and the week of the run it falls in (week 1 is days 0 to 6). */
export function dayLabel(day: number): string {
  const d = Math.max(0, Math.floor(day));
  return `Day ${d}, week ${Math.floor(d / 7) + 1}`;
}

export interface ArmSeries {
  conflicts: number[];
  separations: number[];
  divorces: number[];
}

export interface Density {
  control: ArmSeries;
  treatment: ArmSeries;
  /** Largest daily count of conflicts started in either arm, at least 1. */
  maxConflicts: number;
  /** Largest daily count of separations or divorces in either arm, at least 1. */
  maxMarks: number;
}

const STRIP_KINDS = { conflicts: 'conflict_started', separations: 'separated', divorces: 'divorced' } as const;

/** Conflicts started, separations and divorces per day for each arm, from the run's day digest. */
export function densitySeries(digest: DayDigest | null, days: number): Density {
  const n = Math.max(0, days);
  const pick = (kind: string, group: 'control' | 'treatment'): number[] => {
    const arr = digest?.kinds[kind]?.[group] ?? [];
    return Array.from({ length: n }, (_, d) => arr[d] ?? 0);
  };
  const arm = (group: 'control' | 'treatment'): ArmSeries => ({
    conflicts: pick(STRIP_KINDS.conflicts, group),
    separations: pick(STRIP_KINDS.separations, group),
    divorces: pick(STRIP_KINDS.divorces, group),
  });
  const control = arm('control');
  const treatment = arm('treatment');
  let maxConflicts = 1;
  let maxMarks = 1;
  for (let d = 0; d < n; d++) {
    maxConflicts = Math.max(maxConflicts, control.conflicts[d], treatment.conflicts[d]);
    maxMarks = Math.max(maxMarks, control.separations[d], treatment.separations[d], control.divorces[d], treatment.divorces[d]);
  }
  return { control, treatment, maxConflicts, maxMarks };
}

export interface ShockBand {
  start: number;
  end: number;
  target: 'control' | 'treatment' | 'all';
  label: string;
}

/** The last day a shock is active, resolving an open end the way the engine does, clamped to the run. */
export function shockEnd(s: ShockSpec, catalog: Catalog | null | undefined, days: number): number {
  const last = Math.max(0, days - 1);
  let end = s.end_day;
  if (end == null) {
    const k = catalog?.[s.kind];
    const len = k ? (k.default_length_days ?? (k.default_end_day != null ? k.default_end_day - k.default_start_day : null)) : null;
    end = len == null ? last : s.start_day + len;
  }
  return Math.min(last, Math.max(s.start_day, end));
}

/** One band per shock that starts inside the run, from its start day to its last active day. */
export function shockBands(shocks: ShockSpec[], catalog: Catalog | null | undefined, days: number, label: (s: ShockSpec) => string): ShockBand[] {
  return shocks
    .filter((s) => s.start_day < days)
    .map((s) => ({
      start: Math.max(0, s.start_day),
      end: shockEnd(s, catalog, days),
      target: s.target === 'control' || s.target === 'treatment' ? s.target : 'all',
      label: label(s),
    }));
}

/** The first day after `day` with a logged event for the couple (housekeeping aside), or null. */
export function nextEventDay(events: EventRow[], day: number): number | null {
  let best: number | null = null;
  for (const e of events) {
    if (HOUSEKEEPING.has(e.kind) || e.day <= day) continue;
    if (best === null || e.day < best) best = e.day;
  }
  return best;
}

export interface DayCount {
  kind: string;
  control: number;
  treatment: number;
  remarriage: number;
  total: number;
}

/** The day's event counts by kind and group, busiest first, housekeeping set aside and counted. */
export function countsForDay(digest: DayDigest | null, day: number): { rows: DayCount[]; housekeeping: number } {
  if (!digest) return { rows: [], housekeeping: 0 };
  const rows: DayCount[] = [];
  let housekeeping = 0;
  for (const [kind, per] of Object.entries(digest.kinds)) {
    const c = per.control?.[day] ?? 0;
    const t = per.treatment?.[day] ?? 0;
    const r = per.remarriage?.[day] ?? 0;
    const total = c + t + r;
    if (total === 0) continue;
    if (HOUSEKEEPING.has(kind)) {
      housekeeping += total;
      continue;
    }
    rows.push({ kind, control: c, treatment: t, remarriage: r, total });
  }
  rows.sort((p, q) => q.total - p.total || p.kind.localeCompare(q.kind));
  return { rows, housekeeping };
}

/** "conflict started" from "conflict_started". */
export function kindWords(kind: string): string {
  return kind.replace(/_/g, ' ');
}

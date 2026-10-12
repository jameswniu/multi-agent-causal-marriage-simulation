// A run with no intervention: both halves of the town follow identical rules. Its twins run plays every
// couple under both settings, so it can say the settings give identical results; the two halves, being
// different couples, still never come out exactly even. These words say both, the twins first.
import { hasMemoryChange } from './arms';
import type { Outcome, ShockSpec, TreatmentSpec, TwinsRun } from './types';

/**
 * True when the arms differ in nothing: the same memory, and no shock aimed at either arm alone. A shock
 * for everyone hits both halves alike, so it does not count.
 */
export function noIntervention(treatment: TreatmentSpec | null | undefined, shocks: ShockSpec[] | null | undefined): boolean {
  return !hasMemoryChange(treatment) && (shocks ?? []).every((s) => s.target === 'all');
}

/** A share as signed percentage points with one decimal: "-1.2", "+0.6", "0.0". */
export function signedPoints(x: number): string {
  const s = (x * 100).toFixed(1);
  if (s === '-0.0' || s === '0.0') return '0.0';
  return x > 0 ? `+${s}` : s;
}

/**
 * "Run on the same 1,000 couples, the two settings give identical results, and 0 of 1,000 couples end
 * differently." from the twins the run's summary links, or null without them.
 */
export function twinWords(twins: TwinsRun | null | undefined, nCouples: number): string | null {
  const paired = twins?.paired ?? [];
  if (!twins || !paired.length) return null;
  const n = (paired[0].n_pairs || nCouples).toLocaleString();
  const identical = twins.dynamics_hashes_equal === true || paired.every((r) => r.share_changed === 0);
  if (identical) return `Run on the same ${n} couples, the two settings give identical results, and 0 of ${n} couples end differently.`;
  const divorce = paired.find((r) => r.name === 'divorce_rate');
  const changed = divorce && typeof divorce.share_changed === 'number' ? Math.round(divorce.share_changed * (divorce.n_pairs || nCouples)) : null;
  if (changed === null) return `Run on the same ${n} couples, the two settings do not give identical results.`;
  return `Run on the same ${n} couples, the two settings do not give identical results, and ${changed.toLocaleString()} of ${n} couples divorce under one and not the other.`;
}

/** "divorce gap, treatment minus control, is -1.2 points, with a 95% range of -3.0 to +0.6, which includes zero." */
function gapWords(divorce: Outcome | null | undefined): string | null {
  if (!divorce || divorce.ate === null || divorce.ci_low === null || divorce.ci_high === null) return null;
  const level = Math.round((divorce.ci_level || 0.95) * 100);
  const covers = divorce.ci_low <= 0 && divorce.ci_high >= 0;
  const gap = `divorce gap, treatment minus control, is ${signedPoints(divorce.ate)} points, with a ${level}% range of ${signedPoints(divorce.ci_low)} to ${signedPoints(divorce.ci_high)}, which ${covers ? 'includes zero' : 'does not include zero'}.`;
  return covers ? gap : `${gap} With identical rules that happens by chance in about one run in ${Math.round(100 / Math.max(1, 100 - level))}.`;
}

export interface ChanceWords {
  /** The line a viewer reads first: the twins' result, or without twins, where the gap comes from. */
  lead: string;
  /** The gap between the two halves and its range, or null without an analysis. */
  detail: string | null;
}

/**
 * The words for a run with no intervention. With its twins: "Run on the same 1,000 couples, the two
 * settings give identical results, and 0 of 1,000 couples end differently.", then the two halves' gap,
 * which different couples never avoid. Without them: the halves follow identical rules, so the gap comes
 * only from splitting the couples in two, and its size.
 */
export function chanceWords(divorce: Outcome | null | undefined, nCouples: number, twins?: TwinsRun | null): ChanceWords {
  const gap = gapWords(divorce);
  const twin = twinWords(twins, nCouples);
  if (twin) {
    const halves = 'The two halves of the town are different couples, and two different groups never come out exactly even.';
    return { lead: twin, detail: gap ? `${halves} Their ${gap}` : halves };
  }
  return {
    lead: `Both halves follow identical rules, so the gap between them comes only from splitting ${nCouples.toLocaleString()} different couples in two.`,
    detail: gap ? `The ${gap}` : null,
  };
}

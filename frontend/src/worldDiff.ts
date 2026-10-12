// What differs between a forked world and the world it came from, day by day. A fork runs the very same
// couples on the very same random draws with only its added shocks, so a couple whose state differs on a
// day differs because of those shocks. Only the couples both worlds start with are compared: a couple
// formed by a remarriage can pair different people in each world, even under the same id.
import type { WorldResponse } from './types';

/** The ring around a house, or a grid tile, whose couple differs from the world this one is compared with: one colour that no arm, state or lens uses. */
export const DIFF_RING_CSS = '#ff2bd6';
/** The same colour as a number, for the town's PixiJS graphics. */
export const DIFF_RING = Number.parseInt(DIFF_RING_CSS.slice(1), 16);
/** Screen pixels the ring is drawn at, in the town at any zoom and around a grid tile. */
export const DIFF_RING_PX = 3;
/** What a ring means, in the town's legend, the grid's legend and a ringed tile's description. */
export const RING_WORDS = 'Ringed, in a different state today than in the world this one is compared with';

type Shape = Pick<WorldResponse, 'couples' | 'origin'>;

export interface CoupleMatch {
  /** For each couple of the shown world, the index of the same couple in the other world, or -1. */
  other: Int32Array;
  /** How many couples are compared: the couples both worlds start with. */
  compared: number;
}

/** Pair every starting couple of `shown` with the same couple id in `other`. */
export function matchCouples(shown: Shape, other: Shape): CoupleMatch {
  const index = new Map<number, number>();
  other.couples.forEach((id, j) => {
    if (other.origin[j] !== 'remarriage') index.set(id, j);
  });
  const out = new Int32Array(shown.couples.length).fill(-1);
  let compared = 0;
  shown.couples.forEach((id, i) => {
    if (shown.origin[i] === 'remarriage') return;
    const j = index.get(id);
    if (j === undefined) return;
    out[i] = j;
    compared += 1;
  });
  return { other: out, compared };
}

function statesOn(world: Pick<WorldResponse, 'states'>, day: number): string {
  if (!world.states.length) return '';
  return world.states[Math.min(Math.max(0, Math.floor(day)), world.states.length - 1)] ?? '';
}

/** Indices into `shown` of the couples whose state on `day` differs from the same couple's state in `other`. */
export function differingOnDay(shown: Pick<WorldResponse, 'states'>, other: Pick<WorldResponse, 'states'>, match: CoupleMatch, day: number): number[] {
  const a = statesOn(shown, day);
  const b = statesOn(other, day);
  const out: number[] = [];
  for (let i = 0; i < match.other.length; i++) {
    const j = match.other[i];
    if (j < 0) continue;
    if ((a[i] ?? '-') !== (b[j] ?? '-')) out.push(i);
  }
  return out;
}

/** Whether the parent world the API serves now is the run a fork was made from. */
export type ParentCheck = 'same' | 'rerun' | 'unknown';

/**
 * Compare the parent's determinism hash as the fork recorded it (`parent_determinism_hash` in parent.json)
 * with the one served with the parent's states and, when the experiment list gives one, the parent's hash
 * in the list, which a page left open reads again when it comes back into view. All are the engine's hash
 * of every table a run wrote, so they agree exactly when the states being compared are the ones the fork
 * started from. A parent run again under its name with anything changed no longer matches, and a hash
 * missing from parent.json or from the parent's states cannot be checked.
 */
export function checkParent(recorded: string | null | undefined, served: string | null | undefined, listed?: string | null): ParentCheck {
  if (!recorded || !served) return 'unknown';
  if (served !== recorded || (listed && listed !== recorded)) return 'rerun';
  return 'same';
}

/** The sentence shown in place of the rings and the counter when the parent is not the run the fork came from. */
export function parentNotComparedWords(check: Exclude<ParentCheck, 'same'>, parent: string): string {
  return check === 'rerun'
    ? `The world this one came from, ${parent}, was run again after the fork, so houses are not compared.`
    : `The world this one came from, ${parent}, cannot be checked against the run this one was forked from, so houses are not compared.`;
}

/** "37 of 1,000 couples differ from example today" ("1 of 1,000 couples differs"). */
export function differCounter(n: number, compared: number, parent: string): string {
  return `${n.toLocaleString()} of ${compared.toLocaleString()} couples ${n === 1 ? 'differs' : 'differ'} from ${parent} today`;
}

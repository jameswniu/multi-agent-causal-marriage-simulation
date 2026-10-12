// What differs between a forked world and the world it came from, day by day. A fork runs the very same
// couples on the very same random draws with only its added shocks, so a couple whose state differs on a
// day differs because of those shocks. Only the couples both worlds start with are compared: a couple
// formed by a remarriage can pair different people in each world, even under the same id.
import type { WorldResponse } from './types';

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

/** "37 of 1,000 couples differ from example today" ("1 of 1,000 couples differs"). */
export function differCounter(n: number, compared: number, parent: string): string {
  return `${n.toLocaleString()} of ${compared.toLocaleString()} couples ${n === 1 ? 'differs' : 'differ'} from ${parent} today`;
}

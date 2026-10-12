// Colour views for the LoveWorld town. A lens is one logged daily number per couple (trust, stress,
// grudge, warmth, satisfaction or days without warmth) that the server packs into one byte per
// couple per day; these helpers read a byte back and turn it into a colour from green (the good end)
// through yellow to red (the bad end).
import type { LensData } from '../types';

/** Byte for a couple that does not exist on that day. */
export const LENS_MISSING = 255;
/** Largest byte a value can take; 0..LENS_TOP spans the lens range. */
export const LENS_TOP = 254;

// The ends and middle of the ramp come from the dashboard's own palette: dating green, conflict
// yellow and the critical red.
const GOOD: [number, number, number] = [0x1b, 0xaf, 0x7a];
const MID: [number, number, number] = [0xf6, 0xc9, 0x45];
const BAD: [number, number, number] = [0xd0, 0x3b, 0x3b];
/** Colour of a house whose couple does not exist that day under a lens. */
export const LENS_EMPTY = 0xb4b4b4;

/** The byte for world index `idx` on `day`, clamped to the run, or LENS_MISSING out of range. */
export function lensByte(data: LensData, day: number, idx: number): number {
  if (idx < 0 || idx >= data.couples || data.days === 0) return LENS_MISSING;
  const d = Math.min(Math.max(0, day), data.days - 1);
  return data.bytes[d * data.couples + idx] ?? LENS_MISSING;
}

/** The value a byte stands for, or null when missing. */
export function lensValue(b: number, lo: number, hi: number): number | null {
  if (b === LENS_MISSING) return null;
  return lo + (Math.min(b, LENS_TOP) / LENS_TOP) * (hi - lo);
}

/** Where a byte sits between the good end (0) and the bad end (1), or null when missing. */
export function badness(b: number, worseHigh: boolean): number | null {
  if (b === LENS_MISSING) return null;
  const t = Math.min(b, LENS_TOP) / LENS_TOP;
  return worseHigh ? t : 1 - t;
}

function mix(a: [number, number, number], b: [number, number, number], t: number): number {
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

/** Green at 0, yellow at 0.5, red at 1, as a 0xRRGGBB number. */
export function rampColor(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u <= 0.5 ? mix(GOOD, MID, u / 0.5) : mix(MID, BAD, (u - 0.5) / 0.5);
}

/** The colour of a house under a lens, or LENS_EMPTY when the couple does not exist that day. */
export function lensColor(b: number, worseHigh: boolean): number {
  const t = badness(b, worseHigh);
  return t === null ? LENS_EMPTY : rampColor(t);
}

/** A 0xRRGGBB number as a CSS hex colour. */
export function cssColor(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** The mean value of a lens over some couples on one day (missing couples skipped), or null. */
export function meanValue(data: LensData, day: number, indices: number[]): number | null {
  let sum = 0;
  let count = 0;
  for (const i of indices) {
    const v = lensValue(lensByte(data, day, i), data.lo, data.hi);
    if (v === null) continue;
    sum += v;
    count += 1;
  }
  return count ? sum / count : null;
}

/** "0.84" for ranges up to a few units, "12" for day counts. */
export function fmtLens(v: number, hi: number): string {
  return hi > 5 ? String(Math.round(v)) : v.toFixed(2);
}

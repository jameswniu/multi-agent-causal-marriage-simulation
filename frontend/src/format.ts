// Number formatting shared by tables, tiles and tooltips.

export function fmt(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  if (Math.abs(x) >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return x.toFixed(digits);
}

export function fmtShare(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

export function fmtP(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return 'n/a';
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

export function fmtCi(lo: number, hi: number, digits = 3): string {
  return `[${fmt(lo, digits)}, ${fmt(hi, digits)}]`;
}

/** Digits that suit an outcome's scale: shares get 3, days get 1, counts get 2. */
export function digitsFor(unit: string): number {
  if (unit.startsWith('share')) return 3;
  if (unit === 'days' || unit.includes('per year')) return 2;
  return 3;
}

export function fmtValue(x: number | null | undefined, unit: string): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  if (unit.startsWith('share')) return fmtShare(x);
  return fmt(x, digitsFor(unit));
}

export function shortHash(h: string | undefined | null, n = 12): string {
  if (!h) return 'n/a';
  return h.slice(0, n);
}

/** Unit-aware interval: percent outcomes show percent endpoints. */
export function fmtCiValue(lo: number | null | undefined, hi: number | null | undefined, unit: string): string {
  if (lo === null || lo === undefined || hi === null || hi === undefined) return 'n/a';
  return `[${fmtValue(lo, unit)}, ${fmtValue(hi, unit)}]`;
}

export function fmtSignedValue(x: number | null | undefined, unit: string): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  return (x > 0 ? '+' : '') + fmtValue(x, unit);
}

/** toFixed that tolerates null, undefined and NaN (renders "n/a"). */
export function safeFixed(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return 'n/a';
  return Number(x).toFixed(digits);
}

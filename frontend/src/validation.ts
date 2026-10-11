// Validation for the new-experiment panel, shared by the Run button and the retry button.
import type { ShockKind, ShockMember, ShockTarget } from './types';

export interface ShockForm {
  id: number;
  kind: string;
  target: ShockTarget;
  member: ShockMember;
  start_day: number;
  end_day: number | null;
  magnitude: number;
  trait: string | null;
}

export interface RunForm {
  name: string;
  nCouples: number;
  days: number;
  treatmentHalfLife: number;
  shocks: ShockForm[];
  overwrite: boolean;
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_COUPLES = 2000;
export const MAX_DAYS = 730;

function isInt(x: number): boolean {
  return Number.isInteger(x);
}

export function isTraitKind(k: ShockKind | undefined): boolean {
  return !!k?.traits && k.traits.length > 0;
}

/** Every problem with the form, in plain words; an empty list means it can run. */
export function validateRun(form: RunForm, kinds: ShockKind[]): string[] {
  const errors: string[] = [];
  const name = form.name.trim();
  if (!NAME_PATTERN.test(name)) errors.push('Name must start with a letter or digit and use only letters, digits, dashes and underscores (up to 64 characters).');
  if (!isInt(form.nCouples) || form.nCouples < 1 || form.nCouples > MAX_COUPLES) errors.push(`Couples must be a whole number from 1 to ${MAX_COUPLES.toLocaleString()}.`);
  if (!isInt(form.days) || form.days < 1 || form.days > MAX_DAYS) errors.push(`Days must be a whole number from 1 to ${MAX_DAYS}.`);
  if (!Number.isFinite(form.treatmentHalfLife) || form.treatmentHalfLife <= 0) errors.push('The treatment memory half-life must be a positive number of days.');
  const lastDay = isInt(form.days) ? form.days - 1 : null;
  form.shocks.forEach((s, i) => {
    const k = kinds.find((x) => x.kind === s.kind);
    const label = `Shock ${i + 1} (${k?.label ?? s.kind})`;
    if (!k) {
      errors.push(`${label}: unknown kind.`);
      return;
    }
    if (!isInt(s.start_day) || s.start_day < 0) errors.push(`${label}: start day must be a whole number from 0.`);
    else if (lastDay !== null && s.start_day > lastDay) errors.push(`${label}: start day must be inside the run (0 to ${lastDay}).`);
    if (s.end_day !== null) {
      if (!isInt(s.end_day) || s.end_day < 0) errors.push(`${label}: end day must be a whole number or empty.`);
      else if (lastDay !== null && s.end_day > lastDay) errors.push(`${label}: end day must be inside the run (0 to ${lastDay}).`);
      else if (isInt(s.start_day) && s.end_day < s.start_day) errors.push(`${label}: end day must be on or after the start day.`);
    }
    if (!Number.isFinite(s.magnitude) || s.magnitude < k.magnitude.min || s.magnitude > k.magnitude.max) {
      errors.push(`${label}: magnitude must be between ${k.magnitude.min} and ${k.magnitude.max} ${k.magnitude.unit}.`);
    }
    if (isTraitKind(k)) {
      if (!s.trait) errors.push(`${label}: choose the trait it moves.`);
      else if (!k.traits!.includes(s.trait)) errors.push(`${label}: trait must be one of ${k.traits!.join(', ')}.`);
    } else if (s.trait) {
      errors.push(`${label}: only a trait shift takes a trait.`);
    }
  });
  return errors;
}

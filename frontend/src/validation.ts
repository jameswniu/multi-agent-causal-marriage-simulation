// Validation for the new-experiment panel, shared by the Run button and the retry button.
import type { EffectCatalog, EffectSpec, ShockKind, ShockMember, ShockSpec, ShockTarget } from './types';

/** Where a shock row came from when a model translated it from the visitor's words. */
export interface ShockTranslation {
  id: string;
  text: string;
  status: 'ok' | 'invalid';
  rationale: string;
  model: string;
  errors: string[];
  /** What the model proposed, exactly as the server returned it. */
  asTranslated: ShockSpec | null;
  /** The row as it was first filled in (fields the model got wrong fall back to defaults here). */
  initial: ShockSpec;
  /** An invalid translation blocks the run until its fields change or the visitor confirms them. */
  confirmed: boolean;
}

export interface ShockForm {
  id: number;
  kind: string;
  target: ShockTarget;
  member: ShockMember;
  start_day: number;
  end_day: number | null;
  magnitude: number;
  trait: string | null;
  /** Custom shocks only: a short name, one sentence, and the effects that make the shock. */
  label?: string | null;
  description?: string | null;
  effects?: EffectSpec[] | null;
  /** Set for a row filled in from a plain-words description; the server keeps the record of it. */
  translation?: ShockTranslation;
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

/** A form row as a shock spec. */
export function rowSpec(s: ShockForm): ShockSpec {
  if (s.kind === 'custom') {
    return { kind: 'custom', target: s.target, member: s.member, start_day: s.start_day, end_day: s.end_day, magnitude: 0, label: s.label ?? '', description: s.description ?? null, effects: (s.effects ?? []).map((e) => ({ ...e })) };
  }
  return { kind: s.kind, target: s.target, member: s.member, start_day: s.start_day, end_day: s.end_day, magnitude: s.magnitude, trait: s.trait ?? null };
}

/** An effect reduced to the fields that decide what runs, for comparison. */
function effectKey(e: EffectSpec): string {
  return JSON.stringify([e.channel, e.op, e.amount, e.cadence, e.who, e.class ?? null, e.trait ?? null, e.start_day ?? null, e.end_day ?? null]);
}

/** True when two shocks would run the same way (a custom shock's description runs nothing). */
export function sameShock(a: ShockSpec, b: ShockSpec): boolean {
  const common = a.kind === b.kind && a.target === b.target && a.member === b.member && a.start_day === b.start_day && (a.end_day ?? null) === (b.end_day ?? null);
  if (!common) return false;
  if (a.kind === 'custom') {
    const ea = (a.effects ?? []).map(effectKey);
    const eb = (b.effects ?? []).map(effectKey);
    return (a.label ?? '') === (b.label ?? '') && ea.length === eb.length && ea.every((x, i) => x === eb[i]);
  }
  return a.magnitude === b.magnitude && (a.trait ?? null) === (b.trait ?? null);
}

export const LABEL_PATTERN = /^[A-Za-z0-9 _'-]+$/;

/** The name a custom shock carries in the logs, derived exactly as the engine does ("in-law move" gives in_law_move). */
export function labelSlug(label: string): string {
  let out = '';
  for (const ch of label.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) out += ch;
    else if (out && !out.endsWith('_')) out += '_';
  }
  out = out.replace(/_+$/, '');
  return out || 'custom';
}

/** Problems with a custom shock's name and effects, checked against the server's effect catalog when it has one. */
export function customProblems(s: ShockForm, label: string, effects: EffectCatalog | null | undefined, lastDay: number | null): string[] {
  const found: string[] = [];
  if (!effects) return [`${label}: custom shocks need the server's list of effect channels, which it has not sent.`];
  const name = (s.label ?? '').trim();
  const maxLabel = effects.label_max_chars;
  if (!name || name.length > maxLabel || !LABEL_PATTERN.test(name)) found.push(`${label}: the name must be 1 to ${maxLabel} letters, digits, spaces, hyphens, underscores or apostrophes.`);
  const list = s.effects ?? [];
  const maxEffects = effects.max_effects;
  if (list.length < 1 || list.length > maxEffects) found.push(`${label}: a custom shock needs 1 to ${maxEffects} effects.`);
  const shockLast = s.end_day ?? lastDay;
  list.forEach((e, j) => {
    const at = `${label}, effect ${j + 1}`;
    const ch = effects.channels.find((c) => c.channel === e.channel);
    if (!ch) {
      found.push(`${at}: unknown channel ${e.channel}.`);
      return;
    }
    if (e.op !== ch.op) found.push(`${at}: ${e.channel} must use ${ch.op}, not ${e.op}.`);
    const range = ch.cadences[e.cadence];
    if (!range) found.push(`${at}: ${e.channel} cannot act ${e.cadence}; it can act ${Object.keys(ch.cadences).join(', ')}.`);
    if (!Number.isFinite(e.amount)) found.push(`${at}: the amount must be a number.`);
    else if (range && (e.amount < range.min || e.amount > range.max)) found.push(`${at}: the amount must be between ${range.min} and ${range.max} for ${e.channel} ${e.cadence}.`);
    if (!ch.who.includes(e.who)) found.push(`${at}: ${e.channel} hits ${ch.who.join(' or ')}.`);
    if (ch.classes.length && !ch.classes.includes(e.class ?? '')) found.push(`${at}: choose the kind of memory.`);
    if (ch.traits.length && !ch.traits.includes(e.trait ?? '')) found.push(`${at}: choose the trait it moves.`);
    const start = e.start_day ?? s.start_day;
    const end = e.end_day ?? shockLast;
    if (start < s.start_day || (shockLast != null && start > shockLast)) found.push(`${at}: its start must fall inside the shock's days.`);
    if (end != null && (end < start || (shockLast != null && end > shockLast))) found.push(`${at}: its end must fall inside the shock's days.`);
  });
  return found;
}

/** True when a translated row has been changed since it was filled in. */
export function changedSinceTranslation(s: ShockForm): boolean {
  return !!s.translation && !sameShock(rowSpec(s), s.translation.initial);
}

/** How a run is checked: a fork keeps its parent's population and memory, and public mode names runs and caps them. */
export interface RunRules {
  /** The server names the run (public mode), so the name field is not checked. */
  nameAssigned?: boolean;
  /** Forking a world: its couples, days and memory come from the parent, and it needs at least one shock. */
  fork?: boolean;
  /** Why the parent's couples and days are not known yet (the list is loading, or it is not listed); blocks a fork. */
  parentProblem?: string | null;
  /** The shocks the parent world already runs; a fork keeps them, so a new custom shock must not share a logged name with one. */
  parentShocks?: ShockSpec[] | null;
  maxCouples?: number;
  maxDays?: number;
}

/** Every problem with the form, in plain words; an empty list means it can run. */
export function validateRun(form: RunForm, kinds: ShockKind[], effects?: EffectCatalog | null, rules: RunRules = {}): string[] {
  const errors: string[] = [];
  const name = form.name.trim();
  const maxCouples = rules.maxCouples ?? MAX_COUPLES;
  const maxDays = rules.maxDays ?? MAX_DAYS;
  if (!rules.nameAssigned && !NAME_PATTERN.test(name)) errors.push('Name must start with a letter or digit and use only letters, digits, dashes and underscores (up to 64 characters).');
  if (rules.fork) {
    if (rules.parentProblem) errors.push(rules.parentProblem);
    if (form.shocks.length === 0) errors.push('Add at least one shock: a forked world differs from its parent only by the shocks you add.');
  } else {
    if (!isInt(form.nCouples) || form.nCouples < 1 || form.nCouples > maxCouples) errors.push(`Couples must be a whole number from 1 to ${maxCouples.toLocaleString()}.`);
    if (!isInt(form.days) || form.days < 1 || form.days > maxDays) errors.push(`Days must be a whole number from 1 to ${maxDays}.`);
    if (!Number.isFinite(form.treatmentHalfLife) || form.treatmentHalfLife <= 0) errors.push('The treatment memory half-life must be a positive number of days.');
  }
  const lastDay = isInt(form.days) ? form.days - 1 : null;
  form.shocks.forEach((s, i) => {
    const k = kinds.find((x) => x.kind === s.kind);
    const custom = s.kind === 'custom';
    const label = `Shock ${i + 1} (${custom ? s.label || 'custom' : (k?.label ?? s.kind)})`;
    if (!k && !custom) {
      errors.push(`${label}: unknown kind.`);
      return;
    }
    if (s.translation?.status === 'invalid' && !s.translation.confirmed && !changedSinceTranslation(s)) {
      errors.push(`${label}: the model's answer did not fit the simulation; change these fields or confirm them on the card before running.`);
    }
    if (!isInt(s.start_day) || s.start_day < 0) errors.push(`${label}: start day must be a whole number from 0.`);
    else if (lastDay !== null && s.start_day > lastDay) errors.push(`${label}: start day must be inside the run (0 to ${lastDay}).`);
    if (s.end_day !== null) {
      if (!isInt(s.end_day) || s.end_day < 0) errors.push(`${label}: end day must be a whole number or empty.`);
      else if (lastDay !== null && s.end_day > lastDay) errors.push(`${label}: end day must be inside the run (0 to ${lastDay}).`);
      else if (isInt(s.start_day) && s.end_day < s.start_day) errors.push(`${label}: end day must be on or after the start day.`);
    }
    if (custom || !k) {
      errors.push(...customProblems(s, label, effects, lastDay));
      return;
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
  // Logs name a custom shock by its slug, so two custom shocks must not share one, the parent's included.
  const named = new Map<string, number>();
  const inherited = new Set<string>();
  if (rules.fork) for (const p of rules.parentShocks ?? []) if (p.kind === 'custom') inherited.add(labelSlug(p.label ?? ''));
  form.shocks.forEach((s, i) => {
    if (s.kind !== 'custom') return;
    const slug = labelSlug(s.label ?? '');
    if (inherited.has(slug)) {
      errors.push(`Shock ${i + 1} (${s.label}): its name is logged as ${slug}, the same as a custom shock the parent world already runs; give it its own name.`);
      return;
    }
    const first = named.get(slug);
    if (first === undefined) named.set(slug, i);
    else errors.push(`Shock ${i + 1} (${s.label}): its name is logged as ${slug}, the same as shock ${first + 1}; give each custom shock its own name.`);
  });
  return errors;
}

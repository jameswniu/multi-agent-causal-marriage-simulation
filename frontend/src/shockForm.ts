// Pure helpers behind the shock composer that the New experiment page and the World page's in-place
// panel share: a shock row drafted from the catalog or from a plain-words translation, the run and fork
// request bodies the server takes, and the day the new world's replay starts from.
import { shockFirstDay, type Catalog } from './arms';
import { shockEnd } from './town/timebar';
import type { ForkRequest, RunRequest, RunShock, RunTranslation, ShockKind, ShockSpec, TranslateResponse } from './types';
import { isTraitKind, rowSpec, type RunForm, type ShockForm } from './validation';

let nextId = 1;

/** Days of lead-in the replay shows before the first shock acts, so a viewer sees the town change. */
export const REPLAY_LEAD_DAYS = 10;

/** What an empty end day means for a built-in shock, resolved as the engine resolves it. A kind with a catalog length ends that many days after its start, and anything else runs to the end. */
export function openEndHint(s: ShockForm, catalog: Catalog | null, days: number): string {
  const end = shockEnd({ ...s, end_day: null }, catalog, days);
  return end >= days - 1 ? 'to the end' : `day ${end}`;
}

/**
 * The name the server gives a run sent without one, as of `when`: exp- and the UTC date and time to the second,
 * such as exp-20261014-121530, or for a fork of `parent` that parent's name, -fork- and the same time. The server
 * adds -2, -3 and so on when another run already has the name.
 */
export function defaultRunName(when: Date, parent?: string | null): string {
  const stamp = when.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return parent ? `${parent.slice(0, 36)}-fork-${stamp}` : `exp-${stamp}`;
}

/** A new row for a catalog kind, filled with the kind's defaults. */
export function draftFor(k: ShockKind): ShockForm {
  return {
    id: nextId++,
    kind: k.kind,
    target: 'treatment',
    member: 'random',
    start_day: k.default_start_day,
    end_day: k.default_end_day,
    magnitude: k.magnitude.default,
    trait: isTraitKind(k) ? k.traits![0] : null,
  };
}

/** A custom shock row from a translation: the model's name, sentence and effects, editable before it runs. */
function customRow(res: TranslateResponse, text: string): ShockForm | null {
  const spec = res.spec;
  if (!spec || res.status === 'unsupported') return null;
  const row: ShockForm = {
    id: nextId++,
    kind: 'custom',
    target: spec.target === 'all' ? 'all' : 'treatment',
    member: spec.member === 'a' || spec.member === 'b' ? spec.member : 'random',
    start_day: typeof spec.start_day === 'number' ? spec.start_day : 0,
    end_day: typeof spec.end_day === 'number' ? spec.end_day : null,
    magnitude: 0,
    trait: null,
    label: spec.label ?? '',
    description: spec.description ?? null,
    effects: (spec.effects ?? []).map((e) => ({ ...e })),
  };
  row.translation = translationOf(res, text, spec, row);
  return row;
}

/** Where a row came from: the visitor's words, the server's answer, and whether it was a saved translation reused. */
function translationOf(res: TranslateResponse, text: string, spec: ShockSpec, row: ShockForm): NonNullable<ShockForm['translation']> {
  return {
    id: res.translation_id,
    text,
    status: res.status === 'invalid' ? 'invalid' : 'ok',
    rationale: res.rationale,
    model: res.model,
    errors: res.errors,
    asTranslated: spec,
    initial: rowSpec(row),
    confirmed: res.status !== 'invalid',
    reused: res.reused === true,
    recorded: res.recorded ?? null,
  };
}

/** A shock row filled in from a translation, keeping the kind's defaults for anything the model left out. */
export function rowFromTranslation(res: TranslateResponse, text: string, kinds: ShockKind[]): ShockForm | null {
  const spec = res.spec;
  if (spec?.kind === 'custom') return customRow(res, text);
  const k = spec ? kinds.find((x) => x.kind === spec.kind) : undefined;
  if (!spec || !k || res.status === 'unsupported') return null;
  const row: ShockForm = {
    ...draftFor(k),
    target: spec.target === 'all' ? 'all' : 'treatment',
    member: spec.member === 'a' || spec.member === 'b' ? spec.member : 'random',
    start_day: typeof spec.start_day === 'number' ? spec.start_day : k.default_start_day,
    end_day: typeof spec.end_day === 'number' ? spec.end_day : null,
    magnitude: typeof spec.magnitude === 'number' ? spec.magnitude : k.magnitude.default,
    trait: isTraitKind(k) ? (spec.trait ?? null) : null,
  };
  // Fields the model got wrong fall back to defaults above; the row remembers how it started, so an
  // invalid answer cannot run until something changes or the visitor confirms it on the card.
  row.translation = translationOf(res, text, spec, row);
  return row;
}

/** One shock as the server takes it: the trait rides along only for a trait kind, and a custom shock carries its label and effects. */
function shockFields(s: ShockForm, kinds: ShockKind[]): RunShock {
  if (s.kind === 'custom') {
    const out: RunShock = { kind: 'custom', member: s.member, start_day: s.start_day, end_day: s.end_day, label: (s.label ?? '').trim(), effects: (s.effects ?? []).map((e) => ({ ...e })) };
    return s.description ? { ...out, description: s.description } : out;
  }
  const k = kinds.find((x) => x.kind === s.kind);
  const base: RunShock = { kind: s.kind, member: s.member, start_day: s.start_day, end_day: s.end_day, magnitude: s.magnitude };
  return isTraitKind(k) ? { ...base, trait: s.trait } : base;
}

/** Treatment shocks first, then world shocks: the order the server counts shock_index in. */
function orderedShocks(form: RunForm): ShockForm[] {
  return [...form.shocks.filter((s) => s.target === 'treatment'), ...form.shocks.filter((s) => s.target === 'all')];
}

function translationPointers(ordered: ShockForm[]): RunTranslation[] {
  return ordered.flatMap((s, i) => (s.translation ? [{ translation_id: s.translation.id, shock_index: i }] : []));
}

/** The request body: the target decides treatment versus world. A server that names runs gets no name. */
export function buildRequest(form: RunForm, kinds: ShockKind[], opts: { nameAssigned?: boolean } = {}): RunRequest {
  const treatmentShocks = form.shocks.filter((s) => s.target === 'treatment').map((s) => shockFields(s, kinds));
  const worldShocks = form.shocks.filter((s) => s.target === 'all').map((s) => shockFields(s, kinds));
  const req: RunRequest = {
    ...(opts.nameAssigned ? {} : { name: form.name.trim() }),
    n_couples: form.nCouples,
    days: form.days,
    treatment: { conflict_half_life_days: form.treatmentHalfLife, ...(treatmentShocks.length ? { shocks: treatmentShocks } : {}) },
    analysis: { n_boot: 500, n_perm: 500 },
    ...(opts.nameAssigned ? {} : { overwrite: form.overwrite }),
  };
  if (worldShocks.length) req.world = { shocks: worldShocks };
  const translations = translationPointers(orderedShocks(form));
  if (translations.length) req.translations = translations;
  return req;
}

/** A fork of `parent`: only the shocks travel, each with its own target; everything else is the parent's. */
export function buildForkRequest(form: RunForm, kinds: ShockKind[], parent: string, opts: { nameAssigned?: boolean } = {}): ForkRequest {
  const ordered = orderedShocks(form);
  const req: ForkRequest = {
    parent,
    ...(opts.nameAssigned ? {} : { name: form.name.trim() }),
    shocks: ordered.map((s) => ({ ...shockFields(s, kinds), target: s.target === 'all' ? 'all' : 'treatment' })),
  };
  const translations = translationPointers(ordered);
  if (translations.length) req.translations = translations;
  return req;
}

/** The day a new world's replay starts on: ten days before its first shock acts, or the first day without shocks. */
export function replayStartDay(shocks: ShockForm[], days: number): number {
  return replayStartForSpecs(shocks.map(rowSpec), days);
}

/** The same day for shocks as the server runs them, such as the read-only demo's shocks run in advance. */
export function replayStartForSpecs(specs: ShockSpec[], days: number): number {
  if (!specs.length) return 0;
  const first = Math.min(...specs.map(shockFirstDay));
  const last = Math.max(0, days - 1);
  return Math.min(last, Math.max(0, first - REPLAY_LEAD_DAYS));
}

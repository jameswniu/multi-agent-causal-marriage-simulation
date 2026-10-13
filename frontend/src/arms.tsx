// Plain-words labels for the two arms, derived from the experiment: the memory change and the
// shocks aimed at the treatment arm, with the technical words in small text. Shared through a
// context so every page and chart reads the same words.
import { createContext, useContext, type ReactNode } from 'react';
import { getExperiment, getShocksCatalog } from './api';
import { useExperiment } from './experiment';
import { useAsync } from './useAsync';
import type { Arm, ExperimentListItem, ShockKind, ShockSpec, TreatmentSpec, EffectSpec } from './types';

export interface ArmLabel {
  /** What a first-time viewer reads: "Forgets fights in 2 weeks". */
  plain: string;
  /** The technical word in small text: "control, 14-day memory half-life". */
  small: string;
}

export type ArmLabels = Record<Arm, ArmLabel>;

/** A memory parameter that really differs between the arms. */
export interface MemorySpec {
  parameter: string;
  control_value: number;
  treatment_value: number;
}

/** Everything that differs between the arms, plus what everyone lives through. */
export interface Intervention {
  memory: MemorySpec | null;
  treatmentShocks: ShockSpec[];
  worldShocks: ShockSpec[];
}

export type Catalog = Record<string, ShockKind>;

/** Days to a rounded human span: under 7 stays days, under 60 rounds to weeks, 60 and up to months. */
export function humanDuration(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return `${days} days`;
  if (days < 7) return `${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
  if (days < 60) {
    const w = Math.max(1, Math.round(days / 7));
    return `${w} ${w === 1 ? 'week' : 'weeks'}`;
  }
  const m = Math.max(2, Math.round(days / 30));
  return `${m} months`;
}

function fmtDays(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

export function hasMemoryChange(spec: TreatmentSpec | null | undefined): spec is TreatmentSpec & MemorySpec {
  return !!spec && spec.parameter !== 'none' && typeof spec.control_value === 'number' && typeof spec.treatment_value === 'number';
}

/** Split an experiment's shocks by target. */
export function interventionOf(spec: TreatmentSpec | null | undefined, shocks: ShockSpec[] | null | undefined): Intervention {
  const list = shocks ?? [];
  return {
    memory: hasMemoryChange(spec) ? { parameter: spec.parameter, control_value: spec.control_value, treatment_value: spec.treatment_value } : null,
    treatmentShocks: list.filter((s) => s.target === 'treatment'),
    worldShocks: list.filter((s) => s.target === 'all'),
  };
}

function kindWords(kind: string): string {
  return kind.replace(/_/g, ' ');
}

function upperFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The kind's base words: the catalog blurb before its first colon, or the kind itself; a trait shift names the trait. */
function shockBase(s: ShockSpec, catalog: Catalog | null | undefined): string {
  if (s.trait) return `One partner's ${s.trait.replace(/_/g, ' ')} shifts`;
  const k = catalog?.[s.kind];
  return k ? k.blurb.split(/[:;.]/)[0].trim() : upperFirst(kindWords(s.kind));
}

/** "+0.3" for kinds whose magnitude can go either way, "1.5" otherwise, at most three decimals. */
function shockMagnitude(s: ShockSpec, catalog: Catalog | null | undefined): string {
  const n = Number(s.magnitude.toFixed(3)).toString();
  const signed = s.trait != null || (catalog?.[s.kind]?.magnitude.min ?? 0) < 0;
  return signed && s.magnitude > 0 ? `+${n}` : n;
}

/** "a random partner", "partner A", "partner B", or "both partners" for kinds that act on the couple. */
function shockMember(s: ShockSpec, catalog: Catalog | null | undefined): string {
  if (catalog?.[s.kind]?.member_applies === false) return 'both partners';
  if (s.member === 'a') return 'partner A';
  if (s.member === 'b') return 'partner B';
  return 'a random partner';
}

function shockTarget(s: ShockSpec): string {
  if (s.target === 'treatment') return 'treatment arm';
  if (s.target === 'control') return 'control arm';
  return 'everyone';
}

/** "days 60 to 210", "day 30", or "from day 0 to the end of the run", resolving an open end the way the engine does. */
function shockDays(s: ShockSpec, catalog: Catalog | null | undefined): string {
  let end = s.end_day;
  if (end == null) {
    const k = catalog?.[s.kind];
    if (!k) return `from day ${s.start_day} on`;
    const len = k.default_length_days ?? (k.default_end_day != null ? k.default_end_day - k.default_start_day : null);
    if (len == null) return `from day ${s.start_day} to the end of the run`;
    end = s.start_day + len;
  }
  return end === s.start_day ? `day ${s.start_day}` : `days ${s.start_day} to ${end}`;
}

function isCustom(s: ShockSpec): boolean {
  return s.kind === 'custom';
}

/** A custom shock's label in words, capitalised: "Mother moves in". */
/** The day a shock first acts: a custom shock's earliest effect window, otherwise its own start day. */
export function shockFirstDay(s: ShockSpec): number {
  const effects = isCustom(s) ? s.effects ?? [] : [];
  return effects.length ? Math.min(...effects.map((e) => e.start_day ?? s.start_day)) : s.start_day;
}

function customLabel(s: ShockSpec): string {
  return upperFirst((s.label ?? 'custom shock').trim());
}

const EPISODE_WORDS: Record<string, string> = { positive: 'warm', conflict: 'hurtful', repair: 'reconciling', disappointment: 'disappointing' };
const CADENCE_WORDS: Record<string, string> = { once: 'once', daily: 'every day', weekly: 'every week', yearly: 'every year' };

function num(x: number): string {
  return Number(Math.abs(x).toFixed(3)).toString();
}

function upDown(x: number): string {
  return x < 0 ? `down ${num(x)}` : `up ${num(x)}`;
}

/** Whom an effect hits, in words, given the shock's member: "both partners", "partner A", "the other partner". */
function effectWho(e: EffectSpec, s: ShockSpec): string {
  if (e.channel === 'onset_hazard' || e.who === 'both') return 'both partners';
  const chosen = s.member === 'a' ? 'partner A' : s.member === 'b' ? 'partner B' : 'a random partner';
  if (e.who === 'member') return chosen;
  return s.member === 'a' ? 'partner B' : s.member === 'b' ? 'partner A' : 'the other partner';
}

/** The effect's own window in words, defaulting to the shock's: "days 60 to 120". */
function effectDays(e: EffectSpec, s: ShockSpec): string {
  const start = e.start_day ?? s.start_day;
  const end = e.end_day ?? s.end_day;
  if (e.cadence === 'once') return `on day ${start}`;
  if (end == null) return `from day ${start} to the end of the run`;
  return end === start ? `on day ${start}` : `days ${start} to ${end}`;
}

/**
 * One effect of a custom shock in plain words: "both partners: stress up 0.4 every day, days 60 to 120".
 * Multipliers read as times ("fights start 1.3 times as often").
 */
export function effectWords(e: EffectSpec, s: ShockSpec): string {
  const how = CADENCE_WORDS[e.cadence] ?? e.cadence;
  let what: string;
  switch (e.channel) {
    case 'stress':
      what = e.cadence === 'daily' ? `stress ${upDown(e.amount)} every day` : `stress ${upDown(e.amount)} ${how}`;
      break;
    case 'affect':
      what = `mood ${upDown(e.amount)} ${how}`;
      break;
    case 'trust':
      what = `trust ${upDown(e.amount)} ${how}`;
      break;
    case 'episode':
      what = `a ${EPISODE_WORDS[e.class ?? 'positive'] ?? e.class} memory of strength ${num(e.amount)} ${how}`;
      break;
    case 'outside':
      what = `a ${num(e.amount)} chance a day of meeting someone attractive`;
      break;
    case 'onset_hazard':
      what = `fights start ${num(e.amount)} times as often`;
      break;
    case 'repair_propensity':
      what = `${num(e.amount)} times the odds of making up`;
      break;
    case 'trait':
      what = `${(e.trait ?? 'a trait').replace(/_/g, ' ')} ${upDown(e.amount)} ${how}`;
      break;
    default:
      what = `${String(e.channel)} ${e.amount} ${how}`;
  }
  return `${effectWho(e, s)}: ${what}, ${effectDays(e, s)}`;
}

/**
 * Every field of a shock in plain words, so two shocks that differ in any field never read the
 * same: "One partner loses their job (a random partner, treatment arm), days 60 to 210,
 * magnitude 1.5 (stress)". A custom shock reads as its label, its arm and each effect.
 */
export function shockWords(s: ShockSpec, catalog: Catalog | null | undefined): string {
  if (isCustom(s)) return `${customLabel(s)} (${shockTarget(s)}): ${(s.effects ?? []).map((e) => effectWords(e, s)).join('; ')}`;
  const unit = catalog?.[s.kind]?.magnitude.unit;
  const magnitude = `magnitude ${shockMagnitude(s, catalog)}${unit ? ` (${unit})` : ''}`;
  return `${shockBase(s, catalog)} (${shockMember(s, catalog)}, ${shockTarget(s)}), ${shockDays(s, catalog)}, ${magnitude}`;
}

/** The short form for an arm's label, which still carries the size: "One partner loses their job on day 60 (1.5 stress)". */
export function shockBrief(s: ShockSpec, catalog: Catalog | null | undefined): string {
  if (isCustom(s)) {
    const n = (s.effects ?? []).length;
    return `${customLabel(s)} on day ${shockFirstDay(s)} (${n} effect${n === 1 ? '' : 's'})`;
  }
  const unit = catalog?.[s.kind]?.magnitude.unit;
  return `${shockBase(s, catalog)} on day ${s.start_day} (${shockMagnitude(s, catalog)}${unit ? ` ${unit}` : ''})`;
}

/** "job loss" for the control side: the catalog label lowercased, or the kind in words; a trait shift names the trait. */
export function shockShort(s: ShockSpec, catalog: Catalog | null | undefined): string {
  if (isCustom(s)) return customLabel(s).toLowerCase();
  const k = catalog?.[s.kind];
  const base = (k ? k.label : kindWords(s.kind)).toLowerCase();
  return s.trait ? `${base} (${s.trait.replace(/_/g, ' ')})` : base;
}

/** Memory words for one arm, by the values: the longer half-life "holds onto", the shorter "forgets". */
export function memoryWords(mem: MemorySpec, arm: Arm): string {
  const own = arm === 'control' ? mem.control_value : mem.treatment_value;
  const other = arm === 'control' ? mem.treatment_value : mem.control_value;
  if (mem.parameter !== 'conflict_half_life_days') return `${arm === 'control' ? 'Control' : 'Treatment'}, ${mem.parameter.replace(/_/g, ' ')} ${fmtDays(own)}`;
  if (own === other) return `Memory half-life is ${fmtDays(own)} days`;
  return own > other ? `Holds onto fights for ${humanDuration(own)}` : `Forgets fights in ${humanDuration(own)}`;
}

function joinWords(parts: string[]): string {
  return parts.join(', ');
}

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

export const DEFAULT_LABELS: ArmLabels = {
  control: { plain: 'Control', small: 'control' },
  treatment: { plain: 'Treatment', small: 'treatment' },
};

export function armLabelsFor(iv: Intervention, catalog: Catalog | null | undefined): ArmLabels {
  const mem = iv.memory;
  const memControl = mem ? memoryWords(mem, 'control') : '';
  const memTreatment = mem ? memoryWords(mem, 'treatment') : '';
  const smallMem = mem && mem.parameter === 'conflict_half_life_days' ? [`${fmtDays(mem.control_value)}-day memory half-life`, `${fmtDays(mem.treatment_value)}-day memory half-life`] : mem ? [`${mem.parameter} ${fmtDays(mem.control_value)}`, `${mem.parameter} ${fmtDays(mem.treatment_value)}`] : ['', ''];
  const shocks = iv.treatmentShocks;
  const shockControl = shocks.length ? `No ${joinWords(shocks.map((s) => shockShort(s, catalog)))}` : '';
  const shockTreatment = shocks.length ? joinWords(shocks.map((s, i) => (i === 0 ? shockBrief(s, catalog) : lowerFirst(shockBrief(s, catalog))))) : '';
  const smallShocks = shocks.length ? shocks.map((s) => `${isCustom(s) ? shockShort(s, catalog) : kindWords(s.kind)} day ${shockFirstDay(s)}`).join(', ') : '';
  if (!mem && !shocks.length) return DEFAULT_LABELS;
  const plainControl = [memControl, shockControl ? (memControl ? lowerFirst(shockControl) : shockControl) : ''].filter(Boolean).join(', ');
  const plainTreatment = [memTreatment, shockTreatment ? (memTreatment ? lowerFirst(shockTreatment) : shockTreatment) : ''].filter(Boolean).join(', ');
  return {
    control: { plain: plainControl, small: ['control', smallMem[0], smallShocks ? `no ${smallShocks}` : ''].filter(Boolean).join(', ') },
    treatment: { plain: plainTreatment, small: ['treatment', smallMem[1], smallShocks].filter(Boolean).join(', ') },
  };
}

/** Convenience for a bare memory spec (no shocks, no catalog). */
export function armLabels(spec: TreatmentSpec | null | undefined, shocks?: ShockSpec[] | null, catalog?: Catalog | null): ArmLabels {
  return armLabelsFor(interventionOf(spec, shocks), catalog);
}

/** "every couple in town starts ..." as a sentence of its own: capitalised and closed with a full stop. */
function asSentence(s: string): string {
  const t = s.trim();
  return upperFirst(t.endsWith('.') ? t : `${t}.`);
}

/**
 * The sentence for the Overview "What differs" tile and the World framing. `everyone`, given only on the
 * read-only demo, is a plain sentence for what everyone lives through, said in place of the shocks' own words.
 */
export function whatDiffers(iv: Intervention, catalog: Catalog | null | undefined, everyone: string | null = null): string {
  const mem = iv.memory;
  const memWords =
    mem && mem.parameter === 'conflict_half_life_days'
      ? `how long a fight stays in memory, ${fmtDays(mem.control_value)} days versus ${fmtDays(mem.treatment_value)}`
      : mem
        ? `${mem.parameter.replace(/_/g, ' ')}, ${fmtDays(mem.control_value)} versus ${fmtDays(mem.treatment_value)}`
        : '';
  const shockWordsAll = iv.treatmentShocks.map((s, i) => (i === 0 ? lowerFirst(shockWords(s, catalog)) : lowerFirst(shockWords(s, catalog))));
  let text: string;
  if (mem && shockWordsAll.length) text = `Only ${memWords}, and ${joinWords(shockWordsAll)}.`;
  else if (mem) text = `Only ${memWords}`;
  else if (shockWordsAll.length) text = `Only this, ${joinWords(shockWordsAll)}. Memory is identical in both arms.`;
  else text = 'Nothing differs between the arms (a placebo run).';
  const world = iv.worldShocks.map((s) => lowerFirst(shockWords(s, catalog)));
  const shared = world.length && everyone ? asSentence(everyone) : null;
  if (!mem && !shockWordsAll.length && world.length) return `Nothing differs between the arms. ${shared ?? `Everyone lives through ${joinWords(world)}.`}`;
  if (world.length) text += `${text.endsWith('.') ? '' : '.'} ${shared ?? `Everyone also lives through ${joinWords(world)}.`}`;
  return text;
}

/** "how long a fight stayed in memory" or "this, one partner loses their job on day 60", for the takeaway; null when nothing differs. */
export function differenceClause(iv: Intervention, catalog: Catalog | null | undefined): string | null {
  const shocks = iv.treatmentShocks.map((s) => lowerFirst(shockWords(s, catalog)));
  const mem = iv.memory ? (iv.memory.parameter === 'conflict_half_life_days' ? 'how long a fight stayed in memory' : iv.memory.parameter.replace(/_/g, ' ')) : '';
  if (mem && shocks.length) return `${mem}, and this, ${joinWords(shocks)}`;
  if (shocks.length) return `this, ${joinWords(shocks)}`;
  if (mem) return mem;
  return null;
}

/**
 * "everyone lived through every seventh day ..." for a run whose only intervention is a world shock; null
 * otherwise. `everyone`, given only on the read-only demo, is said in its place, without its full stop.
 */
export function sharedClause(iv: Intervention, catalog: Catalog | null | undefined, everyone: string | null = null): string | null {
  if (!iv.worldShocks.length) return null;
  if (everyone) return lowerFirst(everyone.trim().replace(/\.$/, ''));
  return `everyone lived through ${joinWords(iv.worldShocks.map((s) => lowerFirst(shockWords(s, catalog))))}`;
}

/** Short summary for the experiment dropdown: "memory 14 to 90" or "job loss on day 60". */
export function interventionSummary(item: ExperimentListItem, catalog?: Catalog | null): string {
  const parts: string[] = [];
  const mem = item.intervention?.memory;
  if (mem) {
    for (const [param, pair] of Object.entries(mem)) {
      const name = param === 'conflict_half_life_days' ? 'memory' : param.replace(/_/g, ' ');
      parts.push(`${name} ${fmtDays(pair[0])} to ${fmtDays(pair[1])}`);
    }
  }
  for (const s of item.intervention?.shocks ?? []) {
    const who = s.target === 'all' ? 'everyone: ' : '';
    parts.push(`${who}${shockShort(s, catalog)} on day ${shockFirstDay(s)}`);
  }
  return parts.length ? parts.join(', ') : 'no intervention';
}

export interface ArmContext {
  labels: ArmLabels;
  intervention: Intervention;
  catalog: Catalog | null;
  nCouples: number | null;
  /**
   * On the read-only demo, a world whose shocks were run in advance on everyone says what everyone lives
   * through in its card's plain sentence (whatDiffers, sharedClause). Null everywhere else.
   */
  everyone: string | null;
}

const EMPTY: ArmContext = { labels: DEFAULT_LABELS, intervention: { memory: null, treatmentShocks: [], worldShocks: [] }, catalog: null, nCouples: null, everyone: null };

/** The read-only demo (VITE_STATIC=1), whose shocks run in advance each come with a plain sentence. */
const STATIC = import.meta.env.VITE_STATIC === '1';

/**
 * The read-only demo's plain sentence for the world `name`, when its card's shocks all reach everyone, with how
 * many shocks it covers; null for any other world. Called only in the static build.
 */
async function demoEveryoneWords(name: string | null): Promise<{ words: string; shocks: number } | null> {
  if (!name) return null;
  const { demoCards } = await import('./staticApi');
  const card = (await demoCards()).find((c) => c.name === name);
  return card && card.shocks.length > 0 && card.shocks.every((s) => s.target === 'all') ? { words: card.words, shocks: card.shocks.length } : null;
}

const Ctx = createContext<ArmContext>(EMPTY);

export function toCatalog(kinds: ShockKind[] | undefined | null): Catalog | null {
  if (!kinds) return null;
  const out: Catalog = {};
  kinds.forEach((k) => {
    out[k.kind] = k;
  });
  return out;
}

export function ArmLabelsProvider({ children }: { children: ReactNode }) {
  const name = useExperiment().name;
  const { data } = useAsync(
    () => Promise.all([getExperiment().catch(() => null), getShocksCatalog().catch(() => null), STATIC ? demoEveryoneWords(name).catch(() => null) : Promise.resolve(null)]),
    [],
  );
  const exp = data?.[0]?.summary?.experiment;
  const catalog = toCatalog(data?.[1]?.kinds);
  const intervention = interventionOf(exp?.treatment, exp?.shocks);
  // The card's sentence stands for the world's shocks only when it covers every one of them.
  const demo = data?.[2] ?? null;
  const everyone = demo && demo.shocks === intervention.worldShocks.length ? demo.words : null;
  const value: ArmContext = { labels: armLabelsFor(intervention, catalog), intervention, catalog, nCouples: exp?.n_couples ?? data?.[0]?.manifest.n_couples ?? null, everyone };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArmLabels(): ArmLabels {
  return useContext(Ctx).labels;
}

export function useArmContext(): ArmContext {
  return useContext(Ctx);
}

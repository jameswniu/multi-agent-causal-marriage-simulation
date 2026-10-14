// Plain-words labels for the two arms, derived from the experiment: the memory change and the
// shocks aimed at the treatment arm, with the technical words in small text. Shared through a
// context so every page and chart reads the same words. It also says each shock as a plain sentence
// (shockWords), which the World page, the Overview, Governance and the shock cards read.
import { createContext, useContext, type ReactNode } from 'react';
import { getExperiment, getShocksCatalog } from './api';
import { useAsync } from './useAsync';
import type { Arm, ExperimentListItem, ShockKind, ShockMember, ShockSpec, TreatmentSpec, EffectSpec } from './types';

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

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

function isCustom(s: ShockSpec): boolean {
  return s.kind === 'custom';
}

/** The day a shock first acts: a custom shock's earliest effect window, otherwise its own start day. */
export function shockFirstDay(s: ShockSpec): number {
  const effects = isCustom(s) ? s.effects ?? [] : [];
  return effects.length ? Math.min(...effects.map((e) => e.start_day ?? s.start_day)) : s.start_day;
}

/** A custom shock's label in words, capitalised: "Mother moves in". */
function customLabel(s: ShockSpec): string {
  return upperFirst((s.label ?? 'custom shock').trim());
}

/** A number as the dashboard prints it: at most three decimals, with trailing zeros dropped. */
function plainNumber(x: number): string {
  return Number(x.toFixed(3)).toString();
}

/** The size of a change without its sign. */
function num(x: number): string {
  return plainNumber(Math.abs(x));
}

/** "goes up 0.3" or "goes down 0.3". */
function goes(x: number): string {
  return x < 0 ? `goes down ${num(x)}` : `goes up ${num(x)}`;
}

/** "+0.3" or "-0.3", for a change that can go either way. */
function signed(x: number): string {
  return x > 0 ? `+${plainNumber(x)}` : plainNumber(x);
}

/** A trait as people say it: closeness_pref is a partner's wish for closeness. */
function traitWords(trait: string | null | undefined): string {
  const t = trait ?? 'conflict_engagement';
  return t === 'closeness_pref' ? 'wish for closeness' : kindWords(t);
}

/** "a, b and c", or "a, b or c". */
function listWords(items: string[], last = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** A small count in words, as a sentence says it: "two shocks". */
function countWords(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** The couples a shock reaches: one arm's, or every couple in town, both arms and the couples who remarry. */
function couplesWords(s: ShockSpec): string {
  if (s.target === 'treatment') return 'every treatment couple';
  if (s.target === 'control') return 'every control couple';
  return 'every couple in town';
}

/** The partner a shock picks in each couple. */
function pickedWords(member: ShockMember): string {
  if (member === 'a') return 'partner A';
  if (member === 'b') return 'partner B';
  return 'one partner picked at random';
}

/** The partner it does not pick. */
function otherWords(member: ShockMember): string {
  if (member === 'a') return 'partner B';
  if (member === 'b') return 'partner A';
  return 'the other partner';
}

/**
 * The last day a shock acts, resolved the way the engine resolves it: its own end day, else its start day plus
 * its kind's catalog length, else null for a shock that runs to the end of the run. Undefined when only the
 * catalog, which has not loaded, could say.
 */
function shockEnd(s: ShockSpec, catalog: Catalog | null | undefined): number | null | undefined {
  if (s.end_day != null) return s.end_day;
  if (isCustom(s)) return null;
  const k = catalog?.[s.kind];
  if (!k) return undefined;
  const len = k.default_length_days ?? (k.default_end_day != null ? k.default_end_day - k.default_start_day : null);
  return len == null ? null : s.start_day + len;
}

/** "from day 60 to day 150", "on day 60", "from day 30 to the end of the run", or "from day 30 on" when the end is unknown. */
function spanWords(start: number, end: number | null | undefined): string {
  if (end === undefined) return `from day ${start} on`;
  if (end === null) return `from day ${start} to the end of the run`;
  return end === start ? `on day ${start}` : `from day ${start} to day ${end}`;
}

/** " Each date night counts 2 times as much as usual." for a kind whose magnitude scales its usual strength; nothing at 1. */
function timesUsual(what: string, m: number): string {
  return m === 1 ? '' : ` Each ${what} counts ${plainNumber(m)} times as much as usual.`;
}

/** One of the catalog's named kinds as a plain sentence, with every field it was given. */
function namedShockWords(s: ShockSpec, catalog: Catalog | null | undefined): string {
  const m = s.magnitude;
  const couples = couplesWords(s);
  const who = pickedWords(s.member);
  const start = s.start_day;
  const end = shockEnd(s, catalog);
  const span = spanWords(start, end);
  const oneDay = end === start;
  const k = catalog?.[s.kind];
  if (m === 0) {
    // A magnitude of 0 runs the kind and changes nothing, which is all the sentence needs to say.
    const label = k ? k.label : upperFirst(kindWords(s.kind));
    const whom = k?.member_applies === false || ['financial_crisis', 'anniversary', 'date_nights'].includes(s.kind) ? 'both partners' : who;
    const trait = s.trait ? ` of ${traitWords(s.trait)}` : '';
    return `${label}${trait} ${span} for ${whom} in ${couples}, at magnitude 0, which changes nothing.`;
  }
  // A one-day change stays after the shock is over, which an end day set on the shock does not undo. A shock that
  // ends on the day it starts is a one-day shock.
  const stays = s.end_day == null ? '' : s.end_day === start ? ', even after the one-day shock is over' : `, even after the shock ends on day ${s.end_day}`;
  switch (s.kind) {
    case 'job_loss': {
      const after = oneDay ? '' : end === undefined ? ' and stays raised from then on' : end === null ? ' and stays raised to the end of the run' : ` and stays raised until day ${end}`;
      return `In ${couples}, ${who} loses their job on day ${start}, so their stress jumps by ${plainNumber(m)} that day${after}.`;
    }
    case 'financial_crisis':
      return `${upperFirst(span)}, money trouble of magnitude ${plainNumber(m)} hits ${couples}, and both partners carry extra stress ${oneDay ? 'that day' : 'every day'}.`;
    case 'temptation': {
      // At a chance of 1 the encounter is certain, so the sentence says it happens.
      const odds = m === 1 ? ` and has an encounter outside the relationship ${oneDay ? 'that day' : 'every day'}` : `, with a ${plainNumber(m)} chance ${oneDay ? 'that day' : 'each day'} of an encounter outside the relationship`;
      return `${upperFirst(span)}, ${who} in ${couples} keeps meeting attractive people${odds}.`;
    }
    case 'intimacy_mismatch':
      return `On day ${start}, ${who} in ${couples} starts wanting ${m < 0 ? 'less' : 'more'} closeness, ${m < 0 ? 'down' : 'up'} ${num(m)} on a scale of 0 to 1, and keeps wanting it${stays}.`;
    case 'trait_shift':
      return `On day ${start}, the ${traitWords(s.trait)} of ${who} in ${couples} ${goes(m)} on a scale of 0 to 1 and stays there${stays}.`;
    case 'daily_texts': {
      const other = otherWords(s.member);
      return `${upperFirst(span)}, ${who} in ${couples} sends ${other} a loving text ${oneDay ? 'that day' : 'every day'}, and ${other} stores a small warm memory and feels a little better${oneDay ? '' : ' each time'}.${timesUsual('text', m)}`;
    }
    case 'anniversary': {
      // A shock that ends within a year of its first day holds that one anniversary, so its end closes the sentence.
      const once = !oneDay && typeof end === 'number' && end < start + 365;
      const when = oneDay || once ? `On day ${start}` : `On day ${start} and every 365 days after${typeof end === 'number' ? ` until day ${end}` : ''}`;
      const ends = once ? ` The shock ends on day ${end}, before the next anniversary.` : '';
      return `${when}, both partners in ${couples} celebrate an anniversary, store a strong warm memory and trust each other a little more.${ends}${timesUsual('anniversary', m)}`;
    }
    case 'date_nights':
      return `${oneDay ? `On day ${start}` : `Once a week ${span}`}, both partners in ${couples} go on a date night and store a good memory.${timesUsual('date night', m)}`;
    default: {
      // A kind this dashboard has no sentence for yet still names every field.
      const label = k ? k.label : upperFirst(kindWords(s.kind));
      const whom = k?.member_applies === false ? 'both partners' : who;
      const unit = k?.magnitude.unit;
      const trait = s.trait ? `, moving ${traitWords(s.trait)}` : '';
      return `${label} ${span} for ${whom} in ${couples}${trait}, at magnitude ${plainNumber(m)}${unit ? ` (${unit})` : ''}.`;
    }
  }
}

const EPISODE_WORDS: Record<string, string> = { positive: 'warm', conflict: 'hurtful', repair: 'reconciling', disappointment: 'disappointing' };
const CADENCE_WORDS: Record<string, string> = { once: '', daily: ' every day', weekly: ' every week', yearly: ' every year' };

/** How a custom shock's sentence names the partner it picks and the other one. */
interface Partners {
  member: string;
  partner: string;
  /** Whether the sentence says, before its effects, that one partner in each couple is picked at random. */
  picked: boolean;
}

/**
 * The partners a custom shock's sentence names. Partner A or B is named outright. A partner picked at random is
 * picked once per couple for the whole shock, so when more than one effect falls on one partner, the sentence says
 * first that one partner in each couple is picked at random, then names them "the chosen partner" and "the other
 * partner", as the shock's fields do. A single such effect says "one partner picked at random" on either side,
 * since the other partner of a random pick is a random pick too.
 */
function partnersOf(s: ShockSpec): Partners {
  if (s.member === 'a' || s.member === 'b') return { member: pickedWords(s.member), partner: otherWords(s.member), picked: false };
  const single = (s.effects ?? []).filter((e) => e.channel !== 'onset_hazard' && e.who !== 'both');
  if (single.length <= 1) return { member: pickedWords('random'), partner: pickedWords('random'), picked: false };
  return { member: 'the chosen partner', partner: 'the other partner', picked: true };
}

/**
 * Whom an effect hits: "both partners", "partner A", "the other partner". Alone, an effect names the partner by
 * the shock's member; in a custom shock's sentence it names them as the sentence does (partnersOf).
 */
function effectWho(e: EffectSpec, s: ShockSpec, partners?: Partners): string {
  if (e.channel === 'onset_hazard' || e.who === 'both') return 'both partners';
  if (partners) return e.who === 'member' ? partners.member : partners.partner;
  return e.who === 'member' ? pickedWords(s.member) : otherWords(s.member);
}

/** The effect's own window in words, defaulting to the shock's: "from day 60 to day 120", or "on day 60" for a one-off. */
function effectSpan(e: EffectSpec, s: ShockSpec): string {
  const start = e.start_day ?? s.start_day;
  const end = e.end_day ?? s.end_day;
  return e.cadence === 'once' ? `on day ${start}` : spanWords(start, end ?? null);
}

/** One effect as a clause: "stress goes up 0.4 every day for both partners", with its window unless `withSpan` is false. */
function effectClause(e: EffectSpec, s: ShockSpec, withSpan: boolean, partners?: Partners): string {
  const how = CADENCE_WORDS[e.cadence] ?? ` ${e.cadence}`;
  const who = effectWho(e, s, partners);
  const many = who === 'both partners';
  let what: string;
  switch (e.channel) {
    case 'stress':
      what = `stress ${goes(e.amount)}${how} for ${who}`;
      break;
    case 'affect':
      what = `mood ${goes(e.amount)}${how} for ${who}`;
      break;
    case 'trust':
      what = `trust ${goes(e.amount)}${how} for ${who}`;
      break;
    case 'episode':
      what = `${who} ${many ? 'store' : 'stores'} a ${EPISODE_WORDS[e.class ?? 'positive'] ?? e.class} memory of strength ${num(e.amount)}${how}`;
      break;
    case 'outside':
      // At a chance of 1 the meeting is certain, so the sentence says it happens.
      what = e.amount === 1 ? `${who} ${many ? 'meet' : 'meets'} someone attractive every day` : `${who} ${many ? 'have' : 'has'} a ${num(e.amount)} chance each day of meeting someone attractive`;
      break;
    case 'onset_hazard':
      what = `fights start ${num(e.amount)} times as often`;
      break;
    case 'repair_propensity':
      what = `${who} ${many ? 'have' : 'has'} ${num(e.amount)} times the usual odds of making up`;
      break;
    case 'trait':
      what = `${traitWords(e.trait ?? 'a trait')} ${goes(e.amount)}${how} for ${who}`;
      break;
    default:
      what = `${String(e.channel)} ${e.amount}${how} for ${who}`;
  }
  return withSpan ? `${what} ${effectSpan(e, s)}` : what;
}

/**
 * One effect of a custom shock as a plain sentence: "Stress goes up 0.4 every day for both partners from day 60
 * to day 120." Multipliers read as times ("fights start 1.3 times as often").
 */
export function effectWords(e: EffectSpec, s: ShockSpec): string {
  return `${upperFirst(effectClause(e, s, true))}.`;
}

/**
 * A custom shock as one sentence: its label, whom it reaches, its window when every effect shares it, the random
 * pick of a partner when more than one effect falls on one partner (partnersOf), and each effect.
 */
function customWords(s: ShockSpec): string {
  const effects = s.effects ?? [];
  const head = `${customLabel(s)} for ${couplesWords(s)}`;
  if (!effects.length) return `${head}, with no effects.`;
  const spans = effects.map((e) => effectSpan(e, s));
  const shared = spans.every((x) => x === spans[0]) ? spans[0] : null;
  const partners = partnersOf(s);
  const picked = partners.picked ? ', with one partner in each couple picked at random' : '';
  return `${head}${shared ? ` ${shared}` : ''}${picked}, so ${listWords(effects.map((e) => effectClause(e, s, shared === null, partners)))}.`;
}

/**
 * A shock as a plain sentence that names every field it was given, so two shocks that differ in any field never
 * read the same: "In every treatment couple, one partner picked at random loses their job on day 60, so their
 * stress jumps by 1.5 that day and stays raised until day 150." A custom shock reads as its label, whom it
 * reaches and each of its effects.
 */
export function shockWords(s: ShockSpec, catalog: Catalog | null | undefined): string {
  return isCustom(s) ? customWords(s) : namedShockWords(s, catalog);
}

/**
 * Shocks said after a lead: "Lead: in every treatment couple, ..." for one named kind, and "Lead. Sentence.
 * Sentence." for a custom shock, whose label keeps its own capitals, or for several.
 */
export function shocksIntroduced(lead: string, shocks: ShockSpec[], catalog: Catalog | null | undefined): string {
  const sentences = shocks.map((s) => shockWords(s, catalog));
  if (shocks.length === 1 && !isCustom(shocks[0])) return `${lead}: ${lowerFirst(sentences[0])}`;
  return `${lead}. ${sentences.join(' ')}`;
}

/** The short form for an arm's label, which still carries the size: "One partner loses their job on day 60 (1.5 stress)". */
export function shockBrief(s: ShockSpec, catalog: Catalog | null | undefined): string {
  if (isCustom(s)) {
    const n = (s.effects ?? []).length;
    return `${customLabel(s)} on day ${shockFirstDay(s)} (${n} effect${n === 1 ? '' : 's'})`;
  }
  const m = s.magnitude;
  const one = s.member === 'a' ? 'Partner A' : s.member === 'b' ? 'Partner B' : 'One partner';
  const strength = m === 1 ? '' : ` (${plainNumber(m)} times as strong)`;
  const day = s.start_day;
  switch (s.kind) {
    case 'job_loss':
      return `${one} loses their job on day ${day} (${plainNumber(m)} stress)`;
    case 'financial_crisis':
      return `Money trouble from day ${day} (${plainNumber(m)} stress)`;
    case 'temptation':
      return `${one} keeps meeting attractive people from day ${day} (${plainNumber(m)} a day)`;
    case 'intimacy_mismatch':
      return `${one} wants ${m < 0 ? 'less' : 'more'} closeness from day ${day} (${signed(m)})`;
    case 'trait_shift':
      return `${one}'s ${traitWords(s.trait)} shifts on day ${day} (${signed(m)})`;
    case 'daily_texts':
      return `Daily loving texts from day ${day}${strength}`;
    case 'anniversary':
      return `An anniversary on day ${day}${strength}`;
    case 'date_nights':
      return `Weekly date nights from day ${day}${strength}`;
    default: {
      const k = catalog?.[s.kind];
      const unit = k?.magnitude.unit;
      return `${k ? k.label : upperFirst(kindWords(s.kind))} on day ${day} (${plainNumber(m)}${unit ? ` ${unit}` : ''})`;
    }
  }
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
  const shockControl = shocks.length ? `No ${listWords(shocks.map((s) => shockShort(s, catalog)), 'or')}` : '';
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

/** The memory difference: "how long a fight stays in memory, 14 days versus 90". */
function memoryDiff(mem: MemorySpec): string {
  return mem.parameter === 'conflict_half_life_days'
    ? `how long a fight stays in memory, ${fmtDays(mem.control_value)} days versus ${fmtDays(mem.treatment_value)}`
    : `${mem.parameter.replace(/_/g, ' ')}, ${fmtDays(mem.control_value)} versus ${fmtDays(mem.treatment_value)}`;
}

/** "a shock to the treatment arm", or "two shocks to the treatment arm". */
function armShocks(n: number): string {
  return n === 1 ? 'a shock to the treatment arm' : `${countWords(n)} shocks to the treatment arm`;
}

/**
 * What the shocks every couple lives through add, as sentences of their own: "Both arms also live through the
 * same shock: once a week from day 30 ...". Null without any. `who` names the two halves the page compares, and
 * `also` is false when nothing else differs between them.
 */
export function sharedWords(iv: Intervention, catalog: Catalog | null | undefined, who = 'arms', also = true): string | null {
  const w = iv.worldShocks;
  if (!w.length) return null;
  return shocksIntroduced(`Both ${who}${also ? ' also' : ''} live through the same ${w.length === 1 ? 'shock' : 'shocks'}`, w, catalog);
}

/**
 * What differs between the arms, as the Overview's "What differs" tile and the World framing say it: the memory
 * change and each shock aimed at the treatment arm, then any shock both arms live through, each shock in its
 * own plain sentence. The tile leads with "Only", and the framing, where it must read as a sentence, with "The
 * only difference is".
 */
export function whatDiffers(iv: Intervention, catalog: Catalog | null | undefined, only = 'Only'): string {
  const mem = iv.memory;
  const t = iv.treatmentShocks;
  let text: string;
  if (mem && t.length) text = `${only} ${shocksIntroduced(`${memoryDiff(mem)}, and ${armShocks(t.length)}`, t, catalog)}`;
  else if (mem) text = `${only} ${memoryDiff(mem)}`;
  else if (t.length) text = `${only} ${shocksIntroduced(armShocks(t.length), t, catalog)} Memory is identical in both arms.`;
  else text = 'Nothing differs between the arms (a placebo run).';
  if (!iv.worldShocks.length) return text;
  if (!mem && !t.length) return `Nothing differs between the arms. ${sharedWords(iv, catalog, 'arms', false)}`;
  return `${text}${text.endsWith('.') ? '' : '.'} ${sharedWords(iv, catalog)}`;
}

/**
 * The same difference for the twins view, which runs every couple under both settings: "the only difference is
 * how long a fight stays in memory, 14 days versus 90", with each shock after it; null when nothing differs.
 */
export function twinsDifference(iv: Intervention, catalog: Catalog | null | undefined): string | null {
  const mem = iv.memory;
  const t = iv.treatmentShocks;
  if (mem && t.length) return `the only difference is ${shocksIntroduced(`${memoryDiff(mem)}, and ${armShocks(t.length)}`, t, catalog)}`;
  if (mem) return `the only difference is ${memoryDiff(mem)}.`;
  if (t.length) return `the only difference is ${shocksIntroduced(armShocks(t.length), t, catalog)} Memory is identical in both runs.`;
  return null;
}

/** "how long a fight stayed in memory" or "a shock the treatment arm alone went through", for the takeaway; null when nothing differs. */
export function differenceClause(iv: Intervention): string | null {
  const mem = iv.memory ? (iv.memory.parameter === 'conflict_half_life_days' ? 'how long a fight stayed in memory' : iv.memory.parameter.replace(/_/g, ' ')) : '';
  const n = iv.treatmentShocks.length;
  const shocks = n === 0 ? '' : `${n === 1 ? 'a shock' : `${countWords(n)} shocks`} the treatment arm alone went through`;
  if (mem && shocks) return `${mem}, and ${shocks}`;
  return mem || shocks || null;
}

/** "both lived through the same shock", for the takeaway of a run whose only intervention is shared; null otherwise. */
export function sharedClause(iv: Intervention): string | null {
  const n = iv.worldShocks.length;
  if (!n) return null;
  return `both lived through the same ${n === 1 ? 'shock' : 'shocks'}`;
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
}

const EMPTY: ArmContext = { labels: DEFAULT_LABELS, intervention: { memory: null, treatmentShocks: [], worldShocks: [] }, catalog: null, nCouples: null };

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
  const { data } = useAsync(() => Promise.all([getExperiment().catch(() => null), getShocksCatalog().catch(() => null)]), []);
  const exp = data?.[0]?.summary?.experiment;
  const catalog = toCatalog(data?.[1]?.kinds);
  const intervention = interventionOf(exp?.treatment, exp?.shocks);
  const value: ArmContext = { labels: armLabelsFor(intervention, catalog), intervention, catalog, nCouples: exp?.n_couples ?? data?.[0]?.manifest.n_couples ?? null };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArmLabels(): ArmLabels {
  return useContext(Ctx).labels;
}

export function useArmContext(): ArmContext {
  return useContext(Ctx);
}

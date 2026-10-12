// Pure geometry and posture for the town view. Every position is a function of the run's logged
// per-day states and the couples table; nothing here is stored or read back, and the engine has
// no space, so these positions are a layout that shows each agent's state, not a place it went.
import type { Arm, CoupleRow, Origin, WorldResponse } from '../types';

/** World units per tile; the art is 16 pixel tiles drawn at one world unit per pixel. */
export const TILE = 16;
/** One couple's lot: a 2 by 2 tile house with a yard in front for the figures. */
export const LOT_W = 48;
export const LOT_H = 56;
/** Default columns per district; the town view picks its own from the canvas shape (chooseDistrictCols). */
export const DISTRICT_COLS = 20;
/** Bounds for the column count chosen from the canvas shape. */
export const MIN_DISTRICT_COLS = 8;
export const MAX_DISTRICT_COLS = 80;
export const PLAZA_COLS = 6;
export const GUTTER = 32;
export const MARGIN = 48;
export const TITLE_BAND = 72;
/** Open plaza rows kept for singles and dating pairs above the new homes. */
export const MIN_OPEN_ROWS = 8;
/** Below this many screen pixels per lot the town draws houses only, no figures or markers. */
export const ROOFS_ONLY_BELOW = 24;

export type Zone = 'control' | 'treatment' | 'newhomes';
export type Posture = 'home' | 'conflict' | 'away' | 'single' | 'dating';
export type Member = 'a' | 'b';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Lot {
  idx: number;
  zone: Zone;
  /** Position of the lot in its zone, in couple id order. */
  k: number;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface TownLayout {
  width: number;
  height: number;
  /** Lots per row in each district. */
  districtCols: number;
  control: Rect;
  treatment: Rect;
  plaza: Rect;
  singles: Rect;
  dating: Rect;
  newHomes: Rect;
  /** Lot of every couple, by world index; a remarried couple that never marries has none. */
  lots: (Lot | undefined)[];
  order: Record<Zone, number[]>;
}

type WorldShape = Pick<WorldResponse, 'couples' | 'arms' | 'origin'>;

/** Remarried couples that marry at some point in the run. Only they get a house; a pair that only
 * dates and breaks up never needs one, and most remarried pairs in a run do just that. */
export function everMarried(world: Pick<WorldResponse, 'origin' | 'states'>): Set<number> {
  const out = new Set<number>();
  const pending = world.origin.flatMap((o, i) => (o === 'remarriage' ? [i] : []));
  for (const states of world.states) {
    for (const idx of pending) {
      if (out.has(idx)) continue;
      const ch = states[idx];
      if (ch === 'M' || ch === 'C' || ch === 'S' || ch === 'D') out.add(idx);
    }
  }
  return out;
}

function byCoupleId(world: WorldShape, idx: number[]): number[] {
  return [...idx].sort((p, q) => world.couples[p] - world.couples[q]);
}

/** World size of a town whose largest district holds `nDistrict` couples in rows of `cols`, with
 * `nHomes` new homes in the plaza; the same arithmetic buildLayout uses. */
export function townSize(nDistrict: number, nHomes: number, cols: number): { width: number; height: number } {
  const districtRows = Math.max(1, Math.ceil(nDistrict / cols));
  const homeRows = Math.ceil(nHomes / PLAZA_COLS);
  const plazaH = Math.max(districtRows * LOT_H, (homeRows + MIN_OPEN_ROWS) * LOT_H);
  return {
    width: 2 * MARGIN + 2 * cols * LOT_W + PLAZA_COLS * LOT_W + 2 * GUTTER,
    height: MARGIN + TITLE_BAND + plazaH + MARGIN,
  };
}

/** The scale at which a town of this size fits a view of `viewW` by `viewH` screen pixels. */
export function fitScale(size: { width: number; height: number }, viewW: number, viewH: number): number {
  return Math.min(viewW / size.width, viewH / size.height);
}

/** Columns per district that make the whole town as large as possible in the view, so a wide
 * canvas gets a wide town instead of a tall one with empty margins. */
export function chooseDistrictCols(nDistrict: number, nHomes: number, viewW: number, viewH: number): number {
  if (!(viewW > 0) || !(viewH > 0) || nDistrict <= 0) return DISTRICT_COLS;
  let best = DISTRICT_COLS;
  let bestScale = -1;
  for (let c = MIN_DISTRICT_COLS; c <= MAX_DISTRICT_COLS; c++) {
    const s = fitScale(townSize(nDistrict, nHomes, c), viewW, viewH);
    if (s > bestScale + 1e-9) {
      bestScale = s;
      best = c;
    }
  }
  return best;
}

/** Couples in the larger district and remarried couples given a home, as chooseDistrictCols needs them. */
export function townCounts(world: WorldShape, homes?: Set<number>): { nDistrict: number; nHomes: number } {
  let control = 0;
  let treatment = 0;
  let nHomes = 0;
  world.couples.forEach((_, i) => {
    if (world.origin[i] === 'remarriage') {
      if (!homes || homes.has(i)) nHomes += 1;
    } else if (world.arms[i] === 'treatment') treatment += 1;
    else control += 1;
  });
  return { nDistrict: Math.max(control, treatment), nHomes };
}

/** Lots for every couple: control on the left, treatment on the right, and new homes at the foot
 * of the plaza between them for the remarried couples in `homes` (all of them when omitted), each
 * zone in couple id order, with `cols` lots per district row. */
export function buildLayout(world: WorldShape, homes?: Set<number>, cols: number = DISTRICT_COLS): TownLayout {
  const control: number[] = [];
  const treatment: number[] = [];
  const newhomes: number[] = [];
  world.couples.forEach((_, i) => {
    if (world.origin[i] === 'remarriage') {
      if (!homes || homes.has(i)) newhomes.push(i);
    }
    else if (world.arms[i] === 'treatment') treatment.push(i);
    else control.push(i);
  });
  const order: Record<Zone, number[]> = {
    control: byCoupleId(world, control),
    treatment: byCoupleId(world, treatment),
    newhomes: byCoupleId(world, newhomes),
  };
  const districtRows = Math.max(1, Math.ceil(Math.max(order.control.length, order.treatment.length) / cols));
  const districtW = cols * LOT_W;
  const districtH = districtRows * LOT_H;
  const plazaW = PLAZA_COLS * LOT_W;
  const homeRows = Math.ceil(order.newhomes.length / PLAZA_COLS);
  const plazaH = Math.max(districtH, (homeRows + MIN_OPEN_ROWS) * LOT_H);
  const top = MARGIN + TITLE_BAND;
  const controlRect: Rect = { x: MARGIN, y: top, w: districtW, h: districtH };
  const plaza: Rect = { x: controlRect.x + districtW + GUTTER, y: top, w: plazaW, h: plazaH };
  const treatmentRect: Rect = { x: plaza.x + plazaW + GUTTER, y: top, w: districtW, h: districtH };
  const newHomes: Rect = { x: plaza.x, y: plaza.y + plazaH - homeRows * LOT_H, w: plazaW, h: homeRows * LOT_H };
  const openH = newHomes.y - plaza.y;
  const singles: Rect = { x: plaza.x + 12, y: plaza.y + 24, w: plazaW - 24, h: Math.max(LOT_H, openH * 0.58 - 24) };
  const dating: Rect = { x: plaza.x + 16, y: singles.y + singles.h + 12, w: plazaW - 32, h: Math.max(LOT_H / 2, newHomes.y - (singles.y + singles.h + 12) - 16) };
  const lots: (Lot | undefined)[] = new Array(world.couples.length);
  const place = (zone: Zone, rect: Rect, cols: number) => {
    order[zone].forEach((idx, k) => {
      const col = k % cols;
      const row = Math.floor(k / cols);
      lots[idx] = { idx, zone, k, col, row, x: rect.x + col * LOT_W, y: rect.y + row * LOT_H };
    });
  };
  place('control', controlRect, cols);
  place('treatment', treatmentRect, cols);
  place('newhomes', newHomes, PLAZA_COLS);
  return {
    width: treatmentRect.x + districtW + MARGIN,
    height: top + plazaH + MARGIN,
    districtCols: cols,
    control: controlRect,
    treatment: treatmentRect,
    plaza,
    singles,
    dating,
    newHomes,
    lots,
    order,
  };
}

export interface AgentInfo {
  id: number;
  /** World indices of every couple this agent was in, by the day it formed. */
  couples: number[];
  /** Which member of each of those couples this agent was. */
  sides: Member[];
  /** Arm of the agent's first couple, or null when unknown. */
  homeArm: Arm | null;
}

/** Every agent and the couples it belonged to, from the couples table. Without the table each
 * couple gets two stand-in agents of its own, so the town still draws but cannot follow a
 * divorced agent into a new couple. */
export function buildAgents(world: WorldShape, rows: CoupleRow[] | null): AgentInfo[] {
  const indexOf = new Map<number, number>();
  world.couples.forEach((id, i) => indexOf.set(id, i));
  if (!rows || rows.length === 0) {
    return world.couples.flatMap((_, i) =>
      (['a', 'b'] as Member[]).map((side, s) => ({ id: -(2 * i + s + 1), couples: [i], sides: [side], homeArm: world.arms[i] ?? null })),
    );
  }
  const memberships = new Map<number, { idx: number; side: Member; formed: number; couple: number }[]>();
  for (const r of rows) {
    const idx = indexOf.get(r.couple_id);
    if (idx === undefined) continue;
    for (const [agent, side] of [
      [r.agent_a, 'a'],
      [r.agent_b, 'b'],
    ] as [number, Member][]) {
      const list = memberships.get(agent) ?? [];
      list.push({ idx, side, formed: r.formed_day, couple: r.couple_id });
      memberships.set(agent, list);
    }
  }
  const agents: AgentInfo[] = [];
  for (const id of [...memberships.keys()].sort((p, q) => p - q)) {
    const list = memberships.get(id)!.sort((p, q) => p.formed - q.formed || p.couple - q.couple);
    const first = list.find((m) => world.origin[m.idx] !== 'remarriage') ?? list[0];
    agents.push({ id, couples: list.map((m) => m.idx), sides: list.map((m) => m.side), homeArm: world.arms[first.idx] ?? null });
  }
  return agents;
}

export interface Placement {
  x: number;
  y: number;
  posture: Posture;
  /** World index of the couple the agent is with today, or null when single. */
  couple: number | null;
  /** 1 faces right, -1 faces left. */
  facing: 1 | -1;
}

/** A stable pseudo-random number in [0, 1) from an integer, so layouts never depend on order. */
export function hash01(n: number, salt = 0): number {
  let h = (n | 0) ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Which member walks out to the plaza edge when a couple separates: a fixed layout choice by
 * couple id, since the states carry who is separated but not who left. */
export function leaver(coupleId: number): Member {
  return coupleId % 2 === 0 ? 'b' : 'a';
}

function edgeX(layout: TownLayout, lot: Lot): number {
  const { plaza } = layout;
  const step = (lot.col % 3) * 7;
  const leftSide = lot.zone === 'control' || (lot.zone === 'newhomes' && lot.col < PLAZA_COLS / 2);
  return leftSide ? plaza.x + 10 + step : plaza.x + plaza.w - 10 - step;
}

function clampY(layout: TownLayout, y: number): number {
  const lo = layout.plaza.y + 20;
  const hi = layout.newHomes.y - 8;
  return Math.min(Math.max(y, lo), Math.max(lo, hi));
}

/** Where a single agent stands in the plaza: a fixed spot per agent. */
export function singleSpot(layout: TownLayout, agentId: number): { x: number; y: number } {
  const r = layout.singles;
  return { x: r.x + 8 + hash01(agentId, 1) * Math.max(1, r.w - 16), y: r.y + 16 + hash01(agentId, 2) * Math.max(1, r.h - 16) };
}

/** Where a dating pair walks in the plaza: a fixed spot per couple. */
export function datingSpot(layout: TownLayout, coupleId: number): { x: number; y: number } {
  const r = layout.dating;
  return { x: r.x + 14 + hash01(coupleId, 3) * Math.max(1, r.w - 28), y: r.y + 16 + hash01(coupleId, 4) * Math.max(1, r.h - 16) };
}

/** Today's place and posture for one agent, from the states string of one day. */
export function placeAgent(agent: AgentInfo, states: string, layout: TownLayout, coupleIds: number[]): Placement {
  for (let j = agent.couples.length - 1; j >= 0; j--) {
    const idx = agent.couples[j];
    const ch = states[idx] ?? '-';
    if (ch === '-') continue;
    if (ch === 'D' || ch === 'B') break;
    const lot = layout.lots[idx];
    const side = agent.sides[j];
    const coupleId = coupleIds[idx];
    if (ch === 'T' || !lot) {
      const spot = datingSpot(layout, coupleId);
      return { x: spot.x + (side === 'a' ? -6 : 6), y: spot.y, posture: 'dating', couple: idx, facing: side === 'a' ? 1 : -1 };
    }
    if (ch === 'C') {
      return side === 'a'
        ? { x: lot.x + 5, y: lot.y + 53, posture: 'conflict', couple: idx, facing: -1 }
        : { x: lot.x + 43, y: lot.y + 53, posture: 'conflict', couple: idx, facing: 1 };
    }
    if (ch === 'S' && side === leaver(coupleId)) {
      return { x: edgeX(layout, lot), y: clampY(layout, lot.y + 50), posture: 'away', couple: idx, facing: lot.zone === 'treatment' ? -1 : 1 };
    }
    // Married, or the partner who stayed home during a separation.
    return side === 'a'
      ? { x: lot.x + 15, y: lot.y + 51, posture: 'home', couple: idx, facing: 1 }
      : { x: lot.x + 31, y: lot.y + 51, posture: 'home', couple: idx, facing: -1 };
  }
  const spot = singleSpot(layout, agent.id);
  return { x: spot.x, y: spot.y, posture: 'single', couple: null, facing: hash01(agent.id, 5) < 0.5 ? -1 : 1 };
}

export interface HouseState {
  visible: boolean;
  dim: boolean;
  conflict: boolean;
}

/** A first-marriage house always stands and dims on divorce; a new home appears at the wedding. */
export function houseState(ch: string, origin: Origin): HouseState {
  const married = ch === 'M' || ch === 'C' || ch === 'S' || ch === 'D';
  return { visible: origin === 'remarriage' ? married : true, dim: ch === 'D', conflict: ch === 'C' };
}

/** World units a walking figure covers per second, or null when figures jump straight to their
 * place (at 50 days a second a day lasts one frame). */
export function walkSpeed(speed: number): number | null {
  if (speed >= 50) return null;
  if (speed >= 10) return 2400;
  return 700;
}

/** Jump instead of walking when the day moved by more than one (a scrub or a key press of ten). */
export function shouldSnap(prevDay: number | null, day: number, speed: number): boolean {
  return prevDay === null || Math.abs(day - prevDay) > 1 || walkSpeed(speed) === null;
}

/** One frame of walking toward a target; returns the new position and whether it is still moving. */
export function stepToward(x: number, y: number, tx: number, ty: number, maxStep: number): [number, number, boolean] {
  const dx = tx - x;
  const dy = ty - y;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxStep || dist < 0.01) return [tx, ty, false];
  return [x + (dx / dist) * maxStep, y + (dy / dist) * maxStep, true];
}

/** True when the figure sprites are too small to read at this zoom; people are then drawn as dots. */
export function roofsOnly(scale: number): boolean {
  return LOT_W * scale < ROOFS_ONLY_BELOW;
}

/** Colour of a person drawn as a dot: the couple's arm colour at home, yellow in a conflict, a warm
 * red when one partner has walked out, and a plaza neutral for singles and dating pairs. */
export function dotTint(posture: Posture, arm: Arm | null, origin: Origin | null): number {
  switch (posture) {
    case 'home':
      return origin === 'remarriage' ? 0x8e6bd6 : arm === 'treatment' ? 0xeb6834 : 0x2a78d6;
    case 'conflict':
      return 0xf6c945;
    case 'away':
      return 0xd35400;
    default:
      return 0x3b3b3b;
  }
}

/** World width of a ring around a house, so it reads about `px` screen pixels wide when zoomed out and never thinner than `px` world units when zoomed in. */
export function ringWidth(scale: number, px = 3): number {
  return Math.max(px, px / Math.max(scale, 1e-6));
}

/** World size of a dot so it reads about `px` screen pixels across at `scale`. */
export function dotWorldSize(scale: number, px = 6): number {
  return px / Math.max(scale, 1e-6);
}

/** The couple whose lot contains a world point, or null. */
export function lotAt(layout: TownLayout, wx: number, wy: number): number | null {
  const zones: [Zone, Rect, number][] = [
    ['control', layout.control, layout.districtCols],
    ['treatment', layout.treatment, layout.districtCols],
    ['newhomes', layout.newHomes, PLAZA_COLS],
  ];
  for (const [zone, r, cols] of zones) {
    if (wx < r.x || wy < r.y || wx >= r.x + r.w || wy >= r.y + r.h) continue;
    const k = Math.floor((wy - r.y) / LOT_H) * cols + Math.floor((wx - r.x) / LOT_W);
    const idx = layout.order[zone][k];
    return idx === undefined ? null : idx;
  }
  return null;
}

/** Plain words for a state letter, as the grid legend uses them. */
export function stateWords(ch: string): string {
  switch (ch) {
    case 'M':
      return 'married, at home';
    case 'C':
      return 'married, in a conflict, both outside';
    case 'S':
      return 'separated, one partner waiting at the plaza edge';
    case 'D':
      return 'divorced, both partners single in the plaza';
    case 'T':
      return 'dating in the plaza';
    case 'B':
      return 'broken up';
    default:
      return 'not formed yet';
  }
}

/** Keyboard order over every lot: the control district row by row, then the new homes, then the
 * treatment district, so Left and Right walk the town from one side to the other. */
export function focusOrder(layout: TownLayout): number[] {
  return [...layout.order.control, ...layout.order.newhomes, ...layout.order.treatment];
}

/** The next keyboard focus for a key, as a position in `order`, 'open' for Enter or Space, or null
 * for a key the town does not use. Up and Down stay inside the current zone. */
export function moveFocus(layout: TownLayout, order: number[], cur: number, key: string): number | 'open' | null {
  if (order.length === 0) return null;
  const here = layout.lots[order[cur]];
  const cols = here?.zone === 'newhomes' ? PLAZA_COLS : layout.districtCols;
  const sameZone = (k: number) => k >= 0 && k < order.length && layout.lots[order[k]]?.zone === here?.zone;
  switch (key) {
    case 'ArrowRight':
      return Math.min(order.length - 1, cur + 1);
    case 'ArrowLeft':
      return Math.max(0, cur - 1);
    case 'ArrowDown':
      return sameZone(cur + cols) ? cur + cols : cur;
    case 'ArrowUp':
      return sameZone(cur - cols) ? cur - cols : cur;
    case 'Home':
      return 0;
    case 'End':
      return order.length - 1;
    case 'Enter':
    case ' ':
      return 'open';
    default:
      return null;
  }
}

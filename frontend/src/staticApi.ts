// The read-only demo's data layer. The free demo on GitHub Pages has no server: python/loveworld/static_site.py
// asked the real API for every response the read-only pages make and wrote each one gzipped under data/. This
// module maps each api.ts read to its file, inflates it with DecompressionStream, and answers the one read a
// file cannot answer as is, /api/couples, by the server's rules: filters, a stable sort, then offset and limit.
// Every write (run, fork, translate, job status) is refused with a plain message, since nothing can run here.
import type { CoupleRow, CouplesResponse, EventsDayResponse, LensData, ShockSpec } from './types';

/** One lens of one world: the headers the server sends with its bytes, or the 404 it answers. */
export interface StaticLensEntry {
  headers?: Record<string, string>;
  status?: number;
  detail?: string;
}

export interface StaticWorld {
  name: string;
  days: number;
  couples: number;
  agents: number;
  /** The couples table's columns, which /api/couples may sort by. */
  couples_columns: string[];
  lenses: Record<string, StaticLensEntry>;
}

/** Where a pre-run shock's translation came from: the saved record, never a new model call. */
export interface DemoTranslation {
  translation_id: string;
  model: string;
  /** When the record was written, for example 2026-10-12T01:33:33-07:00. */
  recorded: string;
  rationale: string;
  words: string;
}

/** One pre-run shock, as experiments/demo/ freezes it and the Try a shock panel shows it. */
export interface DemoCard {
  name: string;
  order: number;
  title: string;
  /**
   * The request in plain words. When `typed` is true they are the words someone typed, as far as the
   * translation record's fingerprint can tell. The fingerprint is a SHA-256 of the text lowercased with its
   * spacing collapsed, so it cannot check case or spacing.
   */
  words: string;
  typed: boolean;
  parent: string;
  hits: 'treatment' | 'all';
  shocks: ShockSpec[];
  note: string;
  translation: DemoTranslation | null;
}

export interface StaticIndex {
  format: number;
  default: string;
  event_chunk_days: number;
  couples_page: number;
  quickstart: string;
  worlds: StaticWorld[];
  demos: DemoCard[];
}

/** A read the demo answers with an error, the way the server would: a status and a plain detail. */
export class StaticError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'StaticError';
    this.status = status;
    this.detail = detail;
  }
}

/** What every write answers here. */
export const READ_ONLY_DETAIL = 'This is a read-only demo with no server, so nothing can run, fork or translate here. The README quickstart shows how to run LoveWorld with the shock box.';

/** Where a read is answered from. */
export type StaticRoute =
  | { kind: 'file'; file: string }
  | { kind: 'couples'; world: StaticWorld; file: string; params: URLSearchParams }
  | { kind: 'day'; file: string; day: number }
  | { kind: 'empty-day'; day: number }
  | { kind: 'lens'; world: StaticWorld; file: string; lens: string; headers: Record<string, string> }
  | { kind: 'error'; status: number; detail: string };

const WORLD_FILES: Record<string, string> = {
  '/experiment': 'experiment',
  '/ate': 'ate',
  '/curves': 'curves',
  '/distributions': 'distributions',
  '/policy': 'policy',
  '/world': 'world',
  '/twins/world': 'twins-world',
  '/digest': 'digest',
};
const GLOBAL_FILES: Record<string, string> = {
  '/experiments': 'experiments',
  '/health': 'health',
  '/shocks/catalog': 'shocks-catalog',
  '/lenses': 'lenses',
};

/** Python's repr of a name, as the server's messages quote it. */
function pyRepr(s: string): string {
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function isInt(s: string | null): s is string {
  return s !== null && /^-?\d+$/.test(s.trim());
}

/**
 * Map one api.ts read (a path relative to /api with its query, the method, and the world it is scoped to) to
 * the exported file that answers it, or to the error the server would give. Pure, so the mapping is tested
 * without a network.
 */
export function routeFor(path: string, method: string, world: string | null, index: StaticIndex): StaticRoute {
  const url = new URL(path, 'http://static.invalid');
  const p = url.pathname;
  const q = url.searchParams;
  if (method.toUpperCase() !== 'GET' || p.startsWith('/jobs/') || p === '/jobs') return { kind: 'error', status: 405, detail: READ_ONLY_DETAIL };
  if (GLOBAL_FILES[p]) return { kind: 'file', file: `${GLOBAL_FILES[p]}.json.gz` };
  const name = world ?? index.default;
  const w = index.worlds.find((x) => x.name === name);
  const scoped = WORLD_FILES[p] !== undefined || /^\/(couples|agents|events|lens)(\/|$)/.test(p);
  if (!scoped) return { kind: 'error', status: 404, detail: 'unknown API route' };
  if (!w) return { kind: 'error', status: 404, detail: `unknown experiment ${pyRepr(name)}` };
  const dir = `w/${w.name}`;
  if (WORLD_FILES[p]) return { kind: 'file', file: `${dir}/${WORLD_FILES[p]}.json.gz` };
  if (p === '/couples') return { kind: 'couples', world: w, file: `${dir}/couples.json.gz`, params: q };
  const couple = p.match(/^\/couples\/([^/]+)$/);
  if (couple) {
    if (!isInt(couple[1])) return { kind: 'error', status: 422, detail: 'couple_id must be an integer' };
    return { kind: 'file', file: `${dir}/couples/${Number(couple[1])}.json.gz` };
  }
  const agent = p.match(/^\/agents\/([^/]+)$/);
  if (agent) {
    if (!isInt(agent[1])) return { kind: 'error', status: 422, detail: 'agent_id must be an integer' };
    return { kind: 'file', file: `${dir}/agents/${Number(agent[1])}.json.gz` };
  }
  if (p === '/events') {
    const day = q.get('day');
    if (day === null) {
      if (q.has('from') || q.has('to')) return { kind: 'error', status: 404, detail: 'this demo lists events one day at a time (?day=N)' };
      return { kind: 'error', status: 400, detail: 'pass ?day=N or ?from=A&to=B' };
    }
    if (!isInt(day) || Number(day) < 0) return { kind: 'error', status: 422, detail: 'day must be an integer of at least 0' };
    const d = Number(day);
    if (d >= w.days) return { kind: 'empty-day', day: d };
    return { kind: 'day', file: `${dir}/events/${Math.floor(d / index.event_chunk_days)}.json.gz`, day: d };
  }
  const lens = p.match(/^\/lens\/([^/]+)$/);
  if (lens) {
    const lensName = decodeURIComponent(lens[1]);
    const entry = w.lenses[lensName];
    if (!entry) return { kind: 'error', status: 404, detail: `unknown lens ${pyRepr(lensName)}` };
    if (!entry.headers) return { kind: 'error', status: entry.status ?? 404, detail: entry.detail ?? `no ${lensName} lens for this run` };
    return { kind: 'lens', world: w, file: `${dir}/lens/${lensName}.bin.gz`, lens: lensName, headers: entry.headers };
  }
  return { kind: 'error', status: 404, detail: 'unknown API route' };
}

/** The 404 a detail read answers for an id the run does not have, in the server's words. */
export function missingDetail(path: string): string {
  const m = new URL(path, 'http://static.invalid').pathname.match(/^\/(couples|agents)\/(-?\d+)$/);
  if (m) return `${m[1] === 'couples' ? 'couple' : 'agent'} ${Number(m[2])} not found`;
  return 'Not Found';
}

type Cell = string | number | boolean | null | undefined;

/** pandas' order for one column: numbers by value, text by code unit, missing values last. */
function compareCells(a: Cell, b: Cell): number {
  const na = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a));
  const nb = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b));
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * GET /api/couples by the server's rules, over every couple in table order: `arm`, `state` (the final state)
 * and `origin` keep rows equal to the value when given, `sort` (a column, couple_id by default) orders them
 * with a stable sort that puts missing values last, then `offset` (from 0) and `limit` (1 to 10,000, 100 by
 * default) take the page, and `total` counts every row that passed the filters.
 */
export function queryCouples(rows: CoupleRow[], columns: string[], params: URLSearchParams, maxLimit = 10000): CouplesResponse {
  const limitRaw = params.get('limit');
  const offsetRaw = params.get('offset');
  if (limitRaw !== null && !isInt(limitRaw)) throw new StaticError(422, 'limit must be an integer');
  if (offsetRaw !== null && !isInt(offsetRaw)) throw new StaticError(422, 'offset must be an integer');
  const limit = limitRaw === null ? 100 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (limit < 1 || limit > maxLimit) throw new StaticError(422, `limit must be between 1 and ${maxLimit}`);
  if (offset < 0) throw new StaticError(422, 'offset must be at least 0');
  const sort = params.get('sort') ?? 'couple_id';
  if (!columns.includes(sort)) throw new StaticError(400, `unknown sort column ${pyRepr(sort)}`);
  let out = rows;
  const filters: [string, keyof CoupleRow][] = [
    ['arm', 'arm'],
    ['state', 'final_state'],
    ['origin', 'origin'],
  ];
  for (const [param, column] of filters) {
    const value = params.get(param);
    if (value !== null) out = out.filter((r) => r[column] === value);
  }
  // Array.prototype.sort is stable, as the server's sort is; ties keep the table's order.
  const sorted = [...out].sort((a, b) => compareCells((a as unknown as Record<string, Cell>)[sort], (b as unknown as Record<string, Cell>)[sort]));
  return { total: sorted.length, items: sorted.slice(offset, offset + limit) };
}

/** What a page says when the browser cannot inflate the demo's files. */
export const OLD_BROWSER_DETAIL = 'this browser cannot read the demo files; it needs a 2023 or later Chrome, Firefox or Safari';

/** Inflate a gzipped file. Bytes that are not gzip are returned as they are (a server that already inflated them). */
export async function inflate(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  // DecompressionStream arrived in Safari 16.4 and Firefox 113, in 2023; without it the page says so plainly.
  if (typeof DecompressionStream === 'undefined') throw new StaticError(500, OLD_BROWSER_DETAIL);
  const body = new Response(bytes).body;
  if (!body) throw new StaticError(500, OLD_BROWSER_DETAIL);
  const stream = body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const decoder = new TextDecoder();

/** The URL of an exported file, under the site's base path. */
export function dataUrl(file: string, base: string = import.meta.env.BASE_URL): string {
  return `${base.endsWith('/') ? base : `${base}/`}data/${file}`;
}

function abortError(): DOMException {
  return new DOMException('The read was aborted.', 'AbortError');
}

async function fetchBytes(file: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(dataUrl(file), signal ? { signal } : undefined);
  if (!res.ok) throw new StaticError(res.status, res.status === 404 ? 'Not Found' : res.statusText || `status ${res.status}`);
  return inflate(await res.arrayBuffer());
}

async function fetchJsonFile<T>(file: string, signal?: AbortSignal): Promise<T> {
  const bytes = await fetchBytes(file, signal);
  return JSON.parse(decoder.decode(bytes)) as T;
}

/** A small cache of promises that forgets a failed one, so a retry asks again. */
class PromiseCache<T> {
  private map = new Map<string, Promise<T>>();
  constructor(private max: number) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const p = load();
    this.map.set(key, p);
    p.catch(() => {
      if (this.map.get(key) === p) this.map.delete(key);
    });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return p;
  }
  clear(): void {
    this.map.clear();
  }
}

const indexCache = new PromiseCache<StaticIndex>(1);
const couplesCache = new PromiseCache<CoupleRow[]>(4);
const chunkCache = new PromiseCache<{ from: number; to: number; days: EventsDayResponse[] }>(8);

/** The site's index: its worlds, the default world and the pre-run shocks. */
export function loadIndex(): Promise<StaticIndex> {
  return indexCache.get('index', () => fetchJsonFile<StaticIndex>('index.json.gz'));
}

/** Forget every cached file (tests). */
export function resetStaticCaches(): void {
  indexCache.clear();
  couplesCache.clear();
  chunkCache.clear();
}

/** Answer one api.ts read from the exported files; throws StaticError for anything the server would refuse. */
export async function readStatic(path: string, method: string, world: string | null, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw abortError();
  const index = await loadIndex();
  const route = routeFor(path, method, world, index);
  try {
    switch (route.kind) {
      case 'error':
        throw new StaticError(route.status, route.detail);
      case 'file':
        return await fetchJsonFile(route.file, signal);
      case 'couples': {
        const rows = await couplesCache.get(route.file, async () => (await fetchJsonFile<CouplesResponse>(route.file)).items);
        return queryCouples(rows, route.world.couples_columns, route.params, index.couples_page);
      }
      case 'empty-day':
        return { day: route.day, items: [] };
      case 'day': {
        const chunk = await chunkCache.get(route.file, () => fetchJsonFile(route.file));
        if (signal?.aborted) throw abortError();
        const found = chunk.days[route.day - chunk.from];
        if (!found) throw new StaticError(500, `the events file for day ${route.day} does not hold it`);
        return found;
      }
      case 'lens':
        return await readLens(route, signal);
    }
  } catch (err) {
    if (err instanceof StaticError && err.status === 404 && route.kind === 'file') throw new StaticError(404, missingDetail(path));
    throw err;
  }
}

async function readLens(route: Extract<StaticRoute, { kind: 'lens' }>, signal?: AbortSignal): Promise<LensData> {
  const bytes = await fetchBytes(route.file, signal);
  const num = (h: string) => Number(route.headers[h]);
  const days = num('X-Lens-Days');
  const couples = num('X-Lens-Couples');
  if (!Number.isFinite(days) || !Number.isFinite(couples) || bytes.length !== days * couples) {
    throw new StaticError(500, `the ${route.lens} lens file holds ${bytes.length} bytes for ${days} days of ${couples} couples`);
  }
  return { name: route.lens, days, couples, lo: num('X-Lens-Lo'), hi: num('X-Lens-Hi'), worseHigh: route.headers['X-Lens-Worse-High'] === '1', bytes };
}

/** The pre-run shocks, in their order, for the World page's Try a shock panel. */
export async function demoCards(): Promise<DemoCard[]> {
  return [...(await loadIndex()).demos].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

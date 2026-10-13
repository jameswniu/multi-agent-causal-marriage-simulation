// Tests for the read-only demo's data layer (staticApi.ts): which exported file answers each read, the
// server's rules for /api/couples done in the page, the events of a day found in their chunk, gzip
// inflated in the page, and every write refused. A small site is served from memory through a stubbed fetch.
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OLD_BROWSER_DETAIL, READ_ONLY_DETAIL, StaticError, dataUrl, inflate, queryCouples, readStatic, resetStaticCaches, routeFor, type StaticIndex } from '../staticApi';
import type { CoupleRow } from '../types';

const COLUMNS = ['couple_id', 'agent_a', 'agent_b', 'arm', 'origin', 'formed_day', 'married_day', 'compatibility', 'final_state', 'ended_day', 'years_married_at_start'];

function row(id: number, arm: 'control' | 'treatment' | null, state: CoupleRow['final_state'], ended: number | null, compat: number): CoupleRow {
  return { couple_id: id, agent_a: 2 * id, agent_b: 2 * id + 1, arm, origin: arm ? 'initial' : 'remarriage', formed_day: arm ? -400 : 100 + id, married_day: arm ? -380 : null, compatibility: compat, final_state: state, ended_day: ended, years_married_at_start: 1 };
}

/** Seven couples in table order: ties in compatibility, missing end days, two remarriages without an arm. */
const ROWS: CoupleRow[] = [
  row(0, 'control', 'married', null, 0.5),
  row(1, 'treatment', 'divorced', 120, 0.7),
  row(2, 'control', 'divorced', 40, 0.5),
  row(3, 'treatment', 'married', null, 0.2),
  row(4, 'treatment', 'separated', null, 0.7),
  row(5, null, 'dating', null, 0.9),
  row(6, null, 'broken_up', 300, 0.5),
];

const INDEX: StaticIndex = {
  format: 1,
  default: 'example',
  event_chunk_days: 10,
  couples_page: 10000,
  quickstart: 'https://example.invalid/#run-it',
  worlds: [
    {
      name: 'example',
      days: 25,
      couples: ROWS.length,
      agents: 14,
      couples_columns: COLUMNS,
      lenses: {
        trust: { headers: { 'X-Lens-Days': '2', 'X-Lens-Couples': '3', 'X-Lens-Lo': '0.0', 'X-Lens-Hi': '1.0', 'X-Lens-Worse-High': '0' } },
        orphan_days: { status: 404, detail: 'this run has no days without warmth column (an older engine wrote it)' },
      },
    },
    { name: 'demo-layoff', days: 25, couples: ROWS.length, agents: 14, couples_columns: COLUMNS, lenses: {} },
  ],
  demos: [],
};

const gz = (value: unknown) => new Uint8Array(gzipSync(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))));
const dayResponse = (d: number) => ({ day: d, items: [{ day: d, seq: 0, couple_id: d % 3, agent_id: null, kind: 'conflict_started', from_state: null, to_state: null, value: null }] });

/** The exported site, by file under data/. */
function site(): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  files.set('index.json.gz', gz(INDEX));
  files.set('experiments.json.gz', gz({ default: 'example', items: [] }));
  files.set('w/example/world.json.gz', gz({ days: 25, couples: [0, 1, 2], states: ['MMM'] }));
  files.set('w/demo-layoff/world.json.gz', gz({ days: 25, couples: [0, 1, 2], states: ['MCM'] }));
  files.set('w/example/couples.json.gz', gz({ total: ROWS.length, items: ROWS }));
  files.set('w/example/couples/3.json.gz', gz({ couple: ROWS[3], daily: [] }));
  for (const k of [0, 1, 2]) {
    const from = k * 10;
    const to = Math.min(24, from + 9);
    const days = Array.from({ length: to - from + 1 }, (_, i) => dayResponse(from + i));
    files.set(`w/example/events/${k}.json.gz`, gz({ from, to, days }));
  }
  files.set('w/example/lens/trust.bin.gz', new Uint8Array(gzipSync(Buffer.from([0, 127, 254, 255, 10, 20]))));
  return files;
}

let requested: string[] = [];

beforeEach(() => {
  resetStaticCaches();
  requested = [];
  const files = site();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url);
      const file = url.replace(/^\/data\//, '');
      const body = files.get(file);
      return body ? new Response(body, { status: 200, headers: { 'Content-Type': 'application/gzip' } }) : new Response('<!doctype html>404', { status: 404, statusText: 'Not Found' });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which file answers each read', () => {
  it('maps every read the pages make to its exported file, scoped to the world', () => {
    const r = (path: string, world: string | null = 'example') => routeFor(path, 'GET', world, INDEX);
    expect(r('/experiments')).toEqual({ kind: 'file', file: 'experiments.json.gz' });
    expect(r('/health')).toEqual({ kind: 'file', file: 'health.json.gz' });
    expect(r('/shocks/catalog')).toEqual({ kind: 'file', file: 'shocks-catalog.json.gz' });
    expect(r('/lenses')).toEqual({ kind: 'file', file: 'lenses.json.gz' });
    for (const [path, stem] of [['/experiment', 'experiment'], ['/ate', 'ate'], ['/curves', 'curves'], ['/distributions', 'distributions'], ['/policy', 'policy'], ['/world', 'world'], ['/twins/world', 'twins-world'], ['/digest', 'digest']]) {
      expect(r(path, 'demo-layoff')).toEqual({ kind: 'file', file: `w/demo-layoff/${stem}.json.gz` });
    }
    expect(r('/couples/12')).toEqual({ kind: 'file', file: 'w/example/couples/12.json.gz' });
    expect(r('/agents/25', 'demo-layoff')).toEqual({ kind: 'file', file: 'w/demo-layoff/agents/25.json.gz' });
    expect(r('/couples?limit=50&offset=50&sort=couple_id')).toMatchObject({ kind: 'couples', file: 'w/example/couples.json.gz' });
    // With no world named, a read goes to the site's default world, as the server's default experiment.
    expect(r('/world', null)).toEqual({ kind: 'file', file: 'w/example/world.json.gz' });
  });

  it('finds a day in the chunk of ten that holds it, and answers days past the run with no events', () => {
    const r = (path: string) => routeFor(path, 'GET', 'example', INDEX);
    expect(r('/events?day=0')).toEqual({ kind: 'day', file: 'w/example/events/0.json.gz', day: 0 });
    expect(r('/events?day=9')).toEqual({ kind: 'day', file: 'w/example/events/0.json.gz', day: 9 });
    expect(r('/events?day=10')).toEqual({ kind: 'day', file: 'w/example/events/1.json.gz', day: 10 });
    expect(r('/events?day=24')).toEqual({ kind: 'day', file: 'w/example/events/2.json.gz', day: 24 });
    expect(r('/events?day=25')).toEqual({ kind: 'empty-day', day: 25 });
    expect(r('/events?day=-1')).toMatchObject({ kind: 'error', status: 422 });
    expect(r('/events?day=x')).toMatchObject({ kind: 'error', status: 422 });
    expect(r('/events')).toMatchObject({ kind: 'error', status: 400 });
  });

  it('answers lenses with their headers, and says which the run lacks', () => {
    expect(routeFor('/lens/trust', 'GET', 'example', INDEX)).toMatchObject({ kind: 'lens', file: 'w/example/lens/trust.bin.gz', lens: 'trust' });
    expect(routeFor('/lens/orphan_days', 'GET', 'example', INDEX)).toEqual({ kind: 'error', status: 404, detail: 'this run has no days without warmth column (an older engine wrote it)' });
    expect(routeFor('/lens/nope', 'GET', 'example', INDEX)).toEqual({ kind: 'error', status: 404, detail: "unknown lens 'nope'" });
  });

  it('refuses every write and job, and names an unknown world as the server does', () => {
    for (const path of ['/experiments/run', '/experiments/fork', '/shocks/translate']) {
      expect(routeFor(path, 'POST', 'example', INDEX)).toEqual({ kind: 'error', status: 405, detail: READ_ONLY_DETAIL });
    }
    expect(routeFor('/jobs/abc', 'GET', 'example', INDEX)).toEqual({ kind: 'error', status: 405, detail: READ_ONLY_DETAIL });
    expect(routeFor('/world', 'GET', 'nope', INDEX)).toEqual({ kind: 'error', status: 404, detail: "unknown experiment 'nope'" });
    expect(routeFor('/nothing/here', 'GET', 'example', INDEX)).toEqual({ kind: 'error', status: 404, detail: 'unknown API route' });
  });
});

describe('/api/couples done in the page, by the server rules', () => {
  const q = (s: string) => queryCouples(ROWS, COLUMNS, new URLSearchParams(s));
  const ids = (s: string) => q(s).items.map((c) => c.couple_id);

  it('defaults to the first 100 by couple id and counts the total', () => {
    expect(q('')).toEqual({ total: 7, items: ROWS });
    expect(ids('limit=2&offset=3')).toEqual([3, 4]);
    expect(q('limit=2&offset=6')).toEqual({ total: 7, items: [ROWS[6]] });
    expect(q('offset=50').items).toEqual([]);
  });

  it('filters by arm, final state and origin, and an empty value keeps nothing', () => {
    expect(ids('arm=treatment')).toEqual([1, 3, 4]);
    expect(ids('state=divorced')).toEqual([1, 2]);
    expect(ids('origin=remarriage')).toEqual([5, 6]);
    expect(ids('arm=control&state=divorced')).toEqual([2]);
    expect(q('arm=').total).toBe(0);
    expect(q('arm=treatment&limit=1').total).toBe(3);
  });

  it('sorts stably, ties in table order and missing values last, before paging', () => {
    expect(ids('sort=compatibility')).toEqual([3, 0, 2, 6, 1, 4, 5]);
    expect(ids('sort=ended_day')).toEqual([2, 1, 6, 0, 3, 4, 5]);
    expect(ids('sort=arm')).toEqual([0, 2, 1, 3, 4, 5, 6]);
    expect(ids('sort=final_state&limit=3&offset=1')).toEqual([5, 1, 2]);
  });

  it('refuses what the server refuses: a bad limit or offset, and an unknown sort column', () => {
    const fails = (s: string, status: number) => {
      try {
        q(s);
      } catch (err) {
        expect(err).toBeInstanceOf(StaticError);
        expect((err as StaticError).status).toBe(status);
        return;
      }
      throw new Error(`expected ${s} to fail`);
    };
    fails('limit=0', 422);
    fails('limit=10001', 422);
    fails('limit=abc', 422);
    fails('offset=-1', 422);
    fails('sort=nope', 400);
  });
});

describe('reading the exported files', () => {
  it('inflates gzip, and passes bytes a server already inflated through unchanged', async () => {
    const text = new TextDecoder();
    expect(text.decode(await inflate(gz({ a: 1 })))).toBe('{"a":1}');
    const plain = new Uint8Array([123, 34, 97, 34, 58, 49, 125]);
    expect(Array.from(await inflate(plain))).toEqual(Array.from(plain));
    expect(dataUrl('index.json.gz', '/multi-agent-causal-marriage-simulation/')).toBe('/multi-agent-causal-marriage-simulation/data/index.json.gz');
    expect(dataUrl('w/example/world.json.gz')).toBe('/data/w/example/world.json.gz');
  });

  it('says plainly when the browser has no DecompressionStream to inflate the files with', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(inflate(gz({ a: 1 }))).rejects.toMatchObject({ name: 'StaticError', status: 500, detail: OLD_BROWSER_DETAIL });
    // Bytes a server already inflated need no DecompressionStream.
    expect(Array.from(await inflate(new Uint8Array([123, 125])))).toEqual([123, 125]);
  });

  it('answers a world read from its file, and couples pages from one download', async () => {
    expect(await readStatic('/world', 'GET', 'demo-layoff')).toEqual({ days: 25, couples: [0, 1, 2], states: ['MCM'] });
    expect(await readStatic('/couples?arm=treatment&limit=2&offset=0&sort=couple_id', 'GET', 'example')).toEqual({ total: 3, items: [ROWS[1], ROWS[3]] });
    expect(await readStatic('/couples?state=married&limit=100&offset=0&sort=couple_id', 'GET', 'example')).toEqual({ total: 2, items: [ROWS[0], ROWS[3]] });
    expect(requested.filter((u) => u.endsWith('/couples.json.gz'))).toHaveLength(1);
    expect(requested.every((u) => u.startsWith('/data/') && !u.includes('/api'))).toBe(true);
  });

  it('reads a day from its chunk, fetching each chunk once', async () => {
    expect(await readStatic('/events?day=3', 'GET', 'example')).toEqual(dayResponse(3));
    expect(await readStatic('/events?day=7', 'GET', 'example')).toEqual(dayResponse(7));
    expect(await readStatic('/events?day=12', 'GET', 'example')).toEqual(dayResponse(12));
    expect(await readStatic('/events?day=40', 'GET', 'example')).toEqual({ day: 40, items: [] });
    expect(requested.filter((u) => u.includes('/events/'))).toEqual(['/data/w/example/events/0.json.gz', '/data/w/example/events/1.json.gz']);
  });

  it('reads a lens as bytes with the headers the server sends', async () => {
    const lens = await readStatic('/lens/trust', 'GET', 'example');
    expect(lens).toEqual({ name: 'trust', days: 2, couples: 3, lo: 0, hi: 1, worseHigh: false, bytes: new Uint8Array([0, 127, 254, 255, 10, 20]) });
  });

  it('says an unknown couple is not found, in the server words, and refuses a write', async () => {
    await expect(readStatic('/couples/7', 'GET', 'example')).rejects.toMatchObject({ status: 404, detail: 'couple 7 not found' });
    await expect(readStatic('/agents/9', 'GET', 'example')).rejects.toMatchObject({ status: 404, detail: 'agent 9 not found' });
    await expect(readStatic('/experiments/fork', 'POST', 'example')).rejects.toMatchObject({ status: 405, detail: READ_ONLY_DETAIL });
  });

  it('stops a read whose signal is aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(readStatic('/events?day=3', 'GET', 'example', c.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('api.ts in the static build', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('answers reads from the files, never from /api, and refuses every write with a plain message', async () => {
    vi.stubEnv('VITE_STATIC', '1');
    vi.resetModules();
    const api = await import('../api');
    const statics = await import('../staticApi');
    statics.resetStaticCaches();
    api.setCurrentExperiment('demo-layoff');
    expect(await api.getWorld()).toEqual({ days: 25, couples: [0, 1, 2], states: ['MCM'] });
    expect(await api.getWorld('example')).toEqual({ days: 25, couples: [0, 1, 2], states: ['MMM'] });
    expect((await api.listCouples({ arm: 'control', limit: 10 }, 'example')).items.map((c) => c.couple_id)).toEqual([0, 2]);
    expect((await api.getLens('trust').catch((e: Error) => e)) instanceof Error).toBe(true);
    api.setCurrentExperiment('example');
    expect((await api.getLens('trust')).bytes).toEqual(new Uint8Array([0, 127, 254, 255, 10, 20]));
    await expect(api.forkExperiment({ parent: 'example', shocks: [] })).rejects.toMatchObject({ status: 405, message: `405 ${READ_ONLY_DETAIL} (/experiments/fork)` });
    await expect(api.translateShock('He loses his job', 365)).rejects.toMatchObject({ status: 405 });
    await expect(api.getJob('j1')).rejects.toMatchObject({ status: 405 });
    await expect(api.getCouple(99, 'example')).rejects.toMatchObject({ status: 404, message: '404 couple 99 not found (/couples/99)' });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((u) => u.startsWith('/data/'))).toBe(true);
  });

  it('tells a browser too old to inflate the files so, rather than reporting a network error', async () => {
    vi.stubEnv('VITE_STATIC', '1');
    vi.resetModules();
    const api = await import('../api');
    (await import('../staticApi')).resetStaticCaches();
    vi.stubGlobal('DecompressionStream', undefined);
    const err = (await api.listExperiments().catch((e: unknown) => e)) as Error & { status?: number };
    expect(err.status).toBe(500);
    expect(err.message).toBe(`500 ${OLD_BROWSER_DETAIL} (/experiments)`);
    expect(err.message).not.toMatch(/Network error/);
  });
});

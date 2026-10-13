// Typed wrappers over the FastAPI endpoints in docs/contracts.md sections 3, 5 and 6. In the read-only static
// build (staticMode.ts) every read is answered from exported files instead, and every write is refused.
import type {
  AgentDetailResponse,
  CoupleDetailResponse,
  CouplesQuery,
  CouplesResponse,
  Curves,
  DayDigest,
  Distributions,
  EventsDayResponse,
  ExperimentResponse,
  ExperimentsResponse,
  ForkRequest,
  HealthResponse,
  JobResponse,
  LensData,
  LensesResponse,
  Outcome,
  PolicySpec,
  RunRequest,
  ShocksCatalog,
  TranslateResponse,
  TwinsWorldResponse,
  WorldResponse,
} from './types';
import { takeTurnstileToken } from './turnstile';

export const API_BASE = '/api';

/** The experiment every request is scoped to (from the URL query, set by ExperimentProvider). */
let currentExperiment: string | null = null;

export function setCurrentExperiment(name: string | null): void {
  currentExperiment = name && name.length > 0 ? name : null;
}

export class ApiError extends Error {
  status: number;
  path: string;
  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/** With VITE_USE_FIXTURES=1 the app serves the test fixtures instead of calling the API (npm run dev:fixtures). */
const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === '1';
/** With VITE_STATIC=1 (the read-only demo) every read comes from exported files and every write is refused. */
const STATIC = import.meta.env.VITE_STATIC === '1';

/** Scope a request to `experiment` when given, else to the experiment in the URL. */
function withExperiment(path: string, experiment?: string | null): string {
  const name = experiment ?? currentExperiment;
  if (!name) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}experiment=${encodeURIComponent(name)}`;
}

async function fromFixtures<T>(path: string, init?: RequestInit, experiment?: string | null): Promise<T> {
  const m = await import('./test/mockApi');
  const url = new URL(path, 'http://fixtures');
  const q = url.searchParams;
  const p = url.pathname;
  if (p === '/experiment') return m.getExperiment() as Promise<T>;
  if (p === '/experiments') return m.listExperiments() as Promise<T>;
  if (p === '/experiments/run') return m.runExperiment(JSON.parse(String(init?.body ?? '{}')) as RunRequest) as Promise<T>;
  if (p === '/experiments/fork') return m.forkExperiment(JSON.parse(String(init?.body ?? '{}')) as ForkRequest) as Promise<T>;
  if (p === '/health') return m.getHealth() as Promise<T>;
  const job = p.match(/^\/jobs\/([A-Za-z0-9-]+)$/);
  if (job) return m.getJob(job[1]) as Promise<T>;
  if (p === '/shocks/catalog') return m.getShocksCatalog() as Promise<T>;
  if (p === '/shocks/translate') {
    const b = JSON.parse(String(init?.body ?? '{}')) as { text: string; days: number };
    return m.translateShock(b.text, b.days) as Promise<T>;
  }
  if (p === '/ate') return m.getAte() as Promise<T>;
  if (p === '/curves') return m.getCurves() as Promise<T>;
  if (p === '/distributions') return m.getDistributions() as Promise<T>;
  if (p === '/policy') return m.getPolicy() as Promise<T>;
  if (p === '/world') return m.getWorld(experiment ?? undefined) as Promise<T>;
  if (p === '/digest') return m.getDayDigest() as Promise<T>;
  if (p === '/lenses') return m.listLenses() as Promise<T>;
  if (p === '/twins/world') return m.getTwinsWorld() as Promise<T>;
  if (p === '/events') return m.getEventsForDay(Number(q.get('day'))) as Promise<T>;
  if (p === '/couples') {
    return m.listCouples(
      {
        arm: (q.get('arm') ?? '') as CouplesQuery['arm'],
        state: (q.get('state') ?? '') as CouplesQuery['state'],
        origin: (q.get('origin') ?? '') as CouplesQuery['origin'],
        limit: Number(q.get('limit') ?? 100),
        offset: Number(q.get('offset') ?? 0),
      },
      experiment ?? undefined,
    ) as Promise<T>;
  }
  const couple = p.match(/^\/couples\/(\d+)$/);
  if (couple) return m.getCouple(Number(couple[1]), experiment ?? undefined) as Promise<T>;
  const agent = p.match(/^\/agents\/(\d+)$/);
  if (agent) return m.getAgent(Number(agent[1])) as Promise<T>;
  throw new ApiError(404, path, `No fixture for ${path}`);
}

/** The static build's answer to a read: the exported file, or the error the server would give, as an ApiError. */
async function fromStatic<T>(path: string, init?: RequestInit, experiment?: string | null): Promise<T> {
  const s = await import('./staticApi');
  try {
    return (await s.readStatic(path, init?.method ?? 'GET', experiment ?? currentExperiment, init?.signal ?? undefined)) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof s.StaticError) throw new ApiError(err.status, path, `${err.status} ${err.detail} (${path})`);
    throw new ApiError(0, path, `Network error reaching ${path}: ${(err as Error).message}`);
  }
}

async function fetchJson<T>(path: string, init?: RequestInit, experiment?: string | null): Promise<T> {
  if (USE_FIXTURES) return fromFixtures<T>(path, init, experiment);
  if (STATIC) return fromStatic<T>(path, init, experiment);
  const full = withExperiment(path, experiment);
  const headers: Record<string, string> = { Accept: 'application/json', ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.method === 'POST') {
    // Public mode's edge proxy checks this token before a POST reaches the app; locally there is none.
    const token = await takeTurnstileToken();
    if (token) headers['cf-turnstile-response'] = token;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${full}`, { ...init, headers });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, path, `Network error reaching ${path}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body && typeof body.detail === 'string') detail = body.detail;
      else if (body && body.detail !== undefined) detail = JSON.stringify(body.detail);
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, path, `${res.status} ${detail} (${path})`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, path, `${path} did not return JSON (is this endpoint served?)`);
  }
}

export function getExperiment(): Promise<ExperimentResponse> {
  return fetchJson<ExperimentResponse>('/experiment');
}

export function listExperiments(): Promise<ExperimentsResponse> {
  return fetchJson<ExperimentsResponse>('/experiments');
}

export function getShocksCatalog(): Promise<ShocksCatalog> {
  return fetchJson<ShocksCatalog>('/shocks/catalog');
}

/** Turn a plain-words description into one shock for a run of `days` days (the model runs on the server). */
export function translateShock(text: string, days: number): Promise<TranslateResponse> {
  return fetchJson<TranslateResponse>('/shocks/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, days }) });
}

/** Whether the server runs in public mode, with its caps and bot-check site key. */
export function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>('/health');
}

/** Queue a fresh run; the answer is its job, which finishes on the server's run queue. */
export function runExperiment(body: RunRequest): Promise<JobResponse> {
  return fetchJson<JobResponse>('/experiments/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Queue a fork: the parent's world with shocks appended and nothing else changed. */
export function forkExperiment(body: ForkRequest): Promise<JobResponse> {
  return fetchJson<JobResponse>('/experiments/fork', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function getJob(id: string): Promise<JobResponse> {
  return fetchJson<JobResponse>(`/jobs/${encodeURIComponent(id)}`);
}


export function getAte(): Promise<Outcome[]> {
  return fetchJson<Outcome[]>('/ate');
}

export function getCurves(): Promise<Curves> {
  return fetchJson<Curves>('/curves');
}

export function getDistributions(): Promise<Distributions> {
  return fetchJson<Distributions>('/distributions');
}

export function getPolicy(): Promise<PolicySpec> {
  return fetchJson<PolicySpec>('/policy');
}

/** Couples of the experiment in the URL, or of `experiment` when given (the town of a world being compared). */
export function listCouples(q: CouplesQuery = {}, experiment?: string | null): Promise<CouplesResponse> {
  const params = new URLSearchParams();
  if (q.arm) params.set('arm', q.arm);
  if (q.state) params.set('state', q.state);
  if (q.origin) params.set('origin', q.origin);
  params.set('limit', String(q.limit ?? 100));
  params.set('offset', String(q.offset ?? 0));
  params.set('sort', q.sort ?? 'couple_id');
  return fetchJson<CouplesResponse>(`/couples?${params.toString()}`, undefined, experiment);
}

export function getCouple(id: number, experiment?: string | null): Promise<CoupleDetailResponse> {
  return fetchJson<CoupleDetailResponse>(`/couples/${id}`, undefined, experiment);
}

export function getAgent(id: number): Promise<AgentDetailResponse> {
  return fetchJson<AgentDetailResponse>(`/agents/${id}`);
}

/** Every couple's state on every day, for the experiment in the URL or for `experiment` (the world a fork came from). */
export function getWorld(experiment?: string | null): Promise<WorldResponse> {
  return fetchJson<WorldResponse>('/world', undefined, experiment);
}

export function getTwinsWorld(): Promise<TwinsWorldResponse> {
  return fetchJson<TwinsWorldResponse>('/twins/world');
}

export function getEventsForDay(day: number, signal?: AbortSignal): Promise<EventsDayResponse> {
  return fetchJson<EventsDayResponse>(`/events?day=${day}`, { signal });
}

/** Event counts per day, group and kind for the whole run, fetched once instead of a list per day. */
export function getDayDigest(): Promise<DayDigest> {
  return fetchJson<DayDigest>('/digest');
}

/** The colour views the town offers. */
export function listLenses(): Promise<LensesResponse> {
  return fetchJson<LensesResponse>('/lenses');
}

/** One lens for the whole run as bytes, one per couple per day (see LensData). */
export async function getLens(name: string): Promise<LensData> {
  if (USE_FIXTURES) {
    const m = await import('./test/mockApi');
    return m.getLens(name);
  }
  const path = `/lens/${encodeURIComponent(name)}`;
  if (STATIC) return fromStatic<LensData>(path);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${withExperiment(path)}`, { headers: { Accept: 'application/octet-stream' } });
  } catch (err) {
    throw new ApiError(0, path, `Network error reaching ${path}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body && typeof body.detail === 'string') detail = body.detail;
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, path, `${res.status} ${detail} (${path})`);
  }
  const num = (h: string) => Number(res.headers.get(h));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const days = num('X-Lens-Days');
  const couples = num('X-Lens-Couples');
  if (!Number.isFinite(days) || !Number.isFinite(couples) || bytes.length !== days * couples) {
    throw new ApiError(res.status, path, `${path} returned ${bytes.length} bytes for ${days} days of ${couples} couples`);
  }
  return { name, days, couples, lo: num('X-Lens-Lo'), hi: num('X-Lens-Hi'), worseHigh: res.headers.get('X-Lens-Worse-High') === '1', bytes };
}

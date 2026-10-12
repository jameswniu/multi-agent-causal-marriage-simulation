// Typed wrappers over the FastAPI endpoints in docs/contracts.md sections 3, 5 and 6.
import type {
  AgentDetailResponse,
  CoupleDetailResponse,
  CouplesQuery,
  CouplesResponse,
  Curves,
  Distributions,
  EventsDayResponse,
  ExperimentResponse,
  ExperimentsResponse,
  Outcome,
  PolicySpec,
  RunRequest,
  RunResponse,
  ShocksCatalog,
  TranslateResponse,
  TwinsWorldResponse,
  WorldResponse,
} from './types';

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

function withExperiment(path: string): string {
  if (!currentExperiment) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}experiment=${encodeURIComponent(currentExperiment)}`;
}

async function fromFixtures<T>(path: string, init?: RequestInit): Promise<T> {
  const m = await import('./test/mockApi');
  const url = new URL(path, 'http://fixtures');
  const q = url.searchParams;
  const p = url.pathname;
  if (p === '/experiment') return m.getExperiment() as Promise<T>;
  if (p === '/experiments') return m.listExperiments() as Promise<T>;
  if (p === '/experiments/run') return m.runExperiment(JSON.parse(String(init?.body ?? '{}')) as RunRequest) as Promise<T>;
  if (p === '/shocks/catalog') return m.getShocksCatalog() as Promise<T>;
  if (p === '/shocks/translate') {
    const b = JSON.parse(String(init?.body ?? '{}')) as { text: string; days: number };
    return m.translateShock(b.text, b.days) as Promise<T>;
  }
  if (p === '/ate') return m.getAte() as Promise<T>;
  if (p === '/curves') return m.getCurves() as Promise<T>;
  if (p === '/distributions') return m.getDistributions() as Promise<T>;
  if (p === '/policy') return m.getPolicy() as Promise<T>;
  if (p === '/world') return m.getWorld() as Promise<T>;
  if (p === '/twins/world') return m.getTwinsWorld() as Promise<T>;
  if (p === '/events') return m.getEventsForDay(Number(q.get('day'))) as Promise<T>;
  if (p === '/couples') {
    return m.listCouples({
      arm: (q.get('arm') ?? '') as CouplesQuery['arm'],
      state: (q.get('state') ?? '') as CouplesQuery['state'],
      origin: (q.get('origin') ?? '') as CouplesQuery['origin'],
      limit: Number(q.get('limit') ?? 100),
      offset: Number(q.get('offset') ?? 0),
    }) as Promise<T>;
  }
  const couple = p.match(/^\/couples\/(\d+)$/);
  if (couple) return m.getCouple(Number(couple[1])) as Promise<T>;
  const agent = p.match(/^\/agents\/(\d+)$/);
  if (agent) return m.getAgent(Number(agent[1])) as Promise<T>;
  throw new ApiError(404, path, `No fixture for ${path}`);
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  if (USE_FIXTURES) return fromFixtures<T>(path, init);
  const full = withExperiment(path);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${full}`, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
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

export function runExperiment(body: RunRequest): Promise<RunResponse> {
  return fetchJson<RunResponse>('/experiments/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

export function listCouples(q: CouplesQuery = {}): Promise<CouplesResponse> {
  const params = new URLSearchParams();
  if (q.arm) params.set('arm', q.arm);
  if (q.state) params.set('state', q.state);
  if (q.origin) params.set('origin', q.origin);
  params.set('limit', String(q.limit ?? 100));
  params.set('offset', String(q.offset ?? 0));
  params.set('sort', q.sort ?? 'couple_id');
  return fetchJson<CouplesResponse>(`/couples?${params.toString()}`);
}

export function getCouple(id: number): Promise<CoupleDetailResponse> {
  return fetchJson<CoupleDetailResponse>(`/couples/${id}`);
}

export function getAgent(id: number): Promise<AgentDetailResponse> {
  return fetchJson<AgentDetailResponse>(`/agents/${id}`);
}

export function getWorld(): Promise<WorldResponse> {
  return fetchJson<WorldResponse>('/world');
}

export function getTwinsWorld(): Promise<TwinsWorldResponse> {
  return fetchJson<TwinsWorldResponse>('/twins/world');
}

export function getEventsForDay(day: number, signal?: AbortSignal): Promise<EventsDayResponse> {
  return fetchJson<EventsDayResponse>(`/events?day=${day}`, { signal });
}

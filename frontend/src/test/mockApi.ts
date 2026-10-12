// Fixture-backed implementation of the api module for tests. LoveWorld is the simulation of
// married agent couples this dashboard reads, and these functions answer every dashboard request from
// saved fixtures, including a stand-in for the model that translates a shock described in plain words.
import experiment from '../fixtures/experiment.json';
import couples from '../fixtures/couples.json';
import coupleDetails from '../fixtures/coupleDetails.json';
import agentDetails from '../fixtures/agentDetails.json';
import policy from '../fixtures/policy.json';
import world from '../fixtures/world.json';
import eventsByDay from '../fixtures/eventsByDay.json';
import twinsWorld from '../fixtures/twinsWorld.json';
import experiments from '../fixtures/experiments.json';
import experimentShockOnly from '../fixtures/experimentShockOnly.json';
import shocksCatalog from '../fixtures/shocksCatalog.json';
import type { AgentDetailResponse, CoupleDetailResponse, CouplesQuery, EventRow, ExperimentResponse, ExperimentsResponse, ForkRequest, HealthResponse, JobResponse, ParentRecord, PolicySpec, RunRequest, ShockSpec, ShocksCatalog, Summary, TranslateResponse, TwinsWorldResponse, WorldResponse } from '../types';

const exp = experiment as unknown as ExperimentResponse;
const summary = exp.summary as Summary;
const details = coupleDetails as unknown as Record<string, CoupleDetailResponse>;
const agents = agentDetails as unknown as Record<string, AgentDetailResponse>;
const byDay = eventsByDay as unknown as Record<string, EventRow[]>;

let current: string | null = null;
/** Forks the mock has run, by name: their parent record, so a fork's Overview can show the comparison. */
let forks: Record<string, ParentRecord> = {};
let health: HealthResponse = { ok: true, experiments: [], public: false };
export const getExperiment = async (): Promise<ExperimentResponse> => {
  if (current === 'job-loss-api') return experimentShockOnly as unknown as ExperimentResponse;
  if (current && forks[current]) return { ...exp, manifest: { ...exp.manifest, name: current }, parent: forks[current] };
  return exp;
};
export const getHealth = async () => health;
/** Test hook: make the mock server public (fixed names, caps) or local again. */
export function setHealth(next: Partial<HealthResponse>): void {
  health = { ...health, ...next };
}
export const getAte = async () => summary.outcomes;
export const getCurves = async () => summary.curves;
export const getDistributions = async () => summary.distributions;
export const getPolicy = async () => policy as unknown as PolicySpec;
export const listCouples = async (q: CouplesQuery = {}) => {
  let items = (couples as typeof couples).items;
  if (q.arm) items = items.filter((c) => c.arm === q.arm);
  if (q.state) items = items.filter((c) => c.final_state === q.state);
  if (q.origin) items = items.filter((c) => c.origin === q.origin);
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 100;
  return { total: items.length, items: items.slice(offset, offset + limit) };
};
export const getCouple = async (id: number) => {
  const d = details[String(id)];
  if (!d) throw new Error(`404 couple ${id} not found`);
  return d;
};
export const getAgent = async (id: number) => {
  const d = agents[String(id)];
  if (!d) throw new Error(`404 agent ${id} not found`);
  return d;
};
export const getWorld = async () => world as unknown as WorldResponse;
export const getEventsForDay = async (day: number) => ({ day, items: byDay[String(day)] ?? [] });
export const getTwinsWorld = async () => twinsWorld as unknown as TwinsWorldResponse;
const baseExperiments = experiments as unknown as ExperimentsResponse;
let extraExperiments: ExperimentsResponse['items'] = [];
export const listCalls = { count: 0 };
export function resetMockState(): void {
  extraExperiments = [];
  listCalls.count = 0;
  current = null;
  forks = {};
  jobs = {};
  health = { ok: true, experiments: [], public: false };
}
export const listExperiments = async () => {
  listCalls.count += 1;
  return { default: baseExperiments.default, items: [...baseExperiments.items, ...extraExperiments] };
};
export const getShocksCatalog = async () => shocksCatalog as unknown as ShocksCatalog;
const KINDS_SENTENCE = 'LoveWorld can run these kinds of shock: job loss, financial crisis, temptation, intimacy mismatch, daily texts, anniversary, date nights and trait shift.';
/** A stand-in for the model: a dog is unsupported, "1000" comes back out of bounds, anything else is a job loss. */
export const translateShock = async (text: string, days: number): Promise<TranslateResponse> => {
  await new Promise((r) => setTimeout(r, 20));
  const t = text.toLowerCase();
  const base = { rationale: 'Month three starts on day 60 and four months last 120 days.', model: 'fixture-model', errors: [] as string[], message: null as string | null };
  if (t.includes('dog')) {
    return { ...base, translation_id: 'tr-dog', status: 'unsupported', spec: null, words: null, rationale: 'A pet dying is none of the kinds.', message: `A pet dying is not one of the kinds. ${KINDS_SENTENCE}` };
  }
  if (t.includes('mother')) {
    const custom = {
      kind: 'custom',
      target: 'treatment' as const,
      member: 'random' as const,
      start_day: 30,
      end_day: 90,
      magnitude: 0,
      label: 'mother moves in',
      description: "His mother moves into the couple's home for two months.",
      effects: [
        { channel: 'stress' as const, op: 'add' as const, amount: 0.3, cadence: 'daily' as const, who: 'both' as const },
        { channel: 'onset_hazard' as const, op: 'multiply' as const, amount: 1.4, cadence: 'daily' as const, who: 'both' as const },
      ],
    };
    return { ...base, translation_id: 'tr-mother', status: 'ok', spec: custom, words: null, rationale: 'No named kind fits a parent moving in, so it is written as effects.' };
  }
  const spec = { kind: 'job_loss', target: 'treatment' as const, member: 'random' as const, start_day: 60, end_day: Math.min(180, days - 1), magnitude: 1.5, trait: null };
  if (t.includes('control group')) {
    const err = "target must be one of ['treatment', 'all'], got 'control'";
    return { ...base, translation_id: 'tr-ctl', status: 'invalid', spec: { ...spec, target: 'control' }, words: null, errors: [err], message: `The translation does not fit the simulation: ${err}` };
  }
  if (t.includes('1000')) {
    const err = 'treatment.shocks[0].magnitude must lie in [0.0, 5.0], got 1000.0';
    return { ...base, translation_id: 'tr-big', status: 'invalid', spec: { ...spec, magnitude: 1000 }, words: null, errors: [err], message: `The translation does not fit the simulation: ${err}` };
  }
  return { ...base, translation_id: 'tr-job', status: 'ok', spec, words: `One partner loses their job (a random partner, treatment arm), days 60 to ${spec.end_day}, magnitude 1.5 (stress)` };
};
let jobs: Record<string, JobResponse> = {};
let jobSeq = 0;
function addListed(name: string, n: number, d: number, parent: string | null): void {
  extraExperiments = [...extraExperiments, { name, dir: `results/${name}`, n_couples: n, days: d, seeds: { population: 11, assignment: 22, dynamics: 33 },
    intervention: { memory: null, shocks: [] }, divorce_control: null, divorce_treatment: null, generated_at_unix: 0, parent }];
}
function finishedJob(kind: 'run' | 'fork', name: string): JobResponse {
  jobSeq += 1;
  const job: JobResponse = { job_id: `job-${jobSeq}`, kind, name, state: 'done', position: null, error: null, created: 0, started: 0, finished: 0 };
  jobs[job.job_id] = job;
  return job;
}
/** Runs finish at once in the mock; the page still reads the job it gets back. */
export const runExperiment = async (body: RunRequest): Promise<JobResponse> => {
  await new Promise((r) => setTimeout(r, 30));
  const name = body.name ?? (health.public ? `v-0123456789ab-2026101${jobSeq}-000000` : '');
  if (!name) throw new Error('400 name is required (/experiments/run)');
  addListed(name, body.n_couples ?? 1000, body.days ?? 365, null);
  return finishedJob('run', name);
};
/** A fork lands as a new listed world whose Overview carries a zero-difference comparison with its parent. */
export const forkExperiment = async (body: ForkRequest): Promise<JobResponse> => {
  await new Promise((r) => setTimeout(r, 30));
  const name = body.name ?? `${body.parent}-fork`;
  addListed(name, 1000, 365, body.parent);
  const rows = summary.outcomes.slice(0, 3).map((o) => ({ name: o.name, mean_diff: 0, ci_low: 0, ci_high: 0, n_pairs: 1000, share_changed: 0 }));
  forks[name] = {
    parent: body.parent,
    parent_determinism_hash: exp.manifest.determinism_hash,
    parent_engine_version: exp.manifest.engine_version,
    // As the server writes them: a custom shock carries no magnitude, as in a summary's shock list.
    appended_shocks: body.shocks.map((s) => ({ ...s, trait: s.trait ?? null }) as ShockSpec),
    comparison: { comparable: true, n_couples: 1000, arms: { all: rows, control: rows, treatment: rows } },
  };
  return finishedJob('fork', name);
};
export const getJob = async (id: string): Promise<JobResponse> => {
  const job = jobs[id];
  if (!job) throw new Error(`404 unknown job (/jobs/${id})`);
  return job;
};
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
export const setCurrentExperiment = (name: string | null) => {
  current = name;
};

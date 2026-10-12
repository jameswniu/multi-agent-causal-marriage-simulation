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
import type { AgentDetailResponse, CoupleDetailResponse, CouplesQuery, EventRow, ExperimentResponse, ExperimentsResponse, PolicySpec, RunRequest, RunResponse, ShocksCatalog, Summary, TranslateResponse, TwinsWorldResponse, WorldResponse } from '../types';

const exp = experiment as unknown as ExperimentResponse;
const summary = exp.summary as Summary;
const details = coupleDetails as unknown as Record<string, CoupleDetailResponse>;
const agents = agentDetails as unknown as Record<string, AgentDetailResponse>;
const byDay = eventsByDay as unknown as Record<string, EventRow[]>;

let current: string | null = null;
export const getExperiment = async () => (current === 'job-loss-api' ? (experimentShockOnly as unknown as ExperimentResponse) : exp);
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
export const runExperiment = async (body: RunRequest): Promise<RunResponse> => {
  await new Promise((r) => setTimeout(r, 30));
  if (!body.name) throw new Error('400 name is required (/experiments/run)');
  extraExperiments = [...extraExperiments, { name: body.name, dir: `results/${body.name}`, n_couples: body.n_couples ?? 1000, days: body.days ?? 365, seeds: { population: 11, assignment: 22, dynamics: 33 },
    intervention: { memory: null, shocks: [] }, divorce_control: null, divorce_treatment: null, generated_at_unix: 0 }];
  return { name: body.name, dir: `results/${body.name}`, summary };
};
export const setCurrentExperiment = (name: string | null) => {
  current = name;
};

// The New experiment page. A visitor either forks the world they were watching (same couples, seeds
// and settings, with shocks added) or sets up a fresh run of the couples simulation (how many couples,
// how many days, how long the treatment arm remembers a fight, and any shocks). A shock can be described
// in plain words for the server to translate into an editable row. The run waits its turn on the
// server's queue, and the page opens the result when it is done.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { forkExperiment, getExperiment, getHealth, getShocksCatalog, runExperiment, translateShock } from '../api';
import { JobContactLostError, waitForJob } from '../jobs';
import type { EffectCadence, EffectCatalog, EffectSpec, EffectWho, ForkRequest, JobResponse, RunRequest, RunShock, RunTranslation, ShockKind, ShockMember, TranslateResponse } from '../types';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { useExpNavigate } from '../nav';
import { ErrorBox, Loading } from '../components/Status';
import { effectWords, humanDuration, shockWords, toCatalog, type Catalog } from '../arms';
import { shockEnd } from '../town/timebar';
import { changedSinceTranslation, isTraitKind, rowSpec, validateRun, type RunForm, type RunRules, type ShockForm } from '../validation';
import { mountTurnstile } from '../turnstile';

let nextId = 1;

/** What an empty end day means for a built-in shock, resolved as the engine resolves it. A kind with a catalog length ends that many days after its start, and anything else runs to the end. */
function openEndHint(s: ShockForm, catalog: Catalog | null, days: number): string {
  const end = shockEnd({ ...s, end_day: null }, catalog, days);
  return end >= days - 1 ? 'to the end' : `day ${end}`;
}

function draftFor(k: ShockKind): ShockForm {
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
  row.translation = { id: res.translation_id, text, status: res.status, rationale: res.rationale, model: res.model, errors: res.errors, asTranslated: spec, initial: rowSpec(row), confirmed: res.status !== 'invalid' };
  return row;
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
  row.translation = { id: res.translation_id, text, status: res.status, rationale: res.rationale, model: res.model, errors: res.errors, asTranslated: spec, initial: rowSpec(row), confirmed: res.status !== 'invalid' };
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

type TranslateState = { kind: 'idle' } | { kind: 'working' } | { kind: 'unsupported'; message: string } | { kind: 'error'; message: string };

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; started: number; job?: JobResponse }
  | { kind: 'error'; message: string }
  | { kind: 'lost'; job: JobResponse; message: string }
  | { kind: 'done'; name: string };

export default function NewExperiment() {
  const navigate = useExpNavigate();
  const exp = useExperiment();
  const catalog = useAsync(getShocksCatalog, []);
  const current = useAsync(() => getExperiment().catch(() => null), []);
  // Asked again whenever the visitor presses Check again after a failed health check.
  const [healthTry, setHealthTry] = useState(0);
  const health = useAsync(() => getHealth().catch(() => null), [healthTry]);
  const controlHalfLife = current.data?.summary?.experiment.treatment.control_value ?? 14;
  const [name, setName] = useState(() => `exp-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
  const [nCouples, setNCouples] = useState(1000);
  const [days, setDays] = useState(365);
  const [treatmentHalfLife, setTreatmentHalfLife] = useState<number | null>(null);
  const [shocks, setShocks] = useState<ShockForm[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [describeText, setDescribeText] = useState('');
  const [translateState, setTranslateState] = useState<TranslateState>({ kind: 'idle' });
  const [params] = useSearchParams();
  // Start from the world the visitor was watching (the experiment in the URL), or a fresh population.
  const [startFrom, setStartFrom] = useState<string>(() => params.get('experiment') ?? '');
  const describeRef = useRef<HTMLTextAreaElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const kinds = useMemo(() => catalog.data?.kinds ?? [], [catalog.data]);
  const catalogMap = useMemo(() => toCatalog(kinds), [kinds]);
  const halfLife = treatmentHalfLife ?? controlHalfLife;
  const isPublic = health.data?.public === true;
  const forking = startFrom !== '';
  const parentItem = exp.items.find((i) => i.name === startFrom);
  const runCouples = forking ? (parentItem?.n_couples ?? nCouples) : nCouples;
  const runDays = forking ? (parentItem?.days ?? days) : days;
  // A fork is checked against its parent's days, so it waits until the parent is in the list.
  const parentProblem = !forking || parentItem
    ? null
    : exp.loading
      ? 'The list of worlds is still loading; wait a moment, then run.'
      : exp.error
        ? `The list of worlds did not load, so the couples and days of ${startFrom} are unknown; reload the page to fork it.`
        : `${startFrom} is not a world you can start from here; pick another under Start from.`;
  const rules = useMemo<RunRules>(
    () => ({ nameAssigned: isPublic, fork: forking, parentProblem, parentShocks: parentItem?.intervention?.shocks ?? null, maxCouples: health.data?.limits?.max_couples, maxDays: health.data?.limits?.max_days }),
    [isPublic, forking, parentProblem, parentItem, health.data],
  );
  // Until the server says whether this is public mode (and so whether a bot check guards POSTs), nothing is sent;
  // a health check that failed blocks sending too, rather than guessing the local mode.
  const settling = health.loading || health.data?.ok !== true;
  const healthMissing = !health.loading && health.data?.ok !== true;
  const form = useMemo<RunForm>(() => ({ name, nCouples: runCouples, days: runDays, treatmentHalfLife: halfLife, shocks, overwrite }), [name, runCouples, runDays, halfLife, shocks, overwrite]);
  const effectCatalog = catalog.data?.effects ?? null;
  const errors = useMemo(() => validateRun(form, kinds, effectCatalog, rules), [form, kinds, effectCatalog, rules]);
  const siteKey = health.data?.turnstile_site_key ?? null;

  // Public mode puts a bot check in front of POSTs when the server names a site key. A layout effect, so the
  // check counts as on its way before the page can be clicked, and a POST made meanwhile waits for its token.
  useLayoutEffect(() => {
    if (siteKey && turnstileRef.current) void mountTurnstile(turnstileRef.current, siteKey).catch(() => undefined);
  }, [siteKey]);

  useEffect(() => {
    if (status.kind !== 'running') return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - status.started) / 1000)), 500);
    return () => clearInterval(t);
  }, [status]);

  const addShock = () => {
    if (kinds.length === 0) return;
    setShocks((s) => [...s, draftFor(kinds[0])]);
  };
  const update = (id: number, patch: Partial<ShockForm>) => setShocks((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const updateEffect = (id: number, j: number, patch: Partial<EffectSpec>) =>
    setShocks((s) => s.map((x) => (x.id === id ? { ...x, effects: (x.effects ?? []).map((e, i) => (i === j ? { ...e, ...patch } : e)) } : x)));
  const remove = (id: number) => setShocks((s) => s.filter((x) => x.id !== id));
  const kindOf = (k: string) => kinds.find((x) => x.kind === k);

  // The World page's "What if" link lands here with ?describe=1: put the cursor in the box.
  useEffect(() => {
    if (catalog.data && params.get('describe') === '1') describeRef.current?.focus();
  }, [catalog.data, params]);

  /** Send the description to the server's translator and add the shock it maps to as an editable row. */
  const translate = async () => {
    const text = describeText.trim();
    // The keyboard shortcut reaches here too, so the same conditions that disable the button apply.
    if (!text || translateState.kind === 'working' || settling || parentProblem !== null) return;
    setTranslateState({ kind: 'working' });
    try {
      const res = await translateShock(text, runDays);
      const row = rowFromTranslation(res, text, kinds);
      if (!row) {
        setTranslateState({ kind: 'unsupported', message: res.message ?? res.rationale ?? 'That description is not one of the shock kinds.' });
        return;
      }
      setShocks((s) => [...s, row]);
      setDescribeText('');
      setTranslateState({ kind: 'idle' });
    } catch (err) {
      setTranslateState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Wait for a queued job, then refresh the list and open it. Lost contact keeps the job, so checking again never re-runs it. */
  const follow = async (accepted: JobResponse, started: number) => {
    try {
      const job = await waitForJob(accepted, (j) => setStatus({ kind: 'running', started, job: j }));
      // A list that fails to refresh does not undo a finished run; the page still opens it.
      await exp.refresh().catch(() => []);
      setStatus({ kind: 'done', name: job.name });
      navigate('/overview', job.name);
    } catch (err) {
      if (err instanceof JobContactLostError) setStatus({ kind: 'lost', job: err.job, message: err.message });
      else setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Validate, queue the run (a fork or a fresh one), and follow it. Shared by the Run and Try again buttons. */
  const run = async () => {
    if (settling || status.kind === 'running') return;
    const problems = validateRun(form, kinds, effectCatalog, rules);
    if (problems.length) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    const started = Date.now();
    setStatus({ kind: 'running', started });
    setElapsed(0);
    let accepted: JobResponse;
    try {
      accepted = forking
        ? await forkExperiment(buildForkRequest(form, kinds, startFrom, { nameAssigned: isPublic }))
        : await runExperiment(buildRequest(form, kinds, { nameAssigned: isPublic }));
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    await follow(accepted, started);
  };

  if (catalog.error) return <ErrorBox message={catalog.error} />;
  if (!catalog.data) return <Loading what="the shock catalog" />;
  const running = status.kind === 'running';

  return (
    <div>
      <h1>New experiment</h1>
      <p className="muted">
        Start from the world you were watching to see what a shock does to the very same couples, or from a fresh population that is randomized into two arms. Add shocks that hit only the treatment arm or everyone, and run. The engine and the analysis take about ten seconds at 1,000 couples for a year, and runs take turns on the server.
      </p>
      <form
        className="card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        aria-label="New experiment"
      >
        <div className="form-grid">
          <label>
            Start from
            <select value={startFrom} onChange={(e) => setStartFrom(e.target.value)} aria-label="Start from" data-testid="start-from">
              <option value="">A fresh population</option>
              {exp.items.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name}
                  {i.parent ? ` (a fork of ${i.parent})` : ''}
                </option>
              ))}
              {startFrom && !parentItem ? <option value={startFrom}>{startFrom}</option> : null}
            </select>
            <span className="muted">{forking ? 'The same couples, seeds and settings, with your shocks added.' : 'A new population, randomized into two arms.'}</span>
          </label>
          {isPublic ? null : (
            <label>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            </label>
          )}
          {forking ? null : (
            <>
              <label>
                Couples (up to {(health.data?.limits?.max_couples ?? 2000).toLocaleString()})
                <input type="number" min={1} max={health.data?.limits?.max_couples ?? 2000} step={1} value={nCouples} onChange={(e) => setNCouples(Number(e.target.value))} aria-label="Couples" />
              </label>
              <label>
                Days (up to {health.data?.limits?.max_days ?? 730})
                <input type="number" min={1} max={health.data?.limits?.max_days ?? 730} step={1} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days" />
              </label>
              <label>
                Treatment arm memory half-life for fights, in days
                <input type="number" min={1} max={3650} step="any" value={halfLife} onChange={(e) => setTreatmentHalfLife(Number(e.target.value))} aria-label="Treatment conflict half-life" />
                <span className="muted">
                  Control keeps {controlHalfLife} days ({humanDuration(controlHalfLife)}). Equal values make a shock-only experiment.
                </span>
              </label>
            </>
          )}
        </div>
        {forking && parentProblem ? (
          <p className="muted" data-testid="fork-note">
            {parentProblem}
          </p>
        ) : forking ? (
          <p className="muted" data-testid="fork-note">
            Forking {startFrom}: {runCouples.toLocaleString()} couples for {runDays} days, with its memory settings and every earlier shock kept. Nothing changes but the shocks below, so its Overview can compare each couple with the same couple in {startFrom}.
          </p>
        ) : null}
        {isPublic ? <p className="muted">This run gets a name of its own and stays visible to you for a day.</p> : null}
        <h2>Shocks</h2>
        <p className="muted">A shock is a scheduled stressor. "Only the treatment arm" makes it part of the intervention; "everyone" tests the memory treatment under the same stress on both sides.</p>
        <div className="describe" data-testid="describe">
          <label>
            Describe what happens
            <textarea
              ref={describeRef}
              value={describeText}
              maxLength={400}
              rows={2}
              placeholder="He loses his job in month three for four months"
              onChange={(e) => setDescribeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void translate();
                }
              }}
              aria-label="Describe what happens"
            />
          </label>
          <div className="filters">
            <button type="button" onClick={() => void translate()} disabled={!describeText.trim() || translateState.kind === 'working' || settling || parentProblem !== null} data-testid="translate">
              {translateState.kind === 'working' ? 'Translating...' : 'Translate'}
            </button>
            <span className="muted">
              {describeText.length}/400. A model turns the words into one shock below, which you check and can change before it runs. The model never runs the simulation.
            </span>
          </div>
          {translateState.kind === 'unsupported' ? (
            <div className="status" role="status" data-testid="translate-unsupported">
              {translateState.message}
            </div>
          ) : null}
          {translateState.kind === 'error' ? (
            <div className="status error" role="alert" data-testid="translate-error">
              Could not translate: {translateState.message}
            </div>
          ) : null}
        </div>
        {shocks.map((s) => {
          const k = kindOf(s.kind);
          const t = s.translation;
          return (
            <div className="shock" key={s.id} data-testid="shock-row">
              {t ? (
                <div className="translation-card" data-testid="translation-card">
                  <div className="muted">From your words: "{t.text}"</div>
                  <div data-testid="translation-words">{shockWords(rowSpec(s), catalogMap)}</div>
                  {s.kind === 'custom' && s.description ? <div data-testid="translation-description">{s.description}</div> : null}
                  {t.rationale ? <div className="muted">{t.rationale}</div> : null}
                  {t.status === 'invalid' ? (
                    <div className="status error" role="alert" data-testid="translation-errors">
                      The model's answer does not fit the simulation: {t.errors.join(' ')} Fields it got wrong were reset to defaults; change them below, or confirm them if they are right.
                      {!t.confirmed && !changedSinceTranslation(s) ? (
                        <div>
                          <button type="button" data-testid="translation-confirm" onClick={() => update(s.id, { translation: { ...t, confirmed: true } })}>
                            These fields are right
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {changedSinceTranslation(s) ? (
                    <div className="muted" data-testid="translation-edited">
                      You changed this after translation, and the run records that.
                    </div>
                  ) : null}
                  <div className="muted">Translated by {t.model}.</div>
                </div>
              ) : null}
              {s.kind === 'custom' ? (
                <CustomShockFields shock={s} days={days} effects={effectCatalog} onChange={(patch) => update(s.id, patch)} onEffect={(j, patch) => updateEffect(s.id, j, patch)} onRemove={() => remove(s.id)} />
              ) : (
              <>
              <div className="row">
                <label>
                  Kind
                  <select
                    value={s.kind}
                    onChange={(e) => {
                      const nk = kindOf(e.target.value);
                      if (!nk) return;
                      update(s.id, { kind: nk.kind, start_day: nk.default_start_day, end_day: nk.default_end_day, magnitude: nk.magnitude.default, trait: isTraitKind(nk) ? nk.traits![0] : null });
                    }}
                    aria-label="Shock kind"
                  >
                    {kinds.map((x) => (
                      <option key={x.kind} value={x.kind}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="blurb" data-testid="shock-blurb">
                  {k?.blurb ?? ''}
                </span>
              </div>
              <div className="row">
                {isTraitKind(k) ? (
                  <label>
                    Trait
                    <select value={s.trait ?? ''} onChange={(e) => update(s.id, { trait: e.target.value })} aria-label="Trait" required>
                      {k!.traits!.map((t) => (
                        <option key={t} value={t}>
                          {t.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {k?.member_applies ? (
                  <label>
                    Which partner
                    <select value={s.member} onChange={(e) => update(s.id, { member: e.target.value as ShockMember })} aria-label="Which partner">
                      <option value="random">random</option>
                      <option value="a">partner a</option>
                      <option value="b">partner b</option>
                    </select>
                  </label>
                ) : null}
                <label>
                  Start day
                  <input type="number" min={0} max={days - 1} step={1} value={s.start_day} onChange={(e) => update(s.id, { start_day: Number(e.target.value) })} aria-label="Start day" />
                </label>
                <label>
                  End day
                  <input
                    type="number"
                    min={0}
                    max={days - 1}
                    step={1}
                    value={s.end_day ?? ''}
                    placeholder={openEndHint(s, catalogMap, runDays)}
                    onChange={(e) => update(s.id, { end_day: e.target.value === '' ? null : Number(e.target.value) })}
                    aria-label="End day"
                  />
                </label>
                <label>
                  Magnitude {k ? `(${k.magnitude.unit})` : ''}: <strong>{s.magnitude}</strong>
                  <input type="range" min={k?.magnitude.min ?? 0} max={k?.magnitude.max ?? 1} step="any" value={s.magnitude} onChange={(e) => update(s.id, { magnitude: Number(e.target.value) })} aria-label="Magnitude" />
                </label>
                <label>
                  Hits
                  <select value={s.target} onChange={(e) => update(s.id, { target: e.target.value as ShockForm['target'] })} aria-label="Hits">
                    <option value="treatment">only the treatment arm</option>
                    <option value="all">everyone</option>
                  </select>
                </label>
                <button type="button" onClick={() => remove(s.id)}>
                  Remove
                </button>
              </div>
              </>
              )}
            </div>
          );
        })}
        <div className="filters">
          <button type="button" onClick={addShock} disabled={kinds.length === 0}>
            Add shock
          </button>
          {forking || isPublic ? null : (
            <label>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite if the name exists
            </label>
          )}
        </div>
        {showErrors && errors.length ? (
          <ul className="status error" role="alert" data-testid="validation-errors" style={{ margin: '0.75rem 0', paddingLeft: '2rem' }}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {siteKey ? <div ref={turnstileRef} className="turnstile" data-testid="turnstile" /> : null}
        {healthMissing ? (
          <div className="status error" role="alert" data-testid="health-missing">
            The server did not say how it is set up, so nothing can be run from this page yet.
            <div>
              <button type="button" onClick={() => setHealthTry((n) => n + 1)}>
                Check again
              </button>
            </div>
          </div>
        ) : null}
        <div className="filters" style={{ marginTop: '1rem' }}>
          <button type="submit" disabled={running || settling} data-testid="run">
            {running ? 'Running...' : forking ? 'Run this world with the shocks' : 'Run experiment'}
          </button>
          {running ? (
            <span role="status" data-testid="progress">
              {status.kind === 'running' && status.job?.state === 'queued'
                ? `Waiting its turn, number ${status.job.position ?? 1} in line, ${elapsed}s so far.`
                : `Running the engine and the analysis, ${elapsed}s so far. About ten seconds at 1,000 couples for a year.`}
            </span>
          ) : null}
        </div>
        {status.kind === 'error' ? (
          <div className="status error" role="alert" data-testid="run-error">
            The run failed: {status.message}
            <div>
              <button type="button" onClick={() => void run()}>
                Try again
              </button>
            </div>
          </div>
        ) : null}
        {status.kind === 'lost' ? (
          <div className="status error" role="alert" data-testid="run-lost">
            The page {status.message}.
            <div>
              <button type="button" onClick={() => void follow(status.job, Date.now())}>
                Check again
              </button>
            </div>
          </div>
        ) : null}
        {status.kind === 'done' ? <div className="status">Experiment {status.name} is ready.</div> : null}
      </form>
    </div>
  );
}

const CADENCE_LABELS: Record<EffectCadence, string> = { once: 'once', daily: 'every day', weekly: 'every week', yearly: 'every year' };
const WHO_LABELS: Record<EffectWho, string> = { member: 'the chosen partner', partner: 'the other partner', both: 'both partners' };

/** The fields of a custom shock: its name, whom it picks, its days and arm, and each effect with its amount, cadence and target. */
function CustomShockFields({
  shock,
  days,
  effects,
  onChange,
  onEffect,
  onRemove,
}: {
  shock: ShockForm;
  days: number;
  effects: EffectCatalog | null;
  onChange: (patch: Partial<ShockForm>) => void;
  onEffect: (j: number, patch: Partial<EffectSpec>) => void;
  onRemove: () => void;
}) {
  const spec = rowSpec(shock);
  return (
    <div data-testid="custom-shock">
      <div className="row">
        <label>
          Custom shock
          <input type="text" value={shock.label ?? ''} maxLength={effects?.label_max_chars ?? 40} onChange={(e) => onChange({ label: e.target.value })} aria-label="Custom shock name" />
        </label>
        <label>
          Which partner
          <select value={shock.member} onChange={(e) => onChange({ member: e.target.value as ShockMember })} aria-label="Which partner">
            <option value="random">random</option>
            <option value="a">partner a</option>
            <option value="b">partner b</option>
          </select>
        </label>
        <label>
          Start day
          <input type="number" min={0} max={days - 1} step={1} value={shock.start_day} onChange={(e) => onChange({ start_day: Number(e.target.value) })} aria-label="Start day" />
        </label>
        <label>
          End day
          <input type="number" min={0} max={days - 1} step={1} value={shock.end_day ?? ''} placeholder="to the end" onChange={(e) => onChange({ end_day: e.target.value === '' ? null : Number(e.target.value) })} aria-label="End day" />
        </label>
        <label>
          Hits
          <select value={shock.target} onChange={(e) => onChange({ target: e.target.value as ShockForm['target'] })} aria-label="Hits">
            <option value="treatment">only the treatment arm</option>
            <option value="all">everyone</option>
          </select>
        </label>
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      </div>
      <ol className="effects" data-testid="effect-list">
        {(shock.effects ?? []).map((e, j) => {
          const ch = effects?.channels.find((c) => c.channel === e.channel);
          const range = ch?.cadences[e.cadence];
          return (
            <li key={j} data-testid="effect-row">
              <div data-testid="effect-words">{effectWords(e, spec)}</div>
              <div className="row">
                <label>
                  Amount{range ? ` (${range.min} to ${range.max})` : ''}
                  <input type="number" step="any" min={range?.min} max={range?.max} value={e.amount} onChange={(ev) => onEffect(j, { amount: Number(ev.target.value) })} aria-label={`Effect ${j + 1} amount`} />
                </label>
                <label>
                  How often
                  <select value={e.cadence} onChange={(ev) => onEffect(j, { cadence: ev.target.value as EffectCadence })} aria-label={`Effect ${j + 1} cadence`}>
                    {(ch ? (Object.keys(ch.cadences) as EffectCadence[]) : [e.cadence]).map((c) => (
                      <option key={c} value={c}>
                        {CADENCE_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Hits
                  <select value={e.who} onChange={(ev) => onEffect(j, { who: ev.target.value as EffectWho })} aria-label={`Effect ${j + 1} target`}>
                    {(ch ? ch.who : [e.who]).map((w) => (
                      <option key={w} value={w}>
                        {WHO_LABELS[w]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

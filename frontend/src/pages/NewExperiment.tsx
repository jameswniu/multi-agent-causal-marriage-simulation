// The New experiment page. A visitor sets up a run of the couples simulation (how many couples, how
// many days, how long the treatment arm remembers a fight, and any shocks), can describe a shock in
// plain words for the server to translate into an editable row, then runs it and opens the result.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getExperiment, getShocksCatalog, runExperiment, translateShock } from '../api';
import type { RunRequest, RunTranslation, ShockKind, ShockMember, ShockSpec, TranslateResponse } from '../types';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { useExpNavigate } from '../nav';
import { ErrorBox, Loading } from '../components/Status';
import { humanDuration, shockWords, toCatalog } from '../arms';
import { changedSinceTranslation, isTraitKind, rowSpec, validateRun, type RunForm, type ShockForm } from '../validation';

let nextId = 1;

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

/** A shock row filled in from a translation, keeping the kind's defaults for anything the model left out. */
export function rowFromTranslation(res: TranslateResponse, text: string, kinds: ShockKind[]): ShockForm | null {
  const spec = res.spec;
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

/** The request body: the trait rides along only for a trait kind; the target decides treatment versus world. */
export function buildRequest(form: RunForm, kinds: ShockKind[]): RunRequest {
  const strip = (s: ShockForm): Omit<ShockSpec, 'target'> => {
    const k = kinds.find((x) => x.kind === s.kind);
    const base: Omit<ShockSpec, 'target'> = { kind: s.kind, member: s.member, start_day: s.start_day, end_day: s.end_day, magnitude: s.magnitude };
    return isTraitKind(k) ? { ...base, trait: s.trait } : base;
  };
  const treatmentShocks = form.shocks.filter((s) => s.target === 'treatment').map(strip);
  const worldShocks = form.shocks.filter((s) => s.target === 'all').map(strip);
  const req: RunRequest = {
    name: form.name.trim(),
    n_couples: form.nCouples,
    days: form.days,
    treatment: { conflict_half_life_days: form.treatmentHalfLife, ...(treatmentShocks.length ? { shocks: treatmentShocks } : {}) },
    analysis: { n_boot: 500, n_perm: 500 },
    overwrite: form.overwrite,
  };
  if (worldShocks.length) req.world = { shocks: worldShocks };
  // The server parses treatment shocks first and world shocks second; shock_index counts in that order.
  const ordered = [...form.shocks.filter((s) => s.target === 'treatment'), ...form.shocks.filter((s) => s.target === 'all')];
  const translations: RunTranslation[] = ordered.flatMap((s, i) => (s.translation ? [{ translation_id: s.translation.id, shock_index: i }] : []));
  if (translations.length) req.translations = translations;
  return req;
}

type TranslateState = { kind: 'idle' } | { kind: 'working' } | { kind: 'unsupported'; message: string } | { kind: 'error'; message: string };

type Status = { kind: 'idle' } | { kind: 'running'; started: number } | { kind: 'error'; message: string } | { kind: 'done'; name: string };

export default function NewExperiment() {
  const navigate = useExpNavigate();
  const exp = useExperiment();
  const catalog = useAsync(getShocksCatalog, []);
  const current = useAsync(() => getExperiment().catch(() => null), []);
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
  const describeRef = useRef<HTMLTextAreaElement>(null);
  const kinds = useMemo(() => catalog.data?.kinds ?? [], [catalog.data]);
  const catalogMap = useMemo(() => toCatalog(kinds), [kinds]);
  const halfLife = treatmentHalfLife ?? controlHalfLife;
  const form = useMemo<RunForm>(() => ({ name, nCouples, days, treatmentHalfLife: halfLife, shocks, overwrite }), [name, nCouples, days, halfLife, shocks, overwrite]);
  const errors = useMemo(() => validateRun(form, kinds), [form, kinds]);

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
  const remove = (id: number) => setShocks((s) => s.filter((x) => x.id !== id));
  const kindOf = (k: string) => kinds.find((x) => x.kind === k);

  // The World page's "What if" link lands here with ?describe=1: put the cursor in the box.
  useEffect(() => {
    if (catalog.data && params.get('describe') === '1') describeRef.current?.focus();
  }, [catalog.data, params]);

  /** Send the description to the server's translator and add the shock it maps to as an editable row. */
  const translate = async () => {
    const text = describeText.trim();
    if (!text || translateState.kind === 'working') return;
    setTranslateState({ kind: 'working' });
    try {
      const res = await translateShock(text, days);
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

  /** Validate, run, refresh the experiment list, then open the new experiment. Shared by the Run and Try again buttons. */
  const run = async () => {
    const problems = validateRun(form, kinds);
    if (problems.length) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStatus({ kind: 'running', started: Date.now() });
    setElapsed(0);
    try {
      const res = await runExperiment(buildRequest(form, kinds));
      await exp.refresh();
      setStatus({ kind: 'done', name: res.name });
      navigate('/overview', res.name);
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (catalog.error) return <ErrorBox message={catalog.error} />;
  if (!catalog.data) return <Loading what="the shock catalog" />;
  const running = status.kind === 'running';

  return (
    <div>
      <h1>New experiment</h1>
      <p className="muted">
        Every run starts from the same population and randomizes couples into two arms. Choose how long a fight stays in memory for the treatment arm, add shocks that hit only the treatment arm or everyone, and run. The engine and the analysis take about ten seconds at 1,000 couples for a year.
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
            Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          </label>
          <label>
            Couples (up to 2,000)
            <input type="number" min={1} max={2000} step={1} value={nCouples} onChange={(e) => setNCouples(Number(e.target.value))} aria-label="Couples" />
          </label>
          <label>
            Days (up to 730)
            <input type="number" min={1} max={730} step={1} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days" />
          </label>
          <label>
            Treatment arm memory half-life for fights, in days
            <input type="number" min={1} max={3650} step="any" value={halfLife} onChange={(e) => setTreatmentHalfLife(Number(e.target.value))} aria-label="Treatment conflict half-life" />
            <span className="muted">
              Control keeps {controlHalfLife} days ({humanDuration(controlHalfLife)}). Equal values make a shock-only experiment.
            </span>
          </label>
        </div>
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
            <button type="button" onClick={() => void translate()} disabled={!describeText.trim() || translateState.kind === 'working'} data-testid="translate">
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
                  <div data-testid="translation-words">{shockWords({ kind: s.kind, target: s.target, member: s.member, start_day: s.start_day, end_day: s.end_day, magnitude: s.magnitude, trait: s.trait }, catalogMap)}</div>
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
                    placeholder="to the end"
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
            </div>
          );
        })}
        <div className="filters">
          <button type="button" onClick={addShock} disabled={kinds.length === 0}>
            Add shock
          </button>
          <label>
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite if the name exists
          </label>
        </div>
        {showErrors && errors.length ? (
          <ul className="status error" role="alert" data-testid="validation-errors" style={{ margin: '0.75rem 0', paddingLeft: '2rem' }}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        <div className="filters" style={{ marginTop: '1rem' }}>
          <button type="submit" disabled={running} data-testid="run">
            {running ? 'Running...' : 'Run experiment'}
          </button>
          {running ? (
            <span role="status" data-testid="progress">
              Running the engine and the analysis, {elapsed}s so far. About ten seconds at 1,000 couples for a year.
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
        {status.kind === 'done' ? <div className="status">Experiment {status.name} is ready.</div> : null}
      </form>
    </div>
  );
}

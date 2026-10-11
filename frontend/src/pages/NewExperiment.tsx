import { useEffect, useMemo, useState } from 'react';
import { getExperiment, getShocksCatalog, runExperiment } from '../api';
import type { RunRequest, ShockKind, ShockMember, ShockSpec } from '../types';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { useExpNavigate } from '../nav';
import { ErrorBox, Loading } from '../components/Status';
import { humanDuration } from '../arms';
import { isTraitKind, validateRun, type RunForm, type ShockForm } from '../validation';

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
  return req;
}

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
  const kinds = useMemo(() => catalog.data?.kinds ?? [], [catalog.data]);
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
        {shocks.map((s) => {
          const k = kindOf(s.kind);
          return (
            <div className="shock" key={s.id} data-testid="shock-row">
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

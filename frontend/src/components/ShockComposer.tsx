// The shock composer that the New experiment page and the World page's in-place panel share: how the
// server is set up (public mode, its caps and bot check), the plain-words box, the editable shock
// cards, and a run that waits its turn on the server's queue before the new world opens.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { getHealth, translateShock } from '../api';
import { JobContactLostError, waitForJob } from '../jobs';
import type { EffectCadence, EffectCatalog, EffectSpec, EffectWho, HealthResponse, JobResponse, ShockKind, ShockMember } from '../types';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { effectWords, shockWords, type Catalog } from '../arms';
import { openEndHint, rowFromTranslation } from '../shockForm';
import { changedSinceTranslation, isTraitKind, rowSpec, type ShockForm } from '../validation';
import { mountTurnstile } from '../turnstile';

export interface ServerSetup {
  health: HealthResponse | null;
  isPublic: boolean;
  /** Until the server has said how it is set up (and so whether a bot check guards POSTs), nothing is sent. */
  settling: boolean;
  /** The health check failed, which blocks sending too, rather than guessing the local mode. */
  missing: boolean;
  siteKey: string | null;
  /** Ask the server again after a failed health check. */
  retry: () => void;
}

export function useServerSetup(): ServerSetup {
  const [attempt, setAttempt] = useState(0);
  const health = useAsync(() => getHealth().catch(() => null), [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    health: health.data,
    isPublic: health.data?.public === true,
    settling: health.loading || health.data?.ok !== true,
    missing: !health.loading && health.data?.ok !== true,
    siteKey: health.data?.turnstile_site_key ?? null,
    retry,
  };
}

/**
 * Public mode's bot check, when the server names a site key. A layout effect, so the check counts as on
 * its way before the form can be clicked, and a POST made meanwhile waits for its token.
 */
export function BotCheck({ siteKey }: { siteKey: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (siteKey && ref.current) void mountTurnstile(ref.current, siteKey).catch(() => undefined);
  }, [siteKey]);
  return siteKey ? <div ref={ref} className="turnstile" data-testid="turnstile" /> : null;
}

export function HealthMissing({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="status error" role="alert" data-testid="health-missing">
      The server did not say how it is set up, so nothing can be run from this page yet.
      <div>
        <button type="button" onClick={onRetry}>
          Check again
        </button>
      </div>
    </div>
  );
}

export interface ShockRowsState {
  shocks: ShockForm[];
  add: (row: ShockForm) => void;
  update: (id: number, patch: Partial<ShockForm>) => void;
  updateEffect: (id: number, j: number, patch: Partial<EffectSpec>) => void;
  remove: (id: number) => void;
}

export function useShockRows(): ShockRowsState {
  const [shocks, setShocks] = useState<ShockForm[]>([]);
  const add = useCallback((row: ShockForm) => setShocks((s) => [...s, row]), []);
  const update = useCallback((id: number, patch: Partial<ShockForm>) => setShocks((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x))), []);
  const updateEffect = useCallback(
    (id: number, j: number, patch: Partial<EffectSpec>) => setShocks((s) => s.map((x) => (x.id === id ? { ...x, effects: (x.effects ?? []).map((e, i) => (i === j ? { ...e, ...patch } : e)) } : x))),
    [],
  );
  const remove = useCallback((id: number) => setShocks((s) => s.filter((x) => x.id !== id)), []);
  return { shocks, add, update, updateEffect, remove };
}

type TranslateState = { kind: 'idle' } | { kind: 'working' } | { kind: 'unsupported'; message: string } | { kind: 'error'; message: string };

export interface Describe {
  text: string;
  setText: (t: string) => void;
  state: TranslateState;
  /** True while translating is not possible: the server has not said how it is set up, or the world to fork is unknown. */
  blocked: boolean;
  translate: () => Promise<void>;
}

/** The plain-words box's state: the text, and a translation that adds the shock it maps to as an editable row. */
export function useDescribe({ days, kinds, blocked, onRow }: { days: number; kinds: ShockKind[]; blocked: boolean; onRow: (row: ShockForm) => void }): Describe {
  const [text, setText] = useState('');
  const [state, setState] = useState<TranslateState>({ kind: 'idle' });
  const translate = async () => {
    const words = text.trim();
    // The keyboard shortcut reaches here too, so the same conditions that disable the button apply.
    if (!words || state.kind === 'working' || blocked) return;
    setState({ kind: 'working' });
    try {
      const res = await translateShock(words, days);
      const row = rowFromTranslation(res, words, kinds);
      if (!row) {
        setState({ kind: 'unsupported', message: res.message ?? res.rationale ?? 'That description is not one of the shock kinds.' });
        return;
      }
      onRow(row);
      setText('');
      setState({ kind: 'idle' });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  return { text, setText, state, blocked, translate };
}

/** The plain-words box. `boxRef` lets the page put the cursor in it. */
export function DescribeBox({ describe, boxRef, placeholder = 'He loses his job in month three for four months' }: { describe: Describe; boxRef?: RefObject<HTMLTextAreaElement>; placeholder?: string }) {
  const { text, setText, state, blocked, translate } = describe;
  return (
    <div className="describe" data-testid="describe">
      <label>
        Describe what happens
        <textarea
          ref={boxRef}
          value={text}
          maxLength={400}
          rows={2}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
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
        <button type="button" onClick={() => void translate()} disabled={!text.trim() || state.kind === 'working' || blocked} data-testid="translate">
          {state.kind === 'working' ? 'Translating...' : 'Translate'}
        </button>
        <span className="muted">{text.length}/400. A model turns the words into one shock below, which you check and can change before it runs. The model never runs the simulation.</span>
      </div>
      {state.kind === 'unsupported' ? (
        <div className="status" role="status" data-testid="translate-unsupported">
          {state.message}
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <div className="status error" role="alert" data-testid="translate-error">
          Could not translate: {state.message}
        </div>
      ) : null}
    </div>
  );
}

/** Every shock row: the card a translation left (its words, the model's reasoning, any problem), then its fields. */
export function ShockRows({ rows, kinds, catalog, effects, days }: { rows: ShockRowsState; kinds: ShockKind[]; catalog: Catalog | null; effects: EffectCatalog | null; days: number }) {
  const { shocks, update, updateEffect, remove } = rows;
  const kindOf = (k: string) => kinds.find((x) => x.kind === k);
  return (
    <>
      {shocks.map((s) => {
        const k = kindOf(s.kind);
        const t = s.translation;
        return (
          <div className="shock" key={s.id} data-testid="shock-row">
            {t ? (
              <div className="translation-card" data-testid="translation-card">
                <div className="muted">From your words: "{t.text}"</div>
                <div data-testid="translation-words">{shockWords(rowSpec(s), catalog)}</div>
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
              <CustomShockFields shock={s} days={days} effects={effects} onChange={(patch) => update(s.id, patch)} onEffect={(j, patch) => updateEffect(s.id, j, patch)} onRemove={() => remove(s.id)} />
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
                        {k!.traits!.map((tr) => (
                          <option key={tr} value={tr}>
                            {tr.replace(/_/g, ' ')}
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
                      placeholder={openEndHint(s, catalog, days)}
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
    </>
  );
}

export function ValidationErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul className="status error" role="alert" data-testid="validation-errors" style={{ margin: '0.75rem 0', paddingLeft: '2rem' }}>
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

export type RunStatus =
  | { kind: 'idle' }
  | { kind: 'running'; started: number; job?: JobResponse }
  | { kind: 'error'; message: string }
  | { kind: 'lost'; job: JobResponse; message: string }
  | { kind: 'done'; name: string };

export interface RunJob {
  status: RunStatus;
  elapsed: number;
  running: boolean;
  /** Queue the run `submit` sends, follow it, refresh the list and hand the finished job to `onDone`. */
  start: (submit: () => Promise<JobResponse>, onDone: (job: JobResponse) => void) => Promise<void>;
  /** Ask after a job the page lost contact with; checking again never re-runs it. */
  checkAgain: () => void;
}

export function useRunJob(): RunJob {
  const exp = useExperiment();
  const [status, setStatus] = useState<RunStatus>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const onDone = useRef<(job: JobResponse) => void>(() => {});
  // A page the visitor has left never opens the finished run on top of where they went.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (status.kind !== 'running') return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - status.started) / 1000)), 500);
    return () => clearInterval(t);
  }, [status]);

  /** Wait for a queued job, then refresh the list and open it. Lost contact keeps the job, so checking again never re-runs it. */
  const follow = async (accepted: JobResponse, started: number) => {
    try {
      const job = await waitForJob(accepted, (j) => setStatus({ kind: 'running', started, job: j }));
      // A list that fails to refresh does not undo a finished run; the page still opens it.
      await exp.refresh().catch(() => []);
      setStatus({ kind: 'done', name: job.name });
      if (mounted.current) onDone.current(job);
    } catch (err) {
      if (err instanceof JobContactLostError) setStatus({ kind: 'lost', job: err.job, message: err.message });
      else setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const start = async (submit: () => Promise<JobResponse>, done: (job: JobResponse) => void) => {
    onDone.current = done;
    const started = Date.now();
    setStatus({ kind: 'running', started });
    setElapsed(0);
    let accepted: JobResponse;
    try {
      accepted = await submit();
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    await follow(accepted, started);
  };

  const checkAgain = () => {
    if (status.kind === 'lost') void follow(status.job, Date.now());
  };

  return { status, elapsed, running: status.kind === 'running', start, checkAgain };
}

/** What the run is doing while it waits or runs. */
export function RunProgress({ job }: { job: RunJob }) {
  const { status, elapsed } = job;
  if (status.kind !== 'running') return null;
  return (
    <span role="status" data-testid="progress">
      {status.job?.state === 'queued'
        ? `Waiting its turn, number ${status.job.position ?? 1} in line, ${elapsed}s so far.`
        : `Running the engine, its twins and the analysis, ${elapsed}s so far. About ten seconds at 1,000 couples for a year.`}
    </span>
  );
}

/** A failed run with a retry, a run the page lost contact with, or a finished one. */
export function RunOutcome({ job, onRetry }: { job: RunJob; onRetry: () => void }) {
  const { status } = job;
  if (status.kind === 'error') {
    return (
      <div className="status error" role="alert" data-testid="run-error">
        The run failed: {status.message}
        <div>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (status.kind === 'lost') {
    return (
      <div className="status error" role="alert" data-testid="run-lost">
        The page {status.message}.
        <div>
          <button type="button" onClick={job.checkAgain}>
            Check again
          </button>
        </div>
      </div>
    );
  }
  if (status.kind === 'done') return <div className="status">Experiment {status.name} is ready.</div>;
  return null;
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

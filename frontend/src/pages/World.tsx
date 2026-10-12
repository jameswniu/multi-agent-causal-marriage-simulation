// World replay page. It plays a finished run day by day so a viewer can watch what the memory
// setting does to 1,000 couples: a town where every couple is a house with its two agents (or the
// tile grids, side by side, or each couple under both settings), playback controls, counters and
// the day's events.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExpLink, useExpNavigate } from '../nav';
import { getCurves, getEventsForDay, getExperiment, getTwinsWorld, getWorld } from '../api';
import type { ArmCounts, Curves, EventRow, ExperimentResponse, TwinsWorldResponse, WorldResponse } from '../types';
import { useAsync } from '../useAsync';
import { ErrorBox, Loading } from '../components/Status';
import Banner from '../components/Banner';
import WorldGrid, { charStyle } from '../components/WorldGrid';
import TileLegend from '../components/TileLegend';
import Scoreboard, { pct } from '../components/Scoreboard';
import EventMarkers from '../components/EventMarkers';
import { differenceClause, sharedClause, useArmContext, whatDiffers, type ArmLabels, type Catalog, type Intervention } from '../arms';
import { supportsWebGL } from '../town/webgl';

const TownView = lazy(() => import('../town/TownView'));

const SPEEDS = [1, 10, 50] as const;
type Mode = 'randomized' | 'twins';
type View = 'town' | 'grid';

const EVENT_CACHE_MAX = 400;

interface TickerState {
  day: number | null;
  items: EventRow[] | null;
  error: string | null;
}

/**
 * Events for one day at a time through the per-day endpoint. One request in flight; a newer day
 * aborts the older request; failures are never cached and surface as an error with retry.
 */
/** Memory housekeeping events: logged for the developer view, kept out of the day's ticker. */
const HOUSEKEEPING = new Set(['memory_consolidated']);

/** The day's events a viewer should read, and how many housekeeping events were set aside. */
export function splitTicker(items: EventRow[]): { shown: EventRow[]; housekeeping: number } {
  const shown = items.filter((e) => !HOUSEKEEPING.has(e.kind));
  return { shown, housekeeping: items.length - shown.length };
}

function useDayEvents(day: number, enabled: boolean) {
  const cache = useRef<Map<number, EventRow[]>>(new Map());
  const ctrl = useRef<AbortController | null>(null);
  const [state, setState] = useState<TickerState>({ day: null, items: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const hit = cache.current.get(day);
    if (hit) {
      setState({ day, items: hit, error: null });
      return;
    }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ day, items: s.day === day ? s.items : null, error: null }));
    getEventsForDay(day, c.signal).then(
      (r) => {
        if (c.signal.aborted) return;
        const items = [...r.items].sort((a, b) => a.seq - b.seq);
        cache.current.set(day, items);
        if (cache.current.size > EVENT_CACHE_MAX) {
          const oldest = cache.current.keys().next().value;
          if (oldest !== undefined) cache.current.delete(oldest);
        }
        setState({ day, items, error: null });
      },
      (err: unknown) => {
        if (c.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ day, items: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => c.abort();
  }, [day, enabled, attempt]);
  useEffect(() => () => ctrl.current?.abort(), []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}

/** The one-sentence framing of the experiment, filled from the intervention. */
export function framingSentence(n: number, iv: Intervention, catalog: Catalog | null, mode: Mode, picture: 'grids' | 'districts' = 'grids'): string {
  if (mode === 'twins') {
    const lead = 'Each tile is one couple shown twice, the same people and the same random events';
    if (!iv.memory && !iv.treatmentShocks.length) {
      const shared = sharedClause(iv, catalog);
      return shared ? `${lead}, and nothing differs between the two runs; ${shared}.` : `${lead}, and nothing differs between the two runs.`;
    }
    const diff = whatDiffers(iv, catalog).replace(/^Only this, /, '').replace(/^Only /, '').replace(/\.$/, '');
    return `${lead}, and the only difference is ${diff[0].toLowerCase()}${diff.slice(1)}.`;
  }
  const couples = n.toLocaleString();
  const mem = iv.memory;
  const lead = `Both ${picture} start from the same ${couples} couples on the same day.`;
  if (mem && mem.parameter === 'conflict_half_life_days' && iv.treatmentShocks.length === 0) {
    const shared = sharedClause(iv, catalog);
    const tail = shared ? ` ${shared[0].toUpperCase()}${shared.slice(1)}.` : '';
    const c = fmtNum(mem.control_value);
    const t = fmtNum(mem.treatment_value);
    const middle =
      mem.control_value < mem.treatment_value
        ? `On the left a fight fades from memory in ${c} days. On the right it lingers for ${t}.`
        : mem.control_value > mem.treatment_value
          ? `On the left a fight lingers in memory for ${c} days. On the right it fades faster, in ${t}.`
          : `On both sides a fight's memory half-life is ${c} days.`;
    return `${lead} ${middle} Nothing else differs.${tail}`;
  }
  return `${lead} ${whatDiffers(iv, catalog)}`;
}

export function gridTitles(labels: ArmLabels): [string, string] {
  return [labels.control.plain, labels.treatment.plain];
}

export function gridSubtitles(labels: ArmLabels, mode: Mode): [string, string] {
  const twin = mode === 'twins' ? ', the control twin of every couple' : '';
  const twinT = mode === 'twins' ? ', the treatment twin of every couple' : '';
  return [`${labels.control.small}${twin}`, `${labels.treatment.small}${twinT}`];
}

export function takeaway(lastDay: number, control: ArmCounts, treatment: ArmCounts, nControl: number, nTreatment: number, mode: Mode, difference: string | null = 'how long a fight stayed in memory', shared: string | null = null): string {
  const c = pct(control.divorced, nControl);
  const t = pct(treatment.divorced, nTreatment);
  const head =
    mode === 'twins'
      ? `By day ${lastDay + 1}, ${c} of couples had divorced in their control run against ${t} in their treatment run.`
      : `By day ${lastDay + 1}, ${c} of control couples had divorced against ${t} of treatment couples.`;
  if (difference) return `${head} The only difference was ${difference}.`;
  if (shared) return `${head} Nothing differed between the arms; ${shared}.`;
  return `${head} Nothing differed between the arms.`;
}

function fmtNum(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

export function Counters({ world, day }: { world: WorldResponse; day: number }) {
  const c = world.counts[Math.min(day, world.counts.length - 1)];
  if (!c) return null;
  const row = (arm: 'control' | 'treatment') => (
    <tr key={arm}>
      <td>
        <span className="swatch" style={{ background: `var(--${arm})` }} aria-hidden="true" />
        {arm === 'control' ? 'Control' : 'Treatment'}
      </td>
      <td className="num" data-testid={`${arm}-married`}>{c[arm].married}</td>
      <td className="num" data-testid={`${arm}-conflict`}>{c[arm].conflict}</td>
      <td className="num" data-testid={`${arm}-separated`}>{c[arm].separated}</td>
      <td className="num" data-testid={`${arm}-divorced`}>{c[arm].divorced}</td>
    </tr>
  );
  return (
    <div className="table-wrap">
      <table className="data" aria-label="Running counters">
        <thead>
          <tr>
            <th>Arm</th>
            <th className="num">Married</th>
            <th className="num">In conflict</th>
            <th className="num">Separated</th>
            <th className="num">Divorced</th>
          </tr>
        </thead>
        <tbody>
          {row('control')}
          {row('treatment')}
        </tbody>
      </table>
    </div>
  );
}

async function loadAll(): Promise<[WorldResponse, ExperimentResponse | null, Curves | null]> {
  const [w, e, c] = await Promise.all([getWorld(), getExperiment().catch(() => null), getCurves().catch(() => null)]);
  return [w, e, c];
}

async function loadTwins(): Promise<TwinsWorldResponse> {
  try {
    return await getTwinsWorld();
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export default function World() {
  const navigate = useExpNavigate();
  const { data, error, loading } = useAsync(loadAll, []);
  const twins = useAsync(loadTwins, []);
  const arms = useArmContext();
  const [mode, setMode] = useState<Mode>('randomized');
  const webgl = useMemo(() => supportsWebGL(), []);
  const [view, setView] = useState<View>(() => (webgl ? 'town' : 'grid'));
  const [townNote, setTownNote] = useState<string | null>(null);
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(10);
  const acc = useRef(0);
  const last = useRef(0);
  const world = data?.[0] ?? null;
  const curves = data?.[2] ?? null;
  const twinsData = twins.data && twins.data.available ? twins.data : null;
  const ticker = useDayEvents(day, mode === 'randomized' && !!data);
  const days = mode === 'twins' && twinsData ? twinsData.days : (world?.days ?? 1);
  const maxDay = Math.max(0, days - 1);

  useEffect(() => {
    if (!playing || !world) return;
    let raf = 0;
    last.current = performance.now();
    acc.current = 0;
    const tick = (t: number) => {
      const dt = Math.max(0, (t - last.current) / 1000);
      last.current = t;
      // Backlog of days owed; capped so a long pause does not turn into minutes of catch-up.
      acc.current = Math.min(acc.current + dt * speed, speed * 2);
      if (acc.current >= 1) {
        // At most one day per rendered frame, so counters, events and pulses are all shown.
        acc.current -= 1;
        setDay((d) => {
          const next = Math.min(maxDay, d + 1);
          if (next >= maxDay) setPlaying(false);
          return next;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, world, maxDay]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'CANVAS' || el?.isContentEditable) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight') setDay((d) => Math.min(maxDay, d + step));
      else if (e.key === 'ArrowLeft') setDay((d) => Math.max(0, d - step));
      else if (e.key === 'Home') setDay(0);
      else if (e.key === 'End') setDay(maxDay);
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maxDay]);

  const groups = useMemo(() => {
    if (!world) return { control: [], treatment: [], remarriage: [] };
    const control: number[] = [];
    const treatment: number[] = [];
    const remarriage: number[] = [];
    world.couples.forEach((_, i) => {
      if (world.origin[i] === 'remarriage') remarriage.push(i);
      else if (world.arms[i] === 'treatment') treatment.push(i);
      else control.push(i);
    });
    return { control, treatment, remarriage };
  }, [world]);
  const allTwins = useMemo(() => (twinsData ? twinsData.couples.map((_, i) => i) : []), [twinsData]);

  if (error) return <ErrorBox message={error} />;
  if (!world) return <Loading what="the world" />;

  const nInitial = groups.control.length + groups.treatment.length;
  const [controlTitle, treatmentTitle] = gridTitles(arms.labels);
  const [controlSub, treatmentSub] = gridSubtitles(arms.labels, mode);
  const d = Math.min(day, maxDay);
  const counts = world.counts[Math.min(d, world.counts.length - 1)];
  const lastCounts = world.counts[world.counts.length - 1];
  const trustC = curves?.trust.control_mean[Math.min(d, curves.trust.control_mean.length - 1)];
  const trustT = curves?.trust.treatment_mean[Math.min(d, curves.trust.treatment_mean.length - 1)];
  const pick = (id: number) => navigate(`/couples/${id}`);
  const pickAgent = (id: number) => navigate(`/agents/${id}`);
  const townFallback = (reason: string) => {
    setTownNote(`Showing the grid because ${reason}.`);
    setView('grid');
  };
  const showTown = mode === 'randomized' && view === 'town';
  const twinsReason = twins.data && !twins.data.available ? twins.data.reason : twins.loading ? 'loading' : null;

  const scoreboard =
    mode === 'twins' && twinsData ? (
      <Scoreboard
        control={twinsData.counts_control[Math.min(d, twinsData.counts_control.length - 1)]}
        treatment={twinsData.counts_treatment[Math.min(d, twinsData.counts_treatment.length - 1)]}
        nControl={twinsData.couples.length}
        nTreatment={twinsData.couples.length}
        suffix="run"
      />
    ) : counts ? (
      <Scoreboard control={counts.control} treatment={counts.treatment} nControl={groups.control.length} nTreatment={groups.treatment.length} trustControl={trustC} trustTreatment={trustT} />
    ) : null;

  const atEnd = d >= maxDay;
  const takeawayText =
    mode === 'twins' && twinsData
      ? takeaway(maxDay, twinsData.counts_control[twinsData.counts_control.length - 1], twinsData.counts_treatment[twinsData.counts_treatment.length - 1], twinsData.couples.length, twinsData.couples.length, 'twins', differenceClause(arms.intervention, arms.catalog), sharedClause(arms.intervention, arms.catalog))
      : lastCounts
        ? takeaway(maxDay, lastCounts.control, lastCounts.treatment, groups.control.length, groups.treatment.length, 'randomized', differenceClause(arms.intervention, arms.catalog), sharedClause(arms.intervention, arms.catalog))
        : '';

  return (
    <div className={loading ? 'stale' : ''}>
      <Banner />
      <h1>World replay</h1>
      <p className="world-actions">
        <ExpLink to="/new?describe=1" className="button-link" data-testid="shock-this-world">
          Shock this world
        </ExpLink>
        <span className="muted">Describe what happens in your own words; the same couples run again with only that added.</span>
      </p>
      <p className="framing" data-testid="framing">
        {framingSentence(nInitial, arms.intervention, arms.catalog, mode, showTown ? 'districts' : 'grids')}
      </p>
      <div className="card">
        <div className="filters" role="group" aria-label="Playback">
          <div className="segmented" role="group" aria-label="View">
            <button onClick={() => setMode('randomized')} aria-pressed={mode === 'randomized'}>
              Randomized arms
            </button>
            <button onClick={() => setMode('twins')} aria-pressed={mode === 'twins'} disabled={!twinsData} title={twinsData ? undefined : `Twins run not available${twinsReason ? `: ${twinsReason}` : ''}`}>
              Same couples, both arms
            </button>
          </div>
          {mode === 'randomized' ? (
            <div className="segmented" role="group" aria-label="Picture">
              <button onClick={() => setView('town')} aria-pressed={view === 'town'} disabled={!webgl} title={webgl ? undefined : 'The town needs WebGL, which this browser does not offer.'}>
                Town
              </button>
              <button onClick={() => setView('grid')} aria-pressed={view === 'grid'}>
                Grid
              </button>
            </div>
          ) : null}
          <button onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <label>
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])} aria-label="Speed in days per second">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
            <span className="muted">days per second</span>
          </label>
          <label style={{ flex: '1 1 240px' }}>
            Day
            <input type="range" min={0} max={maxDay} value={d} onChange={(e) => setDay(Number(e.target.value))} aria-label="Day" style={{ flex: 1 }} />
            <strong data-testid="day-label">{d}</strong>
            <span className="muted">of {maxDay}</span>
          </label>
        </div>
        {!twinsData && twinsReason && twinsReason !== 'loading' ? (
          <p className="muted" data-testid="twins-reason">
            Same couples, both arms is unavailable: {twinsReason}
          </p>
        ) : null}
        <p className="muted">Arrow keys step a day, shift and arrow ten, space plays.</p>
        {townNote ? (
          <p className="muted" data-testid="town-note">
            {townNote}
          </p>
        ) : null}
        {showTown ? null : <TileLegend legend={world.legend} />}
      </div>

      {scoreboard}
      {atEnd && takeawayText ? (
        <p className="takeaway" data-testid="takeaway">
          {takeawayText}
        </p>
      ) : null}

      {mode === 'twins' && twinsData ? (
        <>
          <p className="muted" data-testid="diverged">
            Couples whose fate differs today, {twinsData.diverged[Math.min(d, twinsData.diverged.length - 1)].toLocaleString()} of {twinsData.couples.length.toLocaleString()}
          </p>
          <div className="grid-2">
            <WorldGrid
              title={controlTitle}
              subtitle={controlSub}
              couples={twinsData.couples}
              states={twinsData.states_control}
              indices={allTwins}
              day={d}
              onPick={pick}
              testId="grid-control"
              hoverExtra={(idx, dd) => `Treatment twin: ${charStyle(twinsData.states_treatment[Math.min(dd, twinsData.states_treatment.length - 1)]?.[idx] ?? '-').label}.`}
            />
            <WorldGrid
              title={treatmentTitle}
              subtitle={treatmentSub}
              couples={twinsData.couples}
              states={twinsData.states_treatment}
              indices={allTwins}
              day={d}
              onPick={pick}
              testId="grid-treatment"
              hoverExtra={(idx, dd) => `Control twin: ${charStyle(twinsData.states_control[Math.min(dd, twinsData.states_control.length - 1)]?.[idx] ?? '-').label}.`}
            />
          </div>
        </>
      ) : (
        <>
          {showTown ? (
            <Suspense fallback={<Loading what="the town" />}>
              <TownView world={world} day={d} speed={speed} controlTitle={controlTitle} treatmentTitle={treatmentTitle} onPickCouple={pick} onPickAgent={pickAgent} onFallback={townFallback} />
            </Suspense>
          ) : (
            <>
              <div className="grid-2">
                <WorldGrid title={controlTitle} subtitle={controlSub} couples={world.couples} states={world.states} indices={groups.control} day={d} onPick={pick} testId="grid-control" />
                <WorldGrid title={treatmentTitle} subtitle={treatmentSub} couples={world.couples} states={world.states} indices={groups.treatment} day={d} onPick={pick} testId="grid-treatment" />
              </div>
              <WorldGrid
                title={`After divorce, dating and remarriage${counts ? `: ${counts.remarriage.dating} dating, ${counts.remarriage.married} married today` : ''}`}
                subtitle="Dating only appears here. Every initial couple starts married, so these are divorced agents who met someone new."
                couples={world.couples}
                states={world.states}
                indices={groups.remarriage}
                day={d}
                tile={10}
                onPick={pick}
                testId="grid-remarriage"
              />
            </>
          )}
          <div className="grid-2">
            <div className="card">
              <h3>Counts on day {d}</h3>
              <Counters world={world} day={d} />
            </div>
            <div className="card">
              <h3>Events on day {d}</h3>
              {ticker.error ? (
                <div className="status error" role="alert" data-testid="ticker-error">
                  Could not load the events for day {d}: {ticker.error}
                  <div>
                    <button type="button" onClick={ticker.retry}>
                      Retry
                    </button>
                  </div>
                </div>
              ) : ticker.items === null ? (
                <p className="muted">Loading events...</p>
              ) : (
                <div className={ticker.day === d ? '' : 'stale'} data-testid="ticker">
                  {(() => {
                    const { shown, housekeeping } = splitTicker(ticker.items);
                    return (
                      <>
                        <EventMarkers events={shown} limit={40} withCouple />
                        {shown.length > 40 ? <p className="muted">Showing 40 of {shown.length}.</p> : null}
                        {housekeeping > 0 ? (
                          <p className="muted">
                            {housekeeping} memory {housekeeping === 1 ? 'consolidation' : 'consolidations'} not listed; a couple's Under the hood panel shows them.
                          </p>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

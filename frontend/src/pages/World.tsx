// World replay page. It plays a finished run day by day so a viewer can watch what the memory
// setting does to 1,000 couples: a town where every couple is a house with its two agents (or the
// tile grids, side by side, or each couple under both settings), playback controls, counters and
// the day's events. "Shock this world" runs a shock on the same couples from here, and a forked
// world rings every house whose couple differs from the world it came from.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ExpLink, useExpNavigate, type ReplayState } from '../nav';
import { getCouple, getCurves, getDayDigest, getEventsForDay, getExperiment, getLens, getTwinsWorld, getWorld, listLenses } from '../api';
import type { ArmCounts, CoupleDetailResponse, Curves, DayDigest, EventRow, ExperimentResponse, LensData, LensMeta, ShockSpec, TwinsWorldResponse, WorldResponse } from '../types';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { ErrorBox, Loading } from '../components/Status';
import Banner from '../components/Banner';
import WorldGrid, { charStyle } from '../components/WorldGrid';
import TileLegend from '../components/TileLegend';
import Scoreboard, { pct } from '../components/Scoreboard';
import EventMarkers from '../components/EventMarkers';
import { armLabelsFor, differenceClause, interventionOf, sharedClause, shockShort, useArmContext, whatDiffers, type ArmLabels, type Catalog, type Intervention } from '../arms';
import { supportsWebGL } from '../town/webgl';
import TimeStrip from '../components/TimeStrip';
import Inspector from '../town/Inspector';
import { countsForDay, dayLabel, densitySeries, kindWords, nextEventDay, shockBands } from '../town/timebar';
import ShockInPlace from '../components/ShockInPlace';
import { differCounter, differingOnDay, matchCouples } from '../worldDiff';
import { chanceWords, noIntervention } from '../nullRun';

const TownView = lazy(() => import('../town/TownView'));

const SPEEDS = [1, 10, 50] as const;
type Mode = 'randomized' | 'twins';
type View = 'town' | 'grid';

const EVENT_CACHE_MAX = 400;
/** Longest a replay requested by a finished run waits for the town and the compared world before it starts. */
const REPLAY_WAIT_MS = 8000;
/** A paused day's event list is fetched after this pause, so scrubbing asks once, not per day. */
const EVENT_FETCH_DELAY_MS = 120;

interface TickerState {
  day: number | null;
  items: EventRow[] | null;
  error: string | null;
}

/** Memory housekeeping events: logged for the developer view, kept out of the day's ticker. */
const HOUSEKEEPING = new Set(['memory_consolidated']);

/** The day's events a viewer should read, and how many housekeeping events were set aside. */
export function splitTicker(items: EventRow[]): { shown: EventRow[]; housekeeping: number } {
  const shown = items.filter((e) => !HOUSEKEEPING.has(e.kind));
  return { shown, housekeeping: items.length - shown.length };
}

/**
 * Events for one paused day at a time through the per-day endpoint, after a short pause so a scrub
 * asks once. While the replay plays the hook is disabled and the page shows the day digest's
 * counts instead, so playback makes no request per day. One request in flight; a newer day aborts
 * the older request; failures are never cached and surface as an error with retry.
 */
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
    const fetchDay = () =>
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
    const timer = window.setTimeout(fetchDay, EVENT_FETCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      c.abort();
    };
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

async function loadDigest(): Promise<DayDigest | null> {
  try {
    return await getDayDigest();
  } catch {
    return null;
  }
}

async function loadLenses(): Promise<LensMeta[]> {
  try {
    return (await listLenses()).items;
  } catch {
    return [];
  }
}

/** World indices of each district: the two randomized arms and the couples formed by remarriage. */
function armGroups(world: WorldResponse | null): { control: number[]; treatment: number[]; remarriage: number[] } {
  const control: number[] = [];
  const treatment: number[] = [];
  const remarriage: number[] = [];
  if (!world) return { control, treatment, remarriage };
  world.couples.forEach((_, i) => {
    if (world.origin[i] === 'remarriage') remarriage.push(i);
    else if (world.arms[i] === 'treatment') treatment.push(i);
    else control.push(i);
  });
  return { control, treatment, remarriage };
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
  const expName = useExperiment().name;
  const location = useLocation();
  // A world that was just run opens here and replays from just before its first shock, at ten days a second.
  const [pendingReplay, setPendingReplay] = useState<number | null>(() => {
    const from = (location.state as Partial<ReplayState> | null)?.replayFrom;
    return typeof from === 'number' && Number.isFinite(from) ? Math.max(0, Math.floor(from)) : null;
  });
  const [shockOpen, setShockOpen] = useState(false);
  const { data, error, loading } = useAsync(loadAll, []);
  const twins = useAsync(loadTwins, []);
  const arms = useArmContext();
  const [mode, setMode] = useState<Mode>('randomized');
  const webgl = useMemo(() => supportsWebGL(), []);
  const [view, setView] = useState<View>(() => (webgl ? 'town' : 'grid'));
  const [townNote, setTownNote] = useState<string | null>(null);
  const [day, setDay] = useState(() => pendingReplay ?? 0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(10);
  const acc = useRef(0);
  const last = useRef(0);
  const world = data?.[0] ?? null;
  const curves = data?.[2] ?? null;
  // A forked world is compared with the world it came from: the same couples on the same random draws.
  const parentRecord = data?.[1]?.parent ?? null;
  const parentName = parentRecord?.parent ?? null;
  const parentWorld = useAsync(() => (parentName ? getWorld(parentName) : Promise.resolve(null)), [parentName]);
  const [showParent, setShowParent] = useState(false);
  const pw = parentName ? parentWorld.data : null;
  const flipped = showParent && pw !== null;
  // The world the town (or the grids) draws: this one, or the one it came from on the same day.
  const shown = flipped ? pw : world;
  const twinsData = twins.data && twins.data.available ? twins.data : null;
  // The day's event list is fetched only while paused; playing shows the digest's counts.
  const ticker = useDayEvents(day, mode === 'randomized' && !!data && !playing);
  const digest = useAsync(loadDigest, []);
  const lensList = useAsync(loadLenses, []);
  const [lensName, setLensName] = useState<string | null>(null);
  // Lenses and errors are kept per name and tagged with the world they came from, so switching
  // experiments never shows another run's colours.
  const [lensLoaded, setLensLoaded] = useState<Record<string, { world: WorldResponse; data: LensData | null; error: string | null }>>({});
  useEffect(() => {
    if (!lensName || !world) return;
    const have = lensLoaded[lensName];
    if (have && have.world === world && (have.data || have.error)) return;
    let live = true;
    getLens(lensName).then(
      (data) => {
        if (live) setLensLoaded((prev) => ({ ...prev, [lensName]: { world, data, error: null } }));
      },
      (err: unknown) => {
        if (live) setLensLoaded((prev) => ({ ...prev, [lensName]: { world, data: null, error: err instanceof Error ? err.message : String(err) } }));
      },
    );
    return () => {
      live = false;
    };
  }, [lensName, world, lensLoaded]);
  const retryLens = useCallback(() => {
    if (!lensName) return;
    setLensLoaded((prev) => {
      const next = { ...prev };
      delete next[lensName];
      return next;
    });
  }, [lensName]);
  const lensEntry = lensName ? lensLoaded[lensName] : undefined;
  const lensFresh = lensEntry && lensEntry.world === world ? lensEntry : null;

  // The couple panel: a click on a house opens it beside the town instead of leaving the page.
  const [inspectFor, setInspectFor] = useState<{ world: WorldResponse | null; id: number } | null>(null);
  const inspect = inspectFor && inspectFor.world === shown ? inspectFor.id : null;
  // A house opened while the town shows the parent world opens that couple in the parent world.
  const inspectExperiment = flipped ? parentName : null;
  const [coupleAttempt, setCoupleAttempt] = useState(0);
  const [coupleState, setCoupleState] = useState<{ id: number; attempt: number; detail: CoupleDetailResponse | null; error: string | null } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (inspect === null) return;
    let live = true;
    getCouple(inspect, inspectExperiment).then(
      (d) => {
        if (live) setCoupleState({ id: inspect, attempt: coupleAttempt, detail: d, error: null });
      },
      (err: unknown) => {
        if (live) setCoupleState({ id: inspect, attempt: coupleAttempt, detail: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [inspect, coupleAttempt, inspectExperiment]);
  const openInspector = useCallback(
    (id: number) => {
      const el = document.activeElement;
      opener.current = el instanceof HTMLElement ? el : null;
      setInspectFor({ world: shown, id });
    },
    [shown],
  );
  const closeInspector = useCallback(() => {
    setInspectFor(null);
    const el = opener.current;
    opener.current = null;
    if (el && el.isConnected) el.focus();
  }, []);
  const retryCouple = useCallback(() => setCoupleAttempt((a) => a + 1), []);
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

  const groups = useMemo(() => armGroups(world), [world]);
  const shownGroups = useMemo(() => (shown === world ? groups : armGroups(shown)), [shown, world, groups]);
  // Couples matched by id between the world drawn and the other one, for the rings and the counter.
  const otherWorld = flipped ? world : pw;
  const match = useMemo(() => (shown && otherWorld ? matchCouples(shown, otherWorld) : null), [shown, otherWorld]);
  // The parent's arm labels: this world's intervention without the shocks the fork appended.
  const parentLabels = useMemo(() => {
    const exp = data?.[1]?.summary?.experiment;
    if (!parentRecord || !exp) return null;
    const own = exp.shocks ?? [];
    return armLabelsFor(interventionOf(exp.treatment, own.slice(0, Math.max(0, own.length - parentRecord.appended_shocks.length))), arms.catalog);
  }, [data, parentRecord, arms.catalog]);
  const allTwins = useMemo(() => (twinsData ? twinsData.couples.map((_, i) => i) : []), [twinsData]);

  // Built once per run, not per day, so the strip under the scrubber keeps its drawn bars while the
  // replay plays; rebuilding them each day redrew the whole strip on every frame.
  const runDays = world?.days ?? 0;
  const runShocks: ShockSpec[] = useMemo(
    () => data?.[1]?.summary?.experiment?.shocks ?? [...arms.intervention.treatmentShocks, ...arms.intervention.worldShocks],
    [data, arms.intervention],
  );
  const bands = useMemo(() => shockBands(runShocks, arms.catalog, runDays, (s) => shockShort(s, arms.catalog)), [runShocks, arms.catalog, runDays]);
  const density = useMemo(() => densitySeries(digest.data ?? null, runDays), [digest.data, runDays]);

  // A requested replay starts once the picture can show it: the town built (or the grids drawn) and the
  // world it is compared with loaded, so the rings are there from its first day. It never waits more
  // than a few seconds for either.
  const [townReady, setTownReady] = useState(false);
  const onTownReady = useCallback(() => setTownReady(true), []);
  const stageRef = useRef<HTMLDivElement>(null);
  const replayDeadline = useRef<number | null>(null);
  const parentLoading = parentName !== null && parentWorld.loading;
  // Today's rings: the couples of the drawn world whose state differs from the other world's today.
  const ringDay = Math.min(day, maxDay);
  const rings = useMemo(() => (match && shown && otherWorld ? differingOnDay(shown, otherWorld, match, ringDay) : null), [match, shown, otherWorld, ringDay]);
  useEffect(() => {
    if (pendingReplay === null || !world) return;
    const drawsTown = mode === 'randomized' && view === 'town';
    const ready = !parentLoading && (!drawsTown || townReady);
    if (replayDeadline.current === null) replayDeadline.current = Date.now() + REPLAY_WAIT_MS;
    const start = () => {
      setPendingReplay(null);
      setDay(Math.min(pendingReplay, Math.max(0, world.days - 1)));
      setSpeed(10);
      setPlaying(true);
      stageRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    };
    const timer = window.setTimeout(start, ready ? 0 : Math.max(0, replayDeadline.current - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pendingReplay, world, mode, view, townReady, parentLoading]);

  if (error) return <ErrorBox message={error} />;
  if (!world) return <Loading what="the world" />;

  const nInitial = groups.control.length + groups.treatment.length;
  const [controlTitle, treatmentTitle] = gridTitles(arms.labels);
  const [controlSub, treatmentSub] = gridSubtitles(arms.labels, mode);
  const d = Math.min(day, maxDay);
  // What the town or the grids draw: this world, or the one it came from on the same day.
  const drawn = shown ?? world;
  const [drawnControl, drawnTreatment] = flipped && parentLabels ? gridTitles(parentLabels) : [controlTitle, treatmentTitle];
  const exp = data?.[1]?.summary?.experiment;
  // A run with no intervention leads with its twins (the same couples under both settings come out the
  // same), then the gap between its two halves, which are different couples, for the whole replay.
  const summary = data?.[1]?.summary;
  const chance = mode === 'randomized' && exp && noIntervention(exp.treatment, exp.shocks) ? chanceWords(summary?.outcomes.find((o) => o.name === 'divorce_rate'), nInitial, summary?.governance?.twins) : null;
  const counts = world.counts[Math.min(d, world.counts.length - 1)];
  const lastCounts = world.counts[world.counts.length - 1];
  const trustC = curves?.trust.control_mean[Math.min(d, curves.trust.control_mean.length - 1)];
  const trustT = curves?.trust.treatment_mean[Math.min(d, curves.trust.treatment_mean.length - 1)];
  const pick = (id: number) => navigate(`/couples/${id}`);
  const pickAgent = (id: number) => navigate(`/agents/${id}`, flipped ? parentName : undefined);
  const inspecting = mode === 'randomized' && inspect !== null;
  const coupleCurrent = coupleState && coupleState.id === inspect && coupleState.attempt === coupleAttempt ? coupleState : null;
  const coupleDetail = coupleCurrent ? coupleCurrent.detail : null;
  const nextDay = coupleDetail ? nextEventDay(coupleDetail.events, d) : null;
  const inspectArm = (() => {
    if (inspect === null) return null;
    const i = drawn.couples.indexOf(inspect);
    if (i < 0) return null;
    if (drawn.origin[i] === 'remarriage') return 'Remarried, formed after a divorce';
    return drawn.arms[i] === 'treatment' ? drawnTreatment : drawnControl;
  })();
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
  const worldName = expName ?? data?.[1]?.manifest.name ?? null;

  return (
    <div className={loading ? 'stale' : ''}>
      <Banner />
      <h1>World replay</h1>
      <p className="world-actions">
        <button type="button" className="button-link" onClick={() => setShockOpen((o) => !o)} aria-expanded={shockOpen} disabled={!worldName} data-testid="shock-this-world">
          Shock this world
        </button>
        <span className="muted">Describe what happens in your own words. The same couples run again with only that added, and the town switches to the new world right here.</span>
      </p>
      {shockOpen && worldName ? <ShockInPlace world={worldName} onClose={() => setShockOpen(false)} /> : null}
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
          {inspecting ? (
            <button
              type="button"
              onClick={() => {
                if (nextDay === null) return;
                setPlaying(false);
                setDay(nextDay);
              }}
              disabled={nextDay === null}
              data-testid="next-event"
              title={nextDay === null ? `No later event for couple ${inspect}` : `Jump to day ${nextDay}`}
            >
              Next event for couple {inspect}
            </button>
          ) : null}
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
          <label className="day-control" style={{ flex: '1 1 240px' }}>
            Day
            <input type="range" min={0} max={maxDay} value={d} onChange={(e) => setDay(Number(e.target.value))} aria-label="Day" style={{ flex: 1 }} />
            <strong data-testid="day-label">{dayLabel(d)}</strong>
            <span className="muted">last day {maxDay}</span>
          </label>
        </div>
        {!twinsData && twinsReason && twinsReason !== 'loading' ? (
          <p className="muted" data-testid="twins-reason">
            Same couples, both arms is unavailable: {twinsReason}
          </p>
        ) : null}
        {mode === 'randomized' ? (
          <TimeStrip
            days={world.days}
            day={d}
            density={density}
            bands={bands}
            controlTitle={controlTitle}
            treatmentTitle={treatmentTitle}
            onSeek={(x) => {
              setPlaying(false);
              setDay(x);
            }}
          />
        ) : null}
        <p className="muted">Arrow keys step a day, shift and arrow ten, space plays.</p>
        {townNote ? (
          <p className="muted" data-testid="town-note">
            {townNote}
          </p>
        ) : null}
        {showTown ? null : <TileLegend legend={world.legend} ringed={mode === 'randomized' && rings !== null} />}
      </div>

      {scoreboard}
      {chance ? (
        <div className="takeaway" data-testid="null-run">
          <p className="takeaway-lead">{chance.lead}</p>
          {chance.detail ? <p className="takeaway-detail">{chance.detail}</p> : null}
        </div>
      ) : null}
      {atEnd && takeawayText && !chance ? (
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
        <div ref={stageRef} className="world-stage">
          {parentName ? (
            <section className="card compare" aria-label="Compared with the world it came from" data-testid="compare">
              <div className="compare-head">
                <h3>Compared with the world it came from</h3>
                {pw ? (
                  <div className="segmented" role="group" aria-label="The town shows">
                    <button type="button" onClick={() => setShowParent(false)} aria-pressed={!flipped}>
                      This world
                    </button>
                    <button type="button" onClick={() => setShowParent(true)} aria-pressed={flipped}>
                      {parentName}
                    </button>
                  </div>
                ) : null}
              </div>
              {parentWorld.error ? (
                <div className="status error" role="alert">
                  Could not load {parentName} to compare: {parentWorld.error}
                </div>
              ) : !pw || !match ? (
                <p className="muted">Loading {parentName} to compare...</p>
              ) : (
                <>
                  <p className="compare-count" data-testid="differ-count">
                    <span className="diff-ring-key" aria-hidden="true" />
                    {differCounter(rings?.length ?? 0, match.compared, parentName)}.
                  </p>
                  <p className="muted">
                    {flipped ? `The town now shows ${parentName} on day ${d}. The scoreboard, the counts and the events on this page stay with this world. ` : ''}A ring marks each {showTown ? 'house' : 'tile'} whose couple is in a different state today than the same couple in{' '}
                    {flipped ? 'this world' : parentName}. Both worlds run the same couples on the same random draws, so every ring is the added shock's doing. Each couple's whole year is compared on{' '}
                    <ExpLink to="/overview">Overview, under Versus its parent</ExpLink>.
                  </p>
                </>
              )}
            </section>
          ) : null}
          <div className={inspecting ? 'world-main with-panel' : 'world-main'}>
          <div className="world-view">
          {showTown ? (
            <Suspense fallback={<Loading what="the town" />}>
              <TownView
                world={drawn}
                day={d}
                speed={speed}
                controlTitle={drawnControl}
                treatmentTitle={drawnTreatment}
                onPickCouple={openInspector}
                onPickAgent={pickAgent}
                onFallback={townFallback}
                lenses={flipped ? [] : (lensList.data ?? [])}
                lensName={flipped ? null : lensName}
                lens={!flipped && lensFresh ? lensFresh.data : null}
                lensError={!flipped && lensFresh ? lensFresh.error : null}
                onLensChange={setLensName}
                onLensRetry={retryLens}
                selectedCouple={inspect}
                rings={rings}
                experiment={flipped ? parentName : null}
                onReady={onTownReady}
              />
            </Suspense>
          ) : (
            <>
              <div className="grid-2">
                <WorldGrid title={drawnControl} subtitle={controlSub} couples={drawn.couples} states={drawn.states} indices={shownGroups.control} day={d} onPick={openInspector} rings={rings} testId="grid-control" />
                <WorldGrid title={drawnTreatment} subtitle={treatmentSub} couples={drawn.couples} states={drawn.states} indices={shownGroups.treatment} day={d} onPick={openInspector} rings={rings} testId="grid-treatment" />
              </div>
              <WorldGrid
                title={`After divorce, dating and remarriage${counts && !flipped ? `: ${counts.remarriage.dating} dating, ${counts.remarriage.married} married today` : ''}`}
                subtitle="Dating only appears here. Every initial couple starts married, so these are divorced agents who met someone new."
                couples={drawn.couples}
                states={drawn.states}
                indices={shownGroups.remarriage}
                day={d}
                tile={10}
                onPick={openInspector}
                testId="grid-remarriage"
              />
            </>
          )}
          </div>
          {inspecting && inspect !== null ? (
            <Inspector
              coupleId={inspect}
              detail={coupleDetail}
              error={coupleCurrent ? coupleCurrent.error : null}
              day={d}
              armWords={inspectArm}
              onClose={closeInspector}
              onRetry={retryCouple}
            />
          ) : null}
          </div>
        </div>
          <div className="grid-2">
            <div className="card">
              <h3>Counts on day {d}{flipped ? ' in this world' : ''}</h3>
              <Counters world={world} day={d} />
            </div>
            <div className="card">
              <h3>Events on day {d}{flipped ? ' in this world' : ''}</h3>
              {playing ? (
                <DayCounts digest={digest.data ?? null} day={d} controlTitle={controlTitle} treatmentTitle={treatmentTitle} />
              ) : ticker.error ? (
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

/** The day's event counts from the digest, shown while the replay plays instead of fetching the list. */
function DayCounts({ digest, day, controlTitle, treatmentTitle }: { digest: DayDigest | null; day: number; controlTitle: string; treatmentTitle: string }) {
  if (!digest) return <p className="muted">Counts appear when the run's day digest loads; pause to list the day's events.</p>;
  const { rows, housekeeping } = countsForDay(digest, day);
  return (
    <div data-testid="day-counts">
      {rows.length === 0 ? (
        <p className="muted">No events this day.</p>
      ) : (
        <div className="table-wrap">
          <table className="data" aria-label={`Event counts on day ${day}`}>
            <thead>
              <tr>
                <th>Event</th>
                <th className="num" title={controlTitle}>Control</th>
                <th className="num" title={treatmentTitle}>Treatment</th>
                <th className="num">Remarried</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.kind}>
                  <td>{kindWords(r.kind)}</td>
                  <td className="num">{r.control}</td>
                  <td className="num">{r.treatment}</td>
                  <td className="num">{r.remarriage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        Counted while playing{housekeeping > 0 ? `, plus ${housekeeping} memory ${housekeeping === 1 ? 'consolidation' : 'consolidations'}` : ''}. Pause to list the day's events one by one.
      </p>
    </div>
  );
}

// The New experiment page. A visitor either forks the world they were watching (same couples, seeds
// and settings, with shocks added) or sets up a fresh run of the couples simulation (how many couples,
// how many days, how long the treatment arm remembers a fight, and any shocks). A shock can be described
// in plain words for the server to translate into an editable row. The run waits its turn on the
// server's queue, and the World page opens the new world and replays it when it is done.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { forkExperiment, getExperiment, getShocksCatalog, runExperiment } from '../api';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { useOpenNewWorld } from '../nav';
import { ErrorBox, Loading } from '../components/Status';
import { BotCheck, DescribeBox, HealthMissing, RunOutcome, RunProgress, ShockRows, ValidationErrors, useDescribe, useRunJob, useServerSetup, useShockRows } from '../components/ShockComposer';
import { humanDuration, toCatalog } from '../arms';
import { buildForkRequest, buildRequest, defaultRunName, draftFor, replayStartDay } from '../shockForm';
import { validateRun, type RunForm, type RunRules } from '../validation';

export default function NewExperiment() {
  const openWorld = useOpenNewWorld();
  const exp = useExperiment();
  const catalog = useAsync(getShocksCatalog, []);
  const current = useAsync(() => getExperiment().catch(() => null), []);
  const server = useServerSetup();
  const controlHalfLife = current.data?.summary?.experiment.treatment.control_value ?? 14;
  // Empty until the visitor types one: the server then names the run by the second it starts, so two runs started
  // in the same minute never share a name. A typed name that is taken is the server's 409.
  const [name, setName] = useState('');
  // When the page opened, for the example name the empty field shows.
  const [openedAt] = useState(() => new Date());
  const [nCouples, setNCouples] = useState(1000);
  const [days, setDays] = useState(365);
  const [treatmentHalfLife, setTreatmentHalfLife] = useState<number | null>(null);
  const rows = useShockRows();
  const [overwrite, setOverwrite] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [params] = useSearchParams();
  // Start from the world the visitor was watching (the experiment in the URL), or a fresh population.
  const [startFrom, setStartFrom] = useState<string>(() => params.get('experiment') ?? '');
  const kinds = useMemo(() => catalog.data?.kinds ?? [], [catalog.data]);
  const catalogMap = useMemo(() => toCatalog(kinds), [kinds]);
  const halfLife = treatmentHalfLife ?? controlHalfLife;
  const { isPublic, settling } = server;
  const limits = server.health?.limits;
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
    () => ({ nameAssigned: isPublic, fork: forking, parentProblem, parentShocks: parentItem?.intervention?.shocks ?? null, maxCouples: limits?.max_couples, maxDays: limits?.max_days }),
    [isPublic, forking, parentProblem, parentItem, limits],
  );
  const shocks = rows.shocks;
  const form = useMemo<RunForm>(() => ({ name, nCouples: runCouples, days: runDays, treatmentHalfLife: halfLife, shocks, overwrite }), [name, runCouples, runDays, halfLife, shocks, overwrite]);
  const effectCatalog = catalog.data?.effects ?? null;
  const errors = useMemo(() => validateRun(form, kinds, effectCatalog, rules), [form, kinds, effectCatalog, rules]);
  const describe = useDescribe({ days: runDays, kinds, blocked: settling || parentProblem !== null, onRow: rows.add });
  const job = useRunJob();

  // The ?describe=1 link puts the cursor in the plain-words box.
  const describeRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (catalog.data && params.get('describe') === '1') describeRef.current?.focus();
  }, [catalog.data, params]);

  /** Validate, queue the run (a fork or a fresh one), and follow it. Shared by the Run and Try again buttons. */
  const run = () => {
    if (settling || job.running) return;
    if (validateRun(form, kinds, effectCatalog, rules).length) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    const from = replayStartDay(form.shocks, runDays);
    const nameAssigned = isPublic || form.name.trim() === '';
    void job.start(
      () => (forking ? forkExperiment(buildForkRequest(form, kinds, startFrom, { nameAssigned })) : runExperiment(buildRequest(form, kinds, { nameAssigned }))),
      (done) => openWorld(done.name, from),
    );
  };

  if (catalog.error) return <ErrorBox message={catalog.error} />;
  if (!catalog.data) return <Loading what="the shock catalog" />;

  return (
    <div>
      <h1>New experiment</h1>
      <p className="muted">
        Start from the world you were watching to see what a shock does to the very same couples, or from a fresh population that is randomized into two arms. Add shocks that hit only the treatment arm or everyone, and run. The engine and the analysis take about ten seconds at 1,000 couples for a year, counting a second pass that runs every couple under both settings. Runs take turns on the server, and the new world opens on the World page.
      </p>
      <form
        className="card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          run();
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
              <input type="text" value={name} placeholder={defaultRunName(openedAt, forking ? startFrom : null)} onChange={(e) => setName(e.target.value)} aria-label="Name" />
              <span className="muted">Left empty, the run is named for the time it starts, in UTC.</span>
            </label>
          )}
          {forking ? null : (
            <>
              <label>
                Couples (up to {(limits?.max_couples ?? 2000).toLocaleString()})
                <input type="number" min={1} max={limits?.max_couples ?? 2000} step={1} value={nCouples} onChange={(e) => setNCouples(Number(e.target.value))} aria-label="Couples" />
              </label>
              <label>
                Days (up to {limits?.max_days ?? 730})
                <input type="number" min={1} max={limits?.max_days ?? 730} step={1} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days" />
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
            Forking {startFrom}: {runCouples.toLocaleString()} couples for {runDays} days, with its memory settings and every earlier shock kept. Nothing changes but the shocks below, so its World page can ring every couple that differs from the same couple in {startFrom}.
          </p>
        ) : null}
        {isPublic ? <p className="muted">This run gets a name of its own and stays visible to you for a day.</p> : null}
        <h2>Shocks</h2>
        <p className="muted">A shock is a scheduled stressor. "Only the treatment arm" makes it part of the intervention; "everyone" tests the memory treatment under the same stress on both sides.</p>
        <DescribeBox describe={describe} boxRef={describeRef} />
        <ShockRows rows={rows} kinds={kinds} catalog={catalogMap} effects={effectCatalog} days={runDays} />
        <div className="filters">
          <button type="button" onClick={() => kinds.length && rows.add(draftFor(kinds[0]))} disabled={kinds.length === 0}>
            Add shock
          </button>
          {forking || isPublic || name.trim() === '' ? null : (
            <label>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite if the name exists
            </label>
          )}
        </div>
        {showErrors ? <ValidationErrors errors={errors} /> : null}
        <BotCheck siteKey={server.siteKey} />
        {server.missing ? <HealthMissing onRetry={server.retry} /> : null}
        <div className="filters" style={{ marginTop: '1rem' }}>
          <button type="submit" disabled={job.running || settling} data-testid="run">
            {job.running ? 'Running...' : forking ? 'Run this world with the shocks' : 'Run experiment'}
          </button>
          <RunProgress job={job} />
        </div>
        <RunOutcome job={job} onRetry={run} />
      </form>
    </div>
  );
}

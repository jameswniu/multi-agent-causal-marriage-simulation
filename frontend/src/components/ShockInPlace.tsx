// "Shock this world" on the World page: the plain-words box, the shock card and the Run button right
// above the town. Run forks the world being watched (same couples, seeds and settings, with the shock
// added), the run and its twins wait their turn on the server's queue, and the page then switches to the
// new world and replays it from just before the shock, every couple that differs ringed on the town.
import { useEffect, useMemo, useRef, useState } from 'react';
import { forkExperiment, getShocksCatalog } from '../api';
import { useAsync } from '../useAsync';
import { useExperiment } from '../experiment';
import { ExpLink, useOpenNewWorld } from '../nav';
import { toCatalog } from '../arms';
import { buildForkRequest, replayStartDay } from '../shockForm';
import { validateRun, type RunForm, type RunRules } from '../validation';
import { BotCheck, DescribeBox, HealthMissing, RunOutcome, RunProgress, ShockRows, ValidationErrors, useDescribe, useRunJob, useServerSetup, useShockRows } from './ShockComposer';
import { Loading } from './Status';

export const IN_PLACE_PLACEHOLDER = 'His mother moves in for two months starting in month four';

export default function ShockInPlace({ world, onClose }: { world: string; onClose: () => void }) {
  const exp = useExperiment();
  const catalog = useAsync(getShocksCatalog, []);
  const server = useServerSetup();
  const openWorld = useOpenNewWorld();
  const rows = useShockRows();
  const [showErrors, setShowErrors] = useState(false);
  const item = exp.items.find((i) => i.name === world);
  const days = item?.days ?? 365;
  const kinds = useMemo(() => catalog.data?.kinds ?? [], [catalog.data]);
  const catalogMap = useMemo(() => toCatalog(kinds), [kinds]);
  const effects = catalog.data?.effects ?? null;
  const limits = server.health?.limits;
  // A fork is checked against the world's own days, so it waits until that world is in the list.
  const parentProblem = item
    ? null
    : exp.loading
      ? 'The list of worlds is still loading; wait a moment, then run.'
      : exp.error
        ? `The list of worlds did not load, so the couples and days of ${world} are unknown; reload the page to shock it.`
        : `${world} is not a world you can start from here.`;
  // The server names the new world, so there is no name to choose here.
  const rules = useMemo<RunRules>(
    () => ({ nameAssigned: true, fork: true, parentProblem, parentShocks: item?.intervention?.shocks ?? null, maxCouples: limits?.max_couples, maxDays: limits?.max_days }),
    [parentProblem, item, limits],
  );
  const form = useMemo<RunForm>(() => ({ name: '', nCouples: item?.n_couples ?? 0, days, treatmentHalfLife: 0, shocks: rows.shocks, overwrite: false }), [item, days, rows.shocks]);
  const errors = useMemo(() => validateRun(form, kinds, effects, rules), [form, kinds, effects, rules]);
  const describe = useDescribe({ days, kinds, blocked: server.settling || parentProblem !== null, onRow: rows.add });
  const job = useRunJob();

  // The panel opens with the cursor in the plain-words box.
  const describeRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (catalog.data) describeRef.current?.focus();
  }, [catalog.data]);

  const run = () => {
    if (server.settling || job.running) return;
    if (validateRun(form, kinds, effects, rules).length) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    const from = replayStartDay(form.shocks, days);
    void job.start(
      () => forkExperiment(buildForkRequest(form, kinds, world, { nameAssigned: true })),
      (done) => openWorld(done.name, from),
    );
  };

  return (
    <form
      className="card shock-panel"
      noValidate
      aria-label="Shock this world"
      data-testid="shock-panel"
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
    >
      <div className="shock-panel-head">
        <h2>Shock this world</h2>
        <button type="button" onClick={onClose} disabled={job.running}>
          Close
        </button>
      </div>
      <p className="muted" data-testid="fork-note">
        {parentProblem ??
          `The same ${(item?.n_couples ?? 0).toLocaleString()} couples of ${world} run again on the same random draws with only your shock added. When the run is done, this page switches to the new world and rings every house that differs from ${world}.`}
      </p>
      {catalog.error ? (
        <div className="status error" role="alert">
          Could not load the shock catalog: {catalog.error}
        </div>
      ) : !catalog.data ? (
        <Loading what="the shock catalog" />
      ) : (
        <>
          <DescribeBox describe={describe} boxRef={describeRef} placeholder={IN_PLACE_PLACEHOLDER} />
          <ShockRows rows={rows} kinds={kinds} catalog={catalogMap} effects={effects} days={days} />
        </>
      )}
      {showErrors ? <ValidationErrors errors={errors} /> : null}
      <BotCheck siteKey={server.siteKey} />
      {server.missing ? <HealthMissing onRetry={server.retry} /> : null}
      <div className="filters">
        <button type="submit" disabled={job.running || server.settling || !catalog.data} data-testid="run">
          {job.running ? 'Running...' : 'Run'}
        </button>
        <RunProgress job={job} />
      </div>
      <RunOutcome job={job} onRetry={run} />
      <p className="muted">
        A fresh population, or a shock picked from the catalog, starts on the <ExpLink to="/new?describe=1">New experiment</ExpLink> page.
      </p>
    </form>
  );
}

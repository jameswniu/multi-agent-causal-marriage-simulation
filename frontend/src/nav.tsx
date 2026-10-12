// Every in-app link and navigation goes through here so the experiment query survives.
import { Link, useNavigate, type LinkProps } from 'react-router-dom';
import { useCallback } from 'react';
import { useExperiment, withExperimentQuery } from './experiment';

/** A Link that carries ?experiment= for the selected experiment. */
export function ExpLink({ to, ...rest }: LinkProps & { to: string }) {
  const exp = useExperiment();
  return <Link to={withExperimentQuery(to, exp.name)} {...rest} />;
}

/** What a page that opens a newly run world passes to the World page: the day its replay starts on. */
export interface ReplayState {
  replayFrom: number;
}

/** navigate() that carries ?experiment=; pass `experiment` to switch to another one, and `state` for the page it opens. */
export function useExpNavigate(): (path: string, experiment?: string | null, state?: ReplayState) => void {
  const navigate = useNavigate();
  const exp = useExperiment();
  return useCallback(
    (path: string, experiment?: string | null, state?: ReplayState) => {
      navigate(withExperimentQuery(path, experiment === undefined ? exp.name : experiment), state ? { state } : undefined);
    },
    [navigate, exp.name],
  );
}

/** Open a world that was just run on the World page, replaying from `fromDay` at ten days a second. */
export function useOpenNewWorld(): (name: string, fromDay: number) => void {
  const navigate = useExpNavigate();
  return useCallback((name: string, fromDay: number) => navigate('/world', name, { replayFrom: fromDay }), [navigate]);
}

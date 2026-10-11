// Every in-app link and navigation goes through here so the experiment query survives.
import { Link, useNavigate, type LinkProps } from 'react-router-dom';
import { useCallback } from 'react';
import { useExperiment, withExperimentQuery } from './experiment';

/** A Link that carries ?experiment= for the selected experiment. */
export function ExpLink({ to, ...rest }: LinkProps & { to: string }) {
  const exp = useExperiment();
  return <Link to={withExperimentQuery(to, exp.name)} {...rest} />;
}

/** navigate() that carries ?experiment=; pass `experiment` to switch to another one. */
export function useExpNavigate(): (path: string, experiment?: string | null) => void {
  const navigate = useNavigate();
  const exp = useExperiment();
  return useCallback(
    (path: string, experiment?: string | null) => {
      navigate(withExperimentQuery(path, experiment === undefined ? exp.name : experiment));
    },
    [navigate, exp.name],
  );
}

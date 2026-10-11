// The experiment every page is scoped to, persisted in the URL as ?experiment=.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listExperiments, setCurrentExperiment } from './api';
import type { ExperimentListItem } from './types';

export interface ExperimentContextValue {
  /** Selected experiment name, or null when the API serves a single unnamed experiment. */
  name: string | null;
  items: ExperimentListItem[];
  loading: boolean;
  error: string | null;
  /** The URL names an experiment that is not in the list (checked once the list has loaded). */
  unknown: string | null;
  select: (name: string) => void;
  /** Reload the list from the API; resolves once the new list is in state. */
  refresh: () => Promise<ExperimentListItem[]>;
}

const Ctx = createContext<ExperimentContextValue>({ name: null, items: [], loading: false, error: null, unknown: null, select: () => {}, refresh: async () => [] });

interface ListState {
  items: ExperimentListItem[];
  defaultName: string | null;
  loaded: boolean;
  error: string | null;
}

export function ExperimentProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('experiment');
  const [list, setList] = useState<ListState>({ items: [], defaultName: null, loaded: false, error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await listExperiments();
      setList({ items: r.items, defaultName: r.default ?? null, loaded: true, error: null });
      return r.items;
    } catch (err) {
      setList((s) => ({ ...s, loaded: true, error: err instanceof Error ? err.message : String(err) }));
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const urlName = fromUrl && fromUrl.length > 0 ? fromUrl : null;
  const known = list.items.some((it) => it.name === urlName);
  const unknown = list.loaded && !list.error && urlName !== null && list.items.length > 0 && !known ? urlName : null;
  const name = urlName ?? list.defaultName;
  // The api module reads this synchronously on every request.
  setCurrentExperiment(name);
  useEffect(() => {
    setCurrentExperiment(name);
  }, [name]);

  const select = useCallback(
    (next: string) => {
      const p = new URLSearchParams(params);
      p.set('experiment', next);
      setParams(p);
    },
    [params, setParams],
  );

  const value = useMemo<ExperimentContextValue>(
    () => ({ name, items: list.items, loading: !list.loaded, error: list.error, unknown, select, refresh }),
    [name, list.items, list.loaded, list.error, unknown, select, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useExperiment(): ExperimentContextValue {
  return useContext(Ctx);
}

/** Keeps ?experiment= on in-app links. */
export function withExperimentQuery(path: string, name: string | null): string {
  if (!name) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}experiment=${encodeURIComponent(name)}`;
}

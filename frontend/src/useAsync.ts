import { useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface Settled<T> {
  key: string;
  data: T | null;
  error: string | null;
}

/**
 * Load data for the current deps. While a newer request is in flight the previous data stays
 * visible and `loading` is true (callers dim it). A failure under a new key clears the old data,
 * so a page never shows another key's data beside an error.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const key = JSON.stringify(deps);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setSettled({ key, data, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setSettled({ key, data: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = settled !== null && settled.key === key;
  return {
    data: current ? settled!.data : (settled?.data ?? null),
    error: current ? settled!.error : null,
    loading: !current,
  };
}

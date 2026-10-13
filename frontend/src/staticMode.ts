// The free, read-only demo on GitHub Pages is this dashboard built in static mode (VITE_STATIC=1): every read
// comes from files exported in advance (staticApi.ts), nothing can run, and a banner says so on every page.
// Off, as in the live app, none of this changes anything.

/** True only in the read-only static build. */
export const STATIC = import.meta.env.VITE_STATIC === '1';

/** Where the README says how to run LoveWorld yourself, shock box included. */
export const QUICKSTART_URL = 'https://github.com/jameswniu/multi-agent-causal-marriage-simulation#run-it';

/** The router's basename: the site's base path without its trailing slash ('/' in the live app). */
export function routerBasename(base: string = import.meta.env.BASE_URL): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

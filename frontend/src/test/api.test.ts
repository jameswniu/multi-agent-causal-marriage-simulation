// Tests for the real API client (not the mock): the bot-check token rides on a POST once and never on
// a GET, each POST gets a fresh token, a failed job is reported with the server's message, and a status
// check that fails is retried rather than reported as a failed run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExperiment, runExperiment, translateShock } from '../api';
import { JobContactLostError, JobFailedError, jobPolling, waitForJob } from '../jobs';
import { mountTurnstile, setTurnstileTokenForTests, takeTurnstileToken } from '../turnstile';

function stubFetch(responses: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = responses.shift() ?? {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

const polling = { ...jobPolling };

beforeEach(() => {
  jobPolling.pollMs = 1;
  jobPolling.maxMisses = 3;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTurnstileTokenForTests(null, true);
  document.head.querySelectorAll('script[src*="turnstile"]').forEach((el) => el.remove());
  Object.assign(jobPolling, polling);
});

describe('api client', () => {
  it('sends the bot-check token with one POST only, and never with a GET', async () => {
    const calls = stubFetch([{ manifest: {}, summary: null }, { translation_id: 't' }, { translation_id: 'u' }]);
    setTurnstileTokenForTests('tok-1');
    await getExperiment();
    await translateShock('He loses his job', 365);
    await translateShock('She loses her job', 365);
    const headers = calls.map((c) => (c.init?.headers ?? {}) as Record<string, string>);
    expect(headers[0]['cf-turnstile-response']).toBeUndefined();
    expect(headers[1]['cf-turnstile-response']).toBe('tok-1');
    expect(headers[2]['cf-turnstile-response']).toBeUndefined();
    expect(headers[1]['Content-Type']).toBe('application/json');
  });

  it('waits through queued and running to done, and reports a failure with its message', async () => {
    const first = { job_id: 'j1', kind: 'run' as const, name: 'x', state: 'queued' as const, position: 1, error: null, created: 0, started: null, finished: null };
    stubFetch([{ ...first, state: 'running', position: null }, { ...first, state: 'done', position: null }]);
    const seen: string[] = [];
    const done = await waitForJob(first, (j) => seen.push(j.state));
    expect(done.state).toBe('done');
    expect(seen).toEqual(['queued', 'running', 'done']);
    stubFetch([{ ...first, state: 'failed', error: 'results/x is not empty' }]);
    const failed = waitForJob(first);
    await expect(failed).rejects.toThrow('results/x is not empty');
    await expect(failed).rejects.toBeInstanceOf(JobFailedError);
  });

  it('retries a status check that fails, so a network blip is not a failed run', async () => {
    const first = { job_id: 'j2', kind: 'run' as const, name: 'y', state: 'running' as const, position: null, error: null, created: 0, started: 0, finished: null };
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n <= 2) return new Response('busy', { status: 503 });
        return new Response(JSON.stringify({ ...first, state: 'done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const done = await waitForJob(first);
    expect(done.state).toBe('done');
    expect(n).toBe(3);
  });

  it('after repeated failed checks says contact was lost and keeps the job, never calling it failed', async () => {
    const first = { job_id: 'j3', kind: 'fork' as const, name: 'z', state: 'queued' as const, position: 1, error: null, created: 0, started: null, finished: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const lost = waitForJob(first);
    await expect(lost).rejects.toBeInstanceOf(JobContactLostError);
    await expect(lost).rejects.toThrow('it may still finish');
    const err = (await lost.catch((e: unknown) => e)) as JobContactLostError;
    expect(err.job.job_id).toBe('j3');
  });

  it('holds a POST made while the check is still loading until the check hands over its first token', async () => {
    let callback: ((t: string) => void) | null = null;
    const mounted = mountTurnstile(document.createElement('div'), 'site-key');
    const calls = stubFetch([{ translation_id: 't' }]);
    const sent = translateShock('She gets a new job', 365);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(0);
    vi.stubGlobal('turnstile', {
      render: (_el: HTMLElement, opts: Record<string, unknown>) => {
        callback = opts.callback as (t: string) => void;
        return 'w2';
      },
      reset: vi.fn(),
    });
    const tag = document.head.querySelector<HTMLScriptElement>('script[src*="turnstile"]');
    tag!.onload!(new Event('load'));
    await mounted;
    callback!('tok-first');
    await sent;
    expect(((calls[0].init?.headers ?? {}) as Record<string, string>)['cf-turnstile-response']).toBe('tok-first');
  });

  it('lets a waiting POST go at once when the check fails to load, so the edge can say why', async () => {
    const mounted = mountTurnstile(document.createElement('div'), 'site-key');
    const calls = stubFetch([{ translation_id: 't' }]);
    const sent = translateShock('He moves away', 365);
    const tag = document.head.querySelector<HTMLScriptElement>('script[src*="turnstile"]');
    tag!.onerror!(new Event('error'));
    await expect(mounted).rejects.toThrow('the bot check could not load');
    await sent;
    expect(((calls[0].init?.headers ?? {}) as Record<string, string>)['cf-turnstile-response']).toBeUndefined();
  });

  it('gives every protected POST its own bot-check token, waiting for the check to hand over a fresh one', async () => {
    let callback: ((t: string) => void) | null = null;
    const reset = vi.fn();
    vi.stubGlobal('turnstile', {
      render: (_el: HTMLElement, opts: Record<string, unknown>) => {
        callback = opts.callback as (t: string) => void;
        return 'w1';
      },
      reset,
    });
    await mountTurnstile(document.createElement('div'), 'site-key');
    callback!('tok-a');
    const calls = stubFetch([{ translation_id: 't' }, { job_id: 'j', kind: 'run', name: 'n', state: 'queued', position: 1, error: null, created: 0, started: null, finished: null }]);
    await translateShock('He loses his job', 365);
    expect(reset).toHaveBeenCalledTimes(1);
    // The visitor presses Run right after translating: the request waits for the check's next token.
    const run = runExperiment({ name: 'n', control: {}, treatment: {} } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    callback!('tok-b');
    await run;
    const headers = calls.map((c) => (c.init?.headers ?? {}) as Record<string, string>);
    expect(headers[0]['cf-turnstile-response']).toBe('tok-a');
    expect(headers[1]['cf-turnstile-response']).toBe('tok-b');
    expect(reset).toHaveBeenCalledTimes(2);
    // With no token coming, a request goes out without one after the wait instead of hanging.
    await expect(takeTurnstileToken(5)).resolves.toBeNull();
  });
});

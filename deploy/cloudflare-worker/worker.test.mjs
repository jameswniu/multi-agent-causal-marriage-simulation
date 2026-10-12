// Tests for the edge worker, run with `node --test deploy/cloudflare-worker`. A fake fetch stands in for
// both Cloudflare's token check and the app, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './worker.js';

const env = { ORIGIN: 'https://app.example', TURNSTILE_SECRET: 'ts-secret', EDGE_SECRET: 'edge-secret' };

function fakeFetch(tokenOk) {
  const calls = [];
  const fn = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, request: typeof input === 'string' ? null : input, init });
    if (url.includes('siteverify')) return new Response(JSON.stringify({ success: tokenOk }), { status: 200 });
    return new Response('{"ok":true}', { status: 200 });
  };
  return { fn, calls };
}

test('a POST without a valid token never reaches the app', async () => {
  const { fn, calls } = fakeFetch(false);
  const res = await handle(new Request('https://site.example/api/shocks/translate', { method: 'POST', body: '{}', headers: { 'cf-turnstile-response': 'bad' } }), env, fn);
  assert.equal(res.status, 403);
  assert.equal(calls.filter((c) => c.url.startsWith('https://app.example')).length, 0);
});

test('a verified POST is forwarded with the edge secret and the visitor address, and spoofed headers are dropped', async () => {
  const { fn, calls } = fakeFetch(true);
  const req = new Request('https://site.example/api/experiments/run?wait=false', {
    method: 'POST',
    body: '{"days":100}',
    headers: { 'cf-turnstile-response': 'good', 'cf-connecting-ip': '9.9.9.9', 'x-loveworld-edge': 'forged', 'x-loveworld-client-ip': '1.2.3.4' },
  });
  const res = await handle(req, env, fn);
  assert.equal(res.status, 200);
  const forwarded = calls.find((c) => c.url.startsWith('https://app.example')).request;
  assert.equal(forwarded.url, 'https://app.example/api/experiments/run?wait=false');
  assert.equal(forwarded.headers.get('x-loveworld-edge'), 'edge-secret');
  assert.equal(forwarded.headers.get('x-loveworld-client-ip'), '9.9.9.9');
  assert.equal(forwarded.headers.get('cf-turnstile-response'), null);
  assert.equal(await forwarded.text(), '{"days":100}');
});

test('reads pass through without a token and without the edge secret', async () => {
  const { fn, calls } = fakeFetch(false);
  const res = await handle(new Request('https://site.example/api/health', { headers: { 'x-loveworld-edge': 'forged' } }), env, fn);
  assert.equal(res.status, 200);
  const forwarded = calls[0].request;
  assert.equal(forwarded.url, 'https://app.example/api/health');
  assert.equal(forwarded.headers.get('x-loveworld-edge'), null);
});

test('answers 503 with a plain message when the check itself cannot be reached', async () => {
  const fn = async (url) => {
    if (String(url).includes('siteverify')) throw new TypeError('network down');
    throw new Error('the app must not be reached');
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await handle(new Request('https://site.example/api/experiments/run', { method: 'POST', headers: { 'cf-turnstile-response': 'good' }, body: '{}' }), env, fn);
    assert.equal(res.status, 503);
    assert.match((await res.json()).detail, /could not be confirmed/);
  } finally {
    console.error = quiet;
  }
});

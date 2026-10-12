// The edge in front of the public LoveWorld app. Every POST to the API must carry a Cloudflare
// Turnstile token, which this checks with Cloudflare before forwarding the request to the app with a
// shared secret and the visitor's address; the app trusts that address only with the secret, and
// refuses any POST without it, so going around the edge gets nowhere. Reads pass straight through.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function verifyToken(token, ip, secret, fetcher = fetch) {
  if (!token || !secret) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetcher(VERIFY_URL, { method: 'POST', body: form });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}

export async function handle(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.ORIGIN);
  const headers = new Headers(request.headers);
  // Never let a visitor supply the headers only this edge may set.
  headers.delete('x-loveworld-edge');
  headers.delete('x-loveworld-client-ip');
  const ip = request.headers.get('cf-connecting-ip') || '';
  const isApiPost = request.method === 'POST' && url.pathname.startsWith('/api/');
  if (isApiPost) {
    let ok;
    try {
      ok = await verifyToken(request.headers.get('cf-turnstile-response'), ip, env.TURNSTILE_SECRET, fetcher);
    } catch (err) {
      // Cloudflare's check could not be reached or answered nonsense: say so, and leave a line in the Worker's logs.
      console.error('turnstile verification failed', err);
      return json({ detail: 'The bot check could not be confirmed just now; please try again in a minute.' }, 503);
    }
    if (!ok) return json({ detail: 'Please complete the check on the page, then try again.' }, 403);
    headers.set('x-loveworld-edge', env.EDGE_SECRET);
    headers.set('x-loveworld-client-ip', ip);
  }
  headers.delete('cf-turnstile-response');
  // Request bodies here are small JSON, so buffering keeps the forward simple and portable.
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  return fetcher(new Request(target.toString(), { method: request.method, headers, body, redirect: 'manual' }));
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};

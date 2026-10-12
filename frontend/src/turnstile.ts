// The bot check public mode puts in front of the plain-words box and the Run button. When the server
// names a Cloudflare Turnstile site key, the page loads Cloudflare's widget, keeps the latest token and
// sends it with the next POST, where the edge proxy verifies it before the request reaches the app.
// Without a site key (the local dashboard) nothing loads and requests go out exactly as before.

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let token: string | null = null;
let widgetId: string | null = null;
// True from the moment the page starts mounting the check until the widget is rendered (or fails).
let mounting = false;
let script: Promise<void> | null = null;
let waiters: ((t: string | null) => void)[] = [];

/** How long a request waits for the check to hand over a fresh token, in milliseconds. */
export const TOKEN_WAIT_MS = 15000;

function deliver(t: string): void {
  // A request already waiting takes this token (and its done() starts the next check); otherwise keep it.
  const next = waiters.shift();
  if (next) next(t);
  else token = t;
}

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!script) {
    script = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = SCRIPT_URL;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('the bot check could not load'));
      document.head.appendChild(el);
    });
  }
  return script;
}

/** Render the check into `el`; each token it hands over rides on one POST. Safe to call again for a new element. */
export async function mountTurnstile(el: HTMLElement, siteKey: string): Promise<void> {
  // Set before the first await, so a request made while the script loads waits for a token.
  mounting = true;
  try {
    await loadScript();
    if (!window.turnstile) return;
    token = null;
    widgetId = window.turnstile.render(el, {
      sitekey: siteKey,
      callback: (t: string) => deliver(t),
      'expired-callback': () => {
        token = null;
      },
    });
  } finally {
    mounting = false;
    if (!widgetId) {
      // No check will hand over a token, so release waiting requests now; the edge explains the refusal.
      const waiting = waiters;
      waiters = [];
      waiting.forEach((w) => w(null));
    }
  }
}

/**
 * A token for one request. Each token works once, so taking one starts a fresh check for the next
 * request; when none is ready yet (the visitor just translated a shock and now presses Run), this waits
 * for the check to hand one over, up to `waitMs`. With no check on the page it answers null at once.
 */
export function takeTurnstileToken(waitMs: number = TOKEN_WAIT_MS): Promise<string | null> {
  const ready = token;
  if (ready) {
    token = null;
    if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
    return Promise.resolve(ready);
  }
  if (!mounting && (!widgetId || !window.turnstile)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (t: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (t && widgetId && window.turnstile) window.turnstile.reset(widgetId);
      resolve(t);
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      done(null);
    }, waitMs);
    waiters.push(done);
  });
}

/** Test hook: put a token in place as if the visitor had passed the check, or forget the widget. */
export function setTurnstileTokenForTests(t: string | null, forgetWidget = false): void {
  token = t;
  if (forgetWidget) {
    widgetId = null;
    mounting = false;
    script = null;
    waiters = [];
  }
}

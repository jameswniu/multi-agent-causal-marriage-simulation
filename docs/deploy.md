# Deploying LoveWorld publicly

This is how I put the LoveWorld dashboard on the internet: one Docker image on a single Fly.io machine,
behind a Cloudflare Worker that stops bots before they reach the plain-words translator or the run
queue. It costs about $48 a month to keep up, and at most about $91 in a month when every visitor cap
is hit. Nothing in this repository creates an account, a secret or a paid resource; the steps below
are done by hand.

## What runs where

- The image (`Dockerfile`) builds the Rust engine, the React dashboard and the Python API, and
  simulates a few curated worlds while it builds: the example experiment with its placebo and twins
  runs, the job-loss experiment and the neuroticism-shift experiment.
- The Fly machine (`fly.toml`) runs that image in Ashburn with one dedicated CPU and 4 GB of memory,
  and keeps results on a 20 GB volume mounted at `/data`. Every boot copies the curated worlds from
  the image onto the volume, so they always match the engine in the image.
- The API runs in public mode (`LOVEWORLD_PUBLIC=1`, contract section 10). The curated worlds are
  read-only, each visitor's runs are visible only to them and are deleted after a day, runs are
  capped at 1,000 couples for 365 days and take turns on a queue, and translations are capped per
  visitor address and per day.
- The Cloudflare Worker (`deploy/cloudflare-worker/`) sits in front. It checks a Turnstile token on
  every POST to the API, then forwards the request with a shared secret and the visitor's address.
  The app refuses any POST without that secret, so going straight to the Fly address gets nowhere,
  and the image will not start in public mode at all until the secret is set.
- The translator calls Claude Haiku with an Anthropic key held only as a Fly secret.

## What it costs

| Item | Monthly cost | Note |
|---|---|---|
| Fly performance-1x machine with 4 GB | $45.00 | $33 for 2 GB plus $6 per extra GB, Fly's price list on 2026-10-11 |
| Fly volume, 20 GB | $3.00 | $0.15 per GB |
| Claude Haiku translations | $0 to $43 | 3,000 a day at most; an ordinary month is about $0.33 per 1,000 |
| Cloudflare Worker and Turnstile | $0 | Free plans, within their daily request limits |

Check the providers' current prices before creating anything; these are the figures the plan in
`docs/interactive-world-plan.md` was built on. I set a $50 monthly spend limit on the Anthropic key in
the Anthropic Console as a hard stop behind the app's own counters.

## Steps

You need a Fly.io account with a card, a Cloudflare account that manages the domain the site will
live on, and an Anthropic API key. Run the commands from a clone of
https://github.com/jameswniu/multi-agent-causal-marriage-simulation.

1. In the Cloudflare dashboard, add a Turnstile widget for the site's hostname and keep its site key
   and secret key.
2. Create the Fly app and its volume. The app is named after the repository; if `multi-agent-causal-marriage-simulation`
   is taken, pick another and change `app` in `fly.toml` and `ORIGIN` in
   `deploy/cloudflare-worker/wrangler.toml` to match.

   ```bash
   fly apps create multi-agent-causal-marriage-simulation
   fly volumes create loveworld_data --region iad --size 20
   ```

3. Set the app's secrets. The edge secret is a random value the Worker and the app share.

   ```bash
   EDGE=$(openssl rand -hex 32)
   fly secrets set ANTHROPIC_API_KEY=<the key> \
     LOVEWORLD_EDGE_SECRET=$EDGE \
     LOVEWORLD_SESSION_SECRET=$(openssl rand -hex 32) \
     LOVEWORLD_TURNSTILE_SITE_KEY=<the Turnstile site key>
   ```

4. Deploy the app and wait for its health check to pass.

   ```bash
   fly deploy
   fly status
   ```

5. Deploy the Worker with the Turnstile secret key and the same edge secret, then point the site's
   hostname at it (a custom domain or a route in `wrangler.toml`).

   ```bash
   cd deploy/cloudflare-worker
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put EDGE_SECRET
   npx wrangler deploy
   ```

6. Set the $50 monthly spend limit on the key in the Anthropic Console.

## Checking it

- The site's hostname opens on the example world, and a visitor can describe a shock, run it and see
  their own run in the experiment list.
- A POST straight to the Fly address is refused with a 403, which shows the edge is the only way in:

  ```bash
  curl -s -X POST https://multi-agent-causal-marriage-simulation.fly.dev/api/shocks/translate -H 'content-type: application/json' -d '{"text":"x"}'
  ```

- `fly logs` shows each run as it starts and finishes.

## Changing the caps

Each cap is an environment variable on the Fly app, set with `fly secrets set` or under `[env]` in
`fly.toml`, and contract section 10 lists them all. The ones I expect to touch are
`LOVEWORLD_TRANSLATE_GLOBAL_DAY` (3,000 translations a day overall), `LOVEWORLD_TRANSLATE_PER_IP_DAY`
(20 a day per address), `LOVEWORLD_QUEUE_MAX` (3 runs waiting) and `LOVEWORLD_VISITOR_TTL_HOURS` (24).

## Trying the image locally

```bash
docker build -t loveworld .
docker run --rm -p 8080:8080 -e LOVEWORLD_NO_EDGE=1 -v lwdata:/data loveworld
```

Then open http://localhost:8080. `LOVEWORLD_NO_EDGE=1` lets public mode start without the Worker's
secret, which is only safe on your own machine. Without `ANTHROPIC_API_KEY` the translator answers
that it has no key, and everything else works.

## Known limits

One machine runs one engine run at a time, so a burst of visitors waits in line and the fourth in line
is told the simulator is busy. A restart forgets queued runs, though finished ones stay on the volume.
How many runs an hour the Fly machine sustains has not been measured yet, and the caps should be
revisited once it has.

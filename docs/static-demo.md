# The free read-only demo

LoveWorld simulates 1,000 married couples for a year as a randomized trial of one setting, how long each
partner remembers a fight, and its dashboard plays the year back as a town with one house per couple. The
free demo at https://jameswniu.github.io/multi-agent-causal-marriage-simulation/ is a static copy of that
dashboard on GitHub Pages, so anyone can watch the example town, and three shocks run on it in advance,
without installing anything. A shock is one event added to a finished world, such as a layoff, after which
the same couples run again on the same random draws, so every difference is the shock's doing.

The full dashboard needs a server to run a world and a model to read a shock typed in plain words, and both
cost money to keep up (docs/deploy.md). The demo needs neither.

## What a visitor can do

- Watch the example town play on the World page, which the site opens on. Each lens colours the houses by
  one measure, such as how hard a couple holds a grudge. The grid view shows the two arms, the half of the
  couples who forget a fight in two weeks and the half who hold onto it for three months, side by side, and
  the twins view shows every couple under both settings.
- Press Try a shock and pick one of the three shocks. Each card shows the request in plain words, where the
  shock came from, the shock as it ran and which houses it hits. Picking one switches the page to that world
  in place, as a finished run does in the live app. The town replays from ten days before the shock, every
  house that differs from the example is ringed, and the counter above the town says how many differ.
- Open any couple from the town or the Couples table, any agent, and the Overview, Comparisons, Policy and
  Governance pages of every world, the shocked ones included.

Nothing can be typed or run. The New experiment page is a one-line note, and a short banner on every page
says what LoveWorld is, that the site is a read-only demo, and links to the README's quickstart for running
your own. Every text on the site is at least 16px, so it still reads at 75% zoom. On a phone the town shows
one district at a time, and a shock that reaches only the treatment arm opens on that district, where its
rings are.

## What is frozen

Each file in `experiments/demo/` freezes one shock with its title, the request in plain words, the world it
forks (the example), the shock specs exactly as the app validates and runs them, which houses it hits, and,
for a shock a model translated, the saved translation record. `typed` is true only for words someone typed.
A test checks them against the record's fingerprint, a SHA-256 of the text lowercased with its spacing
collapsed (the record never keeps the text). The fingerprint cannot tell case or spacing, so the mother
card's words are copied as the README's recording shows them typed, and the layoff card's words were typed
in lowercase, as its card shows them.

| World | Shock | Where it came from |
|---|---|---|
| `demo-mother-moves-in` | "his mother moves in for two months starting in month four", run as stress up 0.5 a day and mood down 0.03 a day for both partners, days 90 to 150, treatment arm | Typed into the World page's shock box, as the README's recording shows, and translated by claude-haiku-5-5 on 12 October 2026. The recording now in the README typed the same words again on 14 October, and that translation lowered mood by 0.05 a day |
| `demo-layoff` | "one partner is laid off on day 60 and stays out of work for three months", run as one partner losing their job, days 60 to 150, magnitude 1.5, treatment arm | Typed into the live app's shock box and translated by claude-haiku-5-5 on 13 October 2026, into the same shock as the first translation on 11 October, whose record had kept only a hash of the words |
| `demo-date-nights` | Weekly date nights from day 30 to the end of the year, for every couple in both arms | Built from the catalog's date nights kind by hand, with no model |

The worlds themselves are not committed. `loveworld demo` runs each file through the fork endpoint's own
code (`forking.plan_fork`, then `forking.run_fork`, which runs the world and its twins, the same couples
under both memory settings), with the saved record standing in for the translator, so each demo world is
exactly what the live app makes from the same request. The model is never called. The live app answers a
card's words from that card's record too, so typing them into its shock box brings back the card's shock with
no model call, even in a fresh clone whose `results/` holds no saved translations.

The engine reproduces a world bit for bit on every platform. Every exp, log, power and cosine it computes
comes from libm, a maths library written in plain Rust and built into the engine, instead of from the
operating system's own maths library, which rounds some results differently in the last bit on Linux and
macOS. So the worlds CI builds on Linux are the same bytes as a build on a Mac, apart from the time each
manifest records (`generated_at_unix`), with the same table hashes and the same determinism hash on each
Overview. Built on macOS, linux/arm64 and linux/amd64 (under emulation), the example and the three shocked
worlds came out identical, and CI replays the committed example on Linux before it regenerates anything. The
README's recordings were made again with this engine on 14 October 2026.

## How it is built

`loveworld static` asks the app itself, `create_app` on a results root that holds only the example and the
demo worlds, for every response the read-only pages read, and writes each one gzipped under `site/data`. It
asks inside its own process through `loveworld.asgi_reader`, which talks to the app the way the uvicorn
server does. It runs the app's startup and shutdown around the reads, hands it each request, and keeps each
reply's bytes exactly as the app sent them. It needs nothing beyond the app's own packages, so an install
without the dev tools (`uv sync --no-dev`) exports the site. In static mode (`VITE_STATIC=1`) the dashboard's `api.ts` reads
those files instead of `/api`. It inflates each with the browser's DecompressionStream, does
`/api/couples`'s filters, stable sort and paging with the server's rules, finds a day's events in its file
of ten days, and refuses every write with a plain message. The router runs under the site's path.

Each page of the dashboard has its own copy of `index.html` (`world.html`, `overview.html` and so on), and
so does every couple and every agent of the published worlds (`couples/12.html`, `agents/25.html` and so
on). GitHub Pages serves that copy for a link to the page, couple or agent with status 200, so a link to
couple 12 can be shared like any other page. `404.html`, one more copy, brings any other link into the app,
such as one to a couple no world has, with the status 404 GitHub Pages gives a path it has no file for. A
test reads every exported file back and requires it to be the API's response byte for byte, and another
compares the in-process reader with fastapi's TestClient on every kind of read.

Nothing the pages read is left out. The export skips only two API reads that no page makes, the twins
detail of one couple and a range of days of events. The site is about 355 MB in about 15,900 files: 350 MB
of gzipped data, about 88 MB for each world, 2 MB of dashboard and 3 MB of page copies, one for each of the
2,000 agents and the 1,100 or so couples. The exporter says when it passes 400 MB and fails over 900 MB,
since GitHub Pages refuses a site over 1 GB, so a fourth shock fits only if something else gives way.

## How CI rebuilds it

`.github/workflows/pages.yml` runs by hand (workflow_dispatch) and on every push to main except one that
changes only files the build never reads: the README, `docs/`, the README's recordings in `assets/`, the
licence files, the files that deploy the full app (`fly.toml`, `deploy/`, the `Dockerfile` and
`.dockerignore`) and the test workflow. Such a push leaves the site as it is, and any other push rebuilds it.
A run builds the engine, runs the placebo, the twins, the example and the demo shocks, exports the data,
builds the dashboard in static mode under the path GitHub Pages reports for the repository, and publishes the
folder with `actions/upload-pages-artifact` and `actions/deploy-pages`. It keeps the Rust build, the Python
packages and the npm packages in GitHub's cache between runs, and it installs the Python package without the
dev tools, so every run also proves the export needs none. It needs Pages turned on once, with GitHub Actions
as the source, in the repository's settings. It holds no secret and calls no model.

## Building it on your machine

```bash
make engine placebo twins example demo   # the example town and its pre-run shocks, into results/
make static static-frontend              # the data, then the dashboard in static mode, into site/
make serve-static                        # http://127.0.0.1:8790/multi-agent-causal-marriage-simulation/
```

`make static-frontend` needs the data first, since it writes a page per couple and agent that has a file
under `site/data`. `make serve-static` (tools/serve_static.py) serves `site/` the way GitHub Pages does,
under the repository's path. A path without a trailing slash gets its own file, else the `.html` file of
the same name, even beside a folder of that name, so `/couples` serves `couples.html` and `/couples/12`
serves `couples/12.html`. A folder with no `.html` file of its name redirects to its path with a slash,
keeping the query. Any other path it has no file for gets `404.html` with status 404, and `.gz` files go out
as plain bytes. Those rules were measured on GitHub Pages itself on 13 October 2026. To add a shock, write a
file in `experiments/demo/` (copy a record from `results/.translations/` for a translated one), then run
`make demo static static-frontend`, and the tests check every demo file.

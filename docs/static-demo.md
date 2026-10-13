# The free read-only demo

The dashboard needs a server to run a world and a model to read a typed shock, and both cost money to keep
up (docs/deploy.md). The free demo needs neither. It is a static copy of the dashboard on GitHub Pages, at
https://jameswniu.github.io/multi-agent-causal-marriage-simulation/ once Pages is turned on for the
repository, holding the example town and three shocks that were run in advance.

## What a visitor can do

- Watch the example town play on the World page, which the site opens on, with every lens, the grid view
  and the same couples under both arms.
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
card's words are copied as the README's recording shows them typed.

| World | Shock | Where it came from |
|---|---|---|
| `demo-mother-moves-in` | "his mother moves in for two months starting in month four", run as stress up 0.5 a day and mood down 0.03 a day for both partners, days 90 to 150, treatment arm | Typed into the World page's shock box, as the README's recording shows, and translated by claude-haiku-5-5 on 12 October 2026. It is the request behind the recording's world |
| `demo-layoff` | One partner loses their job, days 60 to 150, magnitude 1.5, treatment arm | Translated by claude-haiku-5-5 on 11 October 2026. The record kept only a hash of the words, so the card's sentence was written for the demo |
| `demo-date-nights` | Weekly date nights from day 30 to the end of the year, for every couple in both arms | Built from the catalog's date nights kind by hand, with no model |

The worlds themselves are not committed. `loveworld demo` runs each file through the fork endpoint's own
code (`forking.plan_fork`, then `forking.run_fork`, which runs the world and its twins), with the saved
record standing in for the translator, so each demo world is exactly what the live app makes from the same
request. The model is never called.

On one platform the engine reproduces a world bit for bit. Across platforms it does not quite, since the
maths library behind exp, ln, powf and cos rounds some floats differently on Linux and macOS. CI builds the
published worlds on Linux, so their table hashes, and the determinism hash on each Overview, differ from a
macOS build such as the README's recording (ad3efd35 for the mother world). What a visitor sees does not
differ. Replayed on Linux, all four worlds matched their macOS builds in every column that is not a float,
and no float moved by more than 4e-15. Every couple's state on every day, every divorce and every day's ring
count came out the same.

## How it is built

`loveworld static` asks the app itself, through fastapi's TestClient over `create_app` on a results root
that holds only the example and the demo worlds, for every response the read-only pages read, and writes
each one gzipped under `site/data`. In static mode (`VITE_STATIC=1`) the dashboard's `api.ts` reads those
files instead of `/api`. It inflates each with the browser's DecompressionStream, does `/api/couples`'s
filters, stable sort and paging with the server's rules, finds a day's events in its file of ten days, and
refuses every write with a plain message. The router runs under the site's path. Each page of the dashboard
has its own copy of `index.html` (`world.html`, `overview.html` and so on), which GitHub Pages serves for a
link to that page with status 200, and `404.html`, one more copy, brings a link to one couple or agent into
the app, with the status 404 GitHub Pages gives a path it has no file for. A test reads every exported file
back and requires it to be the API's response byte for byte.

Nothing the pages read is left out. The export skips only two API reads that no page makes, the twins
detail of one couple and a range of days of events. The site is about 350 MB of gzipped data, about 88 MB
for each world, plus 2 MB of dashboard. The exporter says when it passes 400 MB and fails over 900 MB,
since GitHub Pages refuses a site over 1 GB, so a fourth shock fits only if something else gives way.

## How CI rebuilds it

`.github/workflows/pages.yml` runs on every push to main and by hand (workflow_dispatch). It builds the
engine, runs the placebo, the twins, the example and the demo shocks, exports the data, builds the
dashboard in static mode under the path GitHub Pages reports for the repository, and publishes the folder
with `actions/upload-pages-artifact` and `actions/deploy-pages`. It needs Pages turned on once, with
GitHub Actions as the source, in the repository's settings. It holds no secret and calls no model.

## Building it on your machine

```bash
make engine placebo twins example demo   # the example town and its pre-run shocks, into results/
make static static-frontend              # the data, then the dashboard in static mode, into site/
make serve-static                        # http://127.0.0.1:8790/multi-agent-causal-marriage-simulation/
```

`make serve-static` (tools/serve_static.py) serves `site/` the way GitHub Pages does, under the
repository's path, with a page's `.html` file for a path without a trailing slash that has no file of its
own, `404.html` and status 404 for any other path it has no file for, and `.gz` files as plain bytes. To
add a shock, write a file in `experiments/demo/` (copy a record from `results/.translations/` for a
translated one), then run `make demo static static-frontend`, and the tests check every demo file.

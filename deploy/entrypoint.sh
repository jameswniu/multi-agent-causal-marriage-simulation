#!/bin/sh
# Start the public LoveWorld dashboard. The curated worlds baked into the image replace their copies on
# the results volume at every boot, so they always match this image's engine; visitors' runs on the
# volume are left alone (the server sweeps them after a day).
set -eu
# Public mode trusts POSTs only when they carry the edge secret the Cloudflare Worker adds. Without the
# secret the app would take POSTs from anyone who finds the machine's own address, skipping the bot check,
# so the image refuses to start instead. LOVEWORLD_NO_EDGE=1 is for trying the image on your own machine.
if [ "${LOVEWORLD_PUBLIC:-0}" = "1" ] && [ -z "${LOVEWORLD_EDGE_SECRET:-}" ] && [ "${LOVEWORLD_NO_EDGE:-0}" != "1" ]; then
  echo "LoveWorld will not start in public mode without LOVEWORLD_EDGE_SECRET, the secret the Cloudflare" >&2
  echo "Worker sends with every POST (docs/deploy.md, step 3). To try the image locally without the Worker," >&2
  echo "run it with LOVEWORLD_NO_EDGE=1." >&2
  exit 64
fi
RESULTS="${LOVEWORLD_RESULTS:-/data/results}"
mkdir -p "$RESULTS"
for seed in /app/seed/*; do
  name=$(basename "$seed")
  staged="$RESULTS/.$name.boot"
  previous="$RESULTS/.$name.previous"
  rm -rf "$staged" "$previous"
  cp -R "$seed" "$staged"
  # The old copy steps aside rather than being deleted, and comes back if the new one cannot be put in place.
  if [ -e "$RESULTS/$name" ]; then mv "$RESULTS/$name" "$previous"; fi
  if ! mv "$staged" "$RESULTS/$name"; then
    if [ -e "$previous" ]; then mv "$previous" "$RESULTS/$name"; fi
    echo "Could not install the curated world $name on the results volume; kept its previous copy." >&2
    exit 1
  fi
  rm -rf "$previous"
done
exec /app/python/.venv/bin/loveworld serve "$RESULTS" --host 0.0.0.0 --port "${PORT:-8080}"

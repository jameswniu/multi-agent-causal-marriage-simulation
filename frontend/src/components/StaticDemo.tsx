// The read-only demo's notes: a slim banner on every page, and the one line that stands in for the New
// experiment page. Both appear only in the static build (staticMode.ts).
import { ExpLink } from '../nav';
import { QUICKSTART_URL } from '../staticMode';

export const STATIC_BANNER_TEXT =
  'LoveWorld runs 1,000 agent couples for one year as a randomized trial of one setting, how long each partner remembers a fight. This read-only demo replays that run and a few shocks run in advance on it, so nothing runs here.';

/** A few lines on every page saying what LoveWorld is and what this site is, with the way to type your own shock. */
export function StaticBanner() {
  return (
    <p className="static-banner" role="note" data-testid="static-banner">
      {STATIC_BANNER_TEXT} To type your own shock, follow the <a href={QUICKSTART_URL}>README quickstart</a>.
    </p>
  );
}

/** In place of the New experiment page, which needs the simulator and its server. */
export function StaticNewNote() {
  return (
    <p className="static-note" data-testid="static-new-note">
      New experiments need the simulator, which this read-only demo leaves out: <ExpLink to="/world">Try a shock</ExpLink> on the World page shows the shocks run in advance, and the{' '}
      <a href={QUICKSTART_URL}>README quickstart</a> runs your own.
    </p>
  );
}

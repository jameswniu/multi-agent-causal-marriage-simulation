import { charStyle } from './WorldGrid';
import { RING_WORDS } from '../worldDiff';

const ORDER = ['M', 'C', 'S', 'D', 'T', 'B', '-'];

/** The grid's key: a swatch per state letter, and the ring when the grid rings couples that differ from another world. */
export default function TileLegend({ legend, ringed = false }: { legend: Record<string, string>; ringed?: boolean }) {
  const keys = [...ORDER.filter((k) => k in legend), ...Object.keys(legend).filter((k) => !ORDER.includes(k))];
  return (
    <div className="tile-legend" aria-label="Tile legend">
      {ringed ? (
        <span data-testid="ring-key">
          <span className="diff-ring-key" aria-hidden="true" />
          {RING_WORDS}
        </span>
      ) : null}
      {keys.map((ch) => {
        const st = charStyle(ch);
        return (
          <span key={ch}>
            <span className="tile-swatch" style={{ background: st.empty ? 'transparent' : st.fill, border: st.empty ? '1px solid var(--grid)' : 'none' }} aria-hidden="true">
              {st.inner ? <span className="inner" /> : null}
              {st.slash ? <span className="slash" /> : null}
            </span>
            {legend[ch]}
          </span>
        );
      })}
    </div>
  );
}

import { charStyle } from './WorldGrid';

const ORDER = ['M', 'C', 'S', 'D', 'T', 'B', '-'];

export default function TileLegend({ legend }: { legend: Record<string, string> }) {
  const keys = [...ORDER.filter((k) => k in legend), ...Object.keys(legend).filter((k) => !ORDER.includes(k))];
  return (
    <div className="tile-legend" aria-label="Tile legend">
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

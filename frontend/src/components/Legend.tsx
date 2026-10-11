interface Item {
  label: string;
  color: string;
  kind?: 'line' | 'rect';
}

export default function Legend({ items }: { items: Item[] }) {
  return (
    <div className="legend" aria-label="Legend">
      {items.map((it) => (
        <span key={it.label}>
          {it.kind === 'line' ? (
            <span className="linekey" style={{ color: it.color }} aria-hidden="true" />
          ) : (
            <span className="swatch" style={{ background: it.color }} aria-hidden="true" />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

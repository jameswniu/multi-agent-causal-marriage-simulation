import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  height?: number;
  children: (width: number, height: number) => ReactNode;
  table?: ReactNode;
}

/** Measures its own width (falls back to 640 where ResizeObserver is missing, e.g. tests). */
export default function ChartFrame({ title, subtitle, height = 260, children, table }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="card chart">
      <p className="chart-title">{title}</p>
      {subtitle ? <p className="chart-sub">{subtitle}</p> : null}
      <div ref={ref} style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
        {children(width, height)}
      </div>
      {table ? (
        <details className="tableview">
          <summary>Table view</summary>
          <div className="table-wrap">{table}</div>
        </details>
      ) : null}
    </div>
  );
}

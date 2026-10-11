interface Props {
  label: string;
  value: string;
  sub?: string;
  /** A sentence rather than a figure: rendered at text size and allowed to span two columns. */
  text?: boolean;
}

export default function StatTile({ label, value, sub, text }: Props) {
  return (
    <div className={`tile${text ? ' tile-text' : ''}`}>
      <div className="label">{label}</div>
      <div className={`value${text ? ' value-text' : ''}`}>{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

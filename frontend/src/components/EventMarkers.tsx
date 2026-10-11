import type { EventRow } from '../types';
import { eventLabel } from './TrustLines';

/** Plain-words event list with hover text, used beside charts and on the World ticker. */
export default function EventMarkers({ events, limit, withCouple = false }: { events: EventRow[]; limit?: number; withCouple?: boolean }) {
  const rows = limit ? events.slice(0, limit) : events;
  if (rows.length === 0) return <p className="muted">No events.</p>;
  return (
    <ul aria-label="Events" style={{ margin: 0, paddingLeft: '1.2rem' }}>
      {rows.map((e, i) => (
        <li key={`${e.day}-${e.seq}-${i}`} title={`couple ${e.couple_id}, seq ${e.seq}`}>
          {eventLabel(e, withCouple)}
          {e.from_state && e.to_state ? <span className="muted">{` ${e.from_state} to ${e.to_state}`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

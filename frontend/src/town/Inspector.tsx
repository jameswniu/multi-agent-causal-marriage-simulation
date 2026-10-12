// The couple panel of the LoveWorld World page. Clicking a house opens it beside the town instead of
// leaving the page: the couple's state on the replay's day, both partners' trust and affect over the
// run with a marker on today, their memory loads, any record a partner sealed when an earlier
// marriage ended, the latest events, and a link to the full couple page. Escape closes it.
import { useEffect, useRef } from 'react';
import { ExpLink } from '../nav';
import EventMarkers from '../components/EventMarkers';
import { memberColor } from '../palette';
import type { CoupleDetailResponse, DailyRow, LegacyRow } from '../types';
import { HOUSEKEEPING, dayLabel } from './timebar';

interface Props {
  coupleId: number;
  detail: CoupleDetailResponse | null;
  error: string | null;
  day: number;
  armWords: string | null;
  onClose: () => void;
  onRetry: () => void;
}

const STATE_WORDS: Record<string, string> = {
  married: 'married and at home',
  separated: 'separated, one partner has moved out',
  divorced: 'divorced',
  dating: 'dating',
  broken_up: 'broken up',
};

/** The couple's state on `day` in plain words, from its daily rows and its couple row. */
export function stateOnDay(detail: CoupleDetailResponse, day: number): string {
  const row = detail.daily.find((r) => r.day === day);
  if (row) {
    if (row.state === 'married' && row.in_conflict) {
      // The engine counts a conflict's first day as day 1.
      const n = Math.max(1, row.conflict_days);
      return `married, in a conflict on its ${n}${ordinal(n)} day`;
    }
    return STATE_WORDS[row.state] ?? row.state;
  }
  const c = detail.couple;
  if (day < c.formed_day) return `not formed yet, they meet on day ${c.formed_day}`;
  if (c.ended_day != null && day > c.ended_day) return `${STATE_WORDS[c.final_state] ?? c.final_state} since day ${c.ended_day}`;
  return 'no record that day';
}

function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

/** Points for one series on a viewBox of `days` by 40, oldest day first. */
export function sparkPoints(rows: DailyRow[], pick: (r: DailyRow) => number, lo: number, hi: number): string {
  const span = hi - lo || 1;
  return rows
    .map((r) => {
      const v = Math.min(hi, Math.max(lo, pick(r)));
      return `${r.day},${(40 - ((v - lo) / span) * 38 - 1).toFixed(2)}`;
    })
    .join(' ');
}

function Spark({ title, rows, days, day, a, b, lo, hi }: { title: string; rows: DailyRow[]; days: number; day: number; a: (r: DailyRow) => number; b: (r: DailyRow) => number; lo: number; hi: number }) {
  const today = rows.find((r) => r.day === day);
  return (
    <figure className="spark">
      <figcaption>
        {title}
        {today ? <span className="muted">{` today ${a(today).toFixed(2)} and ${b(today).toFixed(2)}`}</span> : null}
      </figcaption>
      <svg viewBox={`0 0 ${Math.max(1, days)} 40`} preserveAspectRatio="none" role="img" aria-label={`${title} of both partners over the run, with a marker on day ${day}`}>
        <polyline points={sparkPoints(rows, a, lo, hi)} fill="none" stroke={memberColor('a')} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <polyline points={sparkPoints(rows, b, lo, hi)} fill="none" stroke={memberColor('b')} strokeWidth={2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <line x1={day} x2={day} y1={0} y2={40} stroke="var(--ink)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

function Load({ label, a, b }: { label: string; a: number; b: number }) {
  const w = (v: number) => `${Math.min(100, Math.max(0, (v / 1.5) * 100)).toFixed(0)}%`;
  return (
    <div className="load">
      <span>{label}</span>
      <span className="load-bar" title={`Partner A ${a.toFixed(2)}`}>
        <span style={{ width: w(a), background: memberColor('a') }} />
      </span>
      <span className="load-bar" title={`Partner B ${b.toFixed(2)}`}>
        <span style={{ width: w(b), background: memberColor('b') }} />
      </span>
      <span className="muted">{`${a.toFixed(2)} and ${b.toFixed(2)}`}</span>
    </div>
  );
}

/** One sealed record in plain words. */
export function legacyWords(l: LegacyRow): string {
  const who = l.ended_by === 'self' ? 'they left' : l.ended_by === 'partner' ? 'their partner left' : 'it ran out';
  return `Agent ${l.agent_id} sealed a record of couple ${l.couple_id} on day ${l.day}, when ${who}: ${l.conflicts} conflicts, ${l.reconciled} reconciled, final trust ${l.final_trust.toFixed(2)}. Leaving comes easier by ${l.commitment_shift.toFixed(2)} and a new marriage starts at trust ${l.trust_prior.toFixed(2)}.`;
}

export default function Inspector({ coupleId, detail, error, day, armWords, onClose, onRetry }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [coupleId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = detail ? [...detail.daily].sort((p, q) => p.day - q.day) : [];
  const days = rows.length ? rows[rows.length - 1].day + 1 : 1;
  const today = rows.find((r) => r.day === day) ?? null;
  const recent = detail ? detail.events.filter((e) => e.day <= day && !HOUSEKEEPING.has(e.kind)).sort((p, q) => q.day - p.day || q.seq - p.seq).slice(0, 5) : [];
  // Records sealed up to the replay's day: the partners' earlier marriages, then this one's own.
  const legacies = detail ? [...(detail.partner_legacies ?? []), ...(detail.legacies ?? [])].filter((l) => l.day <= day) : [];
  const agents = detail ? `Agents ${detail.couple.agent_a} and ${detail.couple.agent_b}` : '';

  return (
    <aside className="card inspector" role="dialog" aria-modal="false" aria-labelledby="inspector-title" data-testid="inspector">
      <div className="inspector-head">
        <h3 id="inspector-title">Couple {coupleId}</h3>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close the couple panel">
          Close
        </button>
      </div>
      {armWords ? <p className="muted">{armWords}</p> : null}
      {error ? (
        <div className="status error" role="alert">
          Could not load couple {coupleId}: {error}
          <div>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      ) : !detail ? (
        <p className="muted">Loading the couple...</p>
      ) : (
        <>
          <p data-testid="inspector-state">
            <strong>{dayLabel(day)}:</strong> {stateOnDay(detail, day)}.
          </p>
          <p className="muted">
            {agents}. Partner A is the solid line, partner B the dashed one.
          </p>
          <Spark title="Trust (0 to 1)" rows={rows} days={days} day={day} a={(r) => r.trust_a} b={(r) => r.trust_b} lo={0} hi={1} />
          <Spark title="Mood (affect, -1 to 1)" rows={rows} days={days} day={day} a={(r) => r.affect_a} b={(r) => r.affect_b} lo={-1} hi={1} />
          {today ? (
            <div className="loads" data-testid="inspector-loads">
              <h4>Memory today</h4>
              <Load label="Grudge" a={today.neg_a} b={today.neg_b} />
              <Load label="Warmth" a={today.pos_a} b={today.pos_b} />
            </div>
          ) : null}
          {legacies.length ? (
            <div data-testid="inspector-legacies">
              <h4>Sealed records</h4>
              <ul className="legacies">
                {legacies.map((l) => (
                  <li key={`${l.couple_id}-${l.agent_id}`}>{legacyWords(l)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <h4>Latest events</h4>
          <EventMarkers events={recent} />
          <p>
            <ExpLink to={`/couples/${coupleId}`} data-testid="inspector-open">
              Open the full couple page
            </ExpLink>
          </p>
        </>
      )}
    </aside>
  );
}

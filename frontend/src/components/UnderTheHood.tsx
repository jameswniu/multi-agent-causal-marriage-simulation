import { useMemo, useState } from 'react';
import type { DecisionRow, EpisodeRow, EventRow, LegacyRow } from '../types';
import { getPolicy } from '../api';
import { useAsync } from '../useAsync';
import { safeFixed } from '../format';

/** One member's daily numbers, as the couple or agent page already has them. */
export interface MemberDay {
  day: number;
  trust: number;
  affect: number;
  stress: number;
  neg: number;
  pos: number;
  /** Consecutive days the couple has gone without a warm memory on both sides. */
  orphanDays?: number;
}

export interface HoodMember {
  id: number;
  label: string;
  days: MemberDay[];
}

interface Props {
  members: HoodMember[];
  decisions: DecisionRow[];
  episodes?: EpisodeRow[];
  events: EventRow[];
  legacies?: LegacyRow[];
}

const ACTIONS: [keyof DecisionRow, string][] = [
  ['u_repair', 'repair'],
  ['u_hold', 'hold'],
  ['u_escalate', 'escalate'],
  ['u_withdraw', 'withdraw'],
  ['u_leave', 'leave'],
];

/** Softmax over the logged utilities at the policy temperature; the chosen action's p matches the log. */
export function probabilities(d: DecisionRow, temperature: number): [string, number][] {
  const avail = ACTIONS.filter(([k]) => d[k] !== null && d[k] !== undefined).map(([k, name]) => [name, Number(d[k])] as [string, number]);
  if (avail.length === 0) return [];
  const t = Math.max(temperature, 1e-6);
  const max = Math.max(...avail.map(([, u]) => u));
  const w = avail.map(([name, u]) => [name, Math.exp((u - max) / t)] as [string, number]);
  const sum = w.reduce((a, [, x]) => a + x, 0);
  return w.map(([name, x]) => [name, x / sum]);
}

/** Every day any member, episode, decision or shock event touches, sorted (history episodes carry negative days). */
export function unionOfDays(members: HoodMember[], episodes: EpisodeRow[] | undefined, decisions: DecisionRow[], events: EventRow[]): number[] {
  const s = new Set<number>();
  members.forEach((m) => m.days.forEach((d) => s.add(d.day)));
  (episodes ?? []).forEach((e) => s.add(e.day));
  decisions.forEach((d) => s.add(d.day));
  events.filter((e) => e.kind.startsWith('shock_')).forEach((e) => s.add(e.day));
  return [...s].sort((a, b) => a - b);
}

/** For each member and logged day, that member's previous logged record (not day minus one). */
export function previousRecords(members: HoodMember[]): Map<number, Map<number, MemberDay>> {
  const out = new Map<number, Map<number, MemberDay>>();
  members.forEach((m) => {
    const sorted = [...m.days].sort((a, b) => a.day - b.day);
    const inner = new Map<number, MemberDay>();
    for (let i = 1; i < sorted.length; i++) inner.set(sorted[i].day, sorted[i - 1]);
    out.set(m.id, inner);
  });
  return out;
}

const ENDED_BY: Record<LegacyRow['ended_by'], string> = {
  self: 'this agent left',
  partner: 'the partner left',
  time: 'the separation ran out',
};

/** One plain sentence for a sealed marriage, as the developer log shows it. */
export function legacySentence(row: LegacyRow): string {
  const shift = row.commitment_shift > 0 ? `, and leaving is ${row.commitment_shift.toFixed(2)} easier in later relationships` : '';
  return (
    `Day ${row.day}: agent ${row.agent_id} sealed the marriage with agent ${row.partner_id} after ${row.conflicts} ` +
    `${row.conflicts === 1 ? 'conflict' : 'conflicts'}, ${row.reconciled} reconciled, ${ENDED_BY[row.ended_by] ?? row.ended_by}. ` +
    `Final trust ${row.final_trust.toFixed(2)}. The next relationship starts at trust ${row.trust_prior.toFixed(2)}${shift}.`
  );
}

/** The couple-level note for a day: how long the couple has gone without a shared warm memory. */
export function orphanNote(orphanDays: number | undefined, unlockAfter: number | null): string | null {
  if (!orphanDays || orphanDays <= 0) return null;
  const unit = orphanDays === 1 ? 'day' : 'days';
  const lock = unlockAfter === null ? '' : orphanDays >= unlockAfter ? ', leaving is now possible' : `, leaving opens after ${unlockAfter}`;
  return `No warm memory on both sides for ${orphanDays} ${unit}${lock}.`;
}

function delta(cur: number, prev: number | undefined): string {
  if (prev === undefined || cur === null || prev === null || Number.isNaN(cur - prev)) return '';
  const d = cur - prev;
  return ` (${d >= 0 ? '+' : ''}${d.toFixed(3)})`;
}

function Body({ members, decisions, episodes, events, legacies }: Props) {
  const policy = useAsync(() => getPolicy().catch(() => null), []);
  const temperature = policy.data?.sampling.temperature ?? 0.6;
  const unlockAfter = policy.data?.leave_rule?.orphan_days_to_leave ?? null;
  const allDays = useMemo(() => unionOfDays(members, episodes, decisions, events), [members, episodes, decisions, events]);
  const first = allDays[0] ?? 0;
  const last = allDays[allDays.length - 1] ?? 0;
  const [from, setFrom] = useState(Math.max(first, 0));
  const [to, setTo] = useState(Math.min(last, Math.max(first, 0) + 30));
  const [member, setMember] = useState<'all' | number>('all');

  const byDay = useMemo(() => {
    const out = new Map<number, Map<number, MemberDay>>();
    members.forEach((mm) => {
      const inner = new Map<number, MemberDay>();
      mm.days.forEach((d) => inner.set(d.day, d));
      out.set(mm.id, inner);
    });
    return out;
  }, [members]);
  const prevByDay = useMemo(() => previousRecords(members), [members]);
  const epByDay = useMemo(() => {
    const out = new Map<string, EpisodeRow[]>();
    (episodes ?? []).forEach((e) => {
      const k = `${e.day}:${e.agent_id}`;
      out.set(k, [...(out.get(k) ?? []), e]);
    });
    return out;
  }, [episodes]);
  const decByDay = useMemo(() => {
    const out = new Map<string, DecisionRow[]>();
    decisions.forEach((d) => {
      const k = `${d.day}:${d.agent_id}`;
      out.set(k, [...(out.get(k) ?? []), d]);
    });
    return out;
  }, [decisions]);
  const shocksByDay = useMemo(() => {
    const out = new Map<number, EventRow[]>();
    events.filter((e) => e.kind.startsWith('shock_')).forEach((e) => out.set(e.day, [...(out.get(e.day) ?? []), e]));
    return out;
  }, [events]);
  const shocksFor = (day: number): EventRow[] => (shocksByDay.get(day) ?? []).filter((e) => member === 'all' || e.agent_id === null || e.agent_id === member);

  const shown = allDays.filter((d) => d >= from && d <= to);
  const shownMembers = members.filter((m) => member === 'all' || m.id === member);

  return (
    <div className="hood">
      <div className="filters" role="group" aria-label="Developer log filters">
        <label>
          From day
          <input type="number" min={first} max={last} value={from} onChange={(e) => setFrom(Number(e.target.value))} aria-label="From day" />
        </label>
        <label>
          To day
          <input type="number" min={first} max={last} value={to} onChange={(e) => setTo(Number(e.target.value))} aria-label="To day" />
        </label>
        <label>
          Member
          <select value={member === 'all' ? 'all' : String(member)} onChange={(e) => setMember(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Member">
            <option value="all">All</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {shown.length} of {allDays.length} days. {episodes ? `${episodes.length} episodes logged.` : 'No episodes table in this run.'}
        </span>
      </div>
      {legacies && legacies.length > 0 ? (
        <div data-testid="hood-legacies">
          <div className="dayhead">Sealed marriages</div>
          {legacies.map((row, i) => (
            <div key={i}>{legacySentence(row)}</div>
          ))}
        </div>
      ) : null}
      {shown.map((day) => (
        <div key={day} data-testid="hood-day">
          <div className="dayhead">Day {day}</div>
          {(() => {
            const note = orphanNote(members[0] ? byDay.get(members[0].id)?.get(day)?.orphanDays : undefined, unlockAfter);
            return note ? <div className="muted">{note}</div> : null;
          })()}
          {shocksFor(day).map((s, i) => (
            <div key={i} className="muted">
              Shock: {s.kind.replace('shock_', '').replace(/_/g, ' ')}
              {s.agent_id !== null ? ` on agent ${s.agent_id}` : ''}
              {s.value !== null ? `, magnitude ${Number(s.value).toFixed(2)}` : ''}
            </div>
          ))}
          <div className="table-wrap">
            <table className="data" aria-label={`Day ${day}`}>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Episodes stored</th>
                  <th className="num">Neg load</th>
                  <th className="num">Pos load</th>
                  <th className="num">Trust</th>
                  <th className="num">Affect</th>
                  <th className="num">Stress</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {shownMembers.map((m) => {
                  const cur = byDay.get(m.id)?.get(day);
                  const prev = prevByDay.get(m.id)?.get(day);
                  const eps = epByDay.get(`${day}:${m.id}`) ?? [];
                  const decs = decByDay.get(`${day}:${m.id}`) ?? [];
                  return (
                    <tr key={m.id}>
                      <td>{m.label}</td>
                      <td>
                        {eps.length === 0
                          ? <span className="muted">none</span>
                          : eps.map((e, i) => (
                              <div key={i}>
                                {e.kind} {safeFixed(e.intensity, 2)}
                                {e.amplified ? <span className="tag">raised</span> : null}
                                <span className="muted"> {e.source}</span>
                              </div>
                            ))}
                      </td>
                      <td className="num">{cur ? safeFixed(cur.neg, 3) : ''}</td>
                      <td className="num">{cur ? safeFixed(cur.pos, 3) : ''}</td>
                      <td className="num">
                        {cur ? safeFixed(cur.trust, 3) : ''}
                        <span className="delta">{cur ? delta(cur.trust, prev?.trust) : ''}</span>
                      </td>
                      <td className="num">
                        {cur ? safeFixed(cur.affect, 3) : ''}
                        <span className="delta">{cur ? delta(cur.affect, prev?.affect) : ''}</span>
                      </td>
                      <td className="num">{cur ? safeFixed(cur.stress, 3) : ''}</td>
                      <td>
                        {decs.length === 0
                          ? <span className="muted">none</span>
                          : decs.map((d, i) => (
                              <div key={i}>
                                <strong>{d.action}</strong> in {d.context}
                                <span className="muted">
                                  {' '}
                                  {probabilities(d, temperature)
                                    .map(([name, p]) => `${name} ${(p * 100).toFixed(0)}%`)
                                    .join(', ')}
                                </span>
                              </div>
                            ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Collapsed by default; nothing inside renders until opened. */
export default function UnderTheHood(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details className="card" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="under-the-hood">
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Under the hood</summary>
      {open ? <Body {...props} /> : null}
    </details>
  );
}

import type { DecisionRow } from '../types';
import { fmt } from '../format';

export default function DecisionTable({ decisions, limit = 200 }: { decisions: DecisionRow[]; limit?: number }) {
  const rows = decisions.slice(0, limit);
  if (rows.length === 0) return <p className="muted">No conflict or separation decisions for this couple.</p>;
  return (
    <div className="table-wrap">
      <table className="data" aria-label="Decisions">
        <thead>
          <tr>
            <th className="num">Day</th>
            <th className="num">Agent</th>
            <th>Context</th>
            <th>Action</th>
            <th className="num">p</th>
            <th className="num">Repair</th>
            <th className="num">Hold</th>
            <th className="num">Escalate</th>
            <th className="num">Withdraw</th>
            <th className="num">Leave</th>
            <th className="num">Trust</th>
            <th className="num">Grudge</th>
            <th>Partner last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={i}>
              <td className="num">{d.day}</td>
              <td className="num">{d.agent_id}</td>
              <td>{d.context}</td>
              <td>{d.action}</td>
              <td className="num">{fmt(d.p_chosen, 2)}</td>
              <td className="num">{fmt(d.u_repair, 2)}</td>
              <td className="num">{fmt(d.u_hold, 2)}</td>
              <td className="num">{fmt(d.u_escalate, 2)}</td>
              <td className="num">{fmt(d.u_withdraw, 2)}</td>
              <td className="num">{fmt(d.u_leave, 2)}</td>
              <td className="num">{fmt(d.trust, 2)}</td>
              <td className="num">{fmt(d.neg_load, 2)}</td>
              <td>{d.partner_last ?? 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {decisions.length > limit ? <p className="muted">Showing the first {limit} of {decisions.length} decisions.</p> : null}
    </div>
  );
}

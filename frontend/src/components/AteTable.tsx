import type { Outcome } from '../types';
import { fmtCiValue, fmtP, fmtSignedValue, fmtValue } from '../format';
import { useArmLabels } from '../arms';

export default function AteTable({ outcomes }: { outcomes: Outcome[] }) {
  const labels = useArmLabels();
  const level = outcomes[0]?.ci_level ?? 0.95;
  return (
    <div className="table-wrap">
      <table className="data" aria-label="Average treatment effects">
        <thead>
          <tr>
            <th>Outcome</th>
            <th className="num">
              {labels.control.plain}
              <div className="muted" style={{ fontWeight: 400 }}>{labels.control.small}</div>
            </th>
            <th className="num">
              {labels.treatment.plain}
              <div className="muted" style={{ fontWeight: 400 }}>{labels.treatment.small}</div>
            </th>
            <th className="num">Effect</th>
            <th className="num">{Math.round(level * 100)}% CI</th>
            <th className="num">p</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.name}>
              <td>
                {o.label}
                <div className="muted">{o.unit}</div>
                {o.conditional_on_post_treatment ? <span className="tag" title={o.note || 'Conditional on a post-treatment event'}>Conditional</span> : null}
              </td>
              <td className="num">{fmtValue(o.control_mean, o.unit)}</td>
              <td className="num">{fmtValue(o.treatment_mean, o.unit)}</td>
              <td className="num">{fmtSignedValue(o.ate, o.unit)}</td>
              <td className="num">{fmtCiValue(o.ci_low, o.ci_high, o.unit)}</td>
              <td className="num">{fmtP(o.p_permutation)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


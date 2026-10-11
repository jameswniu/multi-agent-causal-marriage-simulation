import type { ArmCounts } from '../types';
import { useArmLabels } from '../arms';
import { safeFixed } from '../format';

export function oneInN(divorced: number, n: number): string {
  if (n <= 0) return 'n/a';
  if (divorced <= 0) return 'none';
  const k = Math.max(1, Math.round(n / divorced));
  return `1 in ${k.toLocaleString()}`;
}

export function pct(x: number, n: number): string {
  if (n <= 0) return 'n/a';
  return `${((100 * x) / n).toFixed(1)}%`;
}

interface Props {
  control: ArmCounts;
  treatment: ArmCounts;
  nControl: number;
  nTreatment: number;
  trustControl?: number;
  trustTreatment?: number;
  /** Suffix after the plain label, e.g. "run" in twins mode. */
  suffix?: string;
}

/** Three live stat pairs, control beside treatment, in the arm colours. */
export default function Scoreboard({ control, treatment, nControl, nTreatment, trustControl, trustTreatment, suffix }: Props) {
  const labels = useArmLabels();
  const controlName = `${labels.control.plain}${suffix ? ` ${suffix}` : ''} (${labels.control.small})`;
  const treatmentName = `${labels.treatment.plain}${suffix ? ` ${suffix}` : ''} (${labels.treatment.small})`;
  const pair = (label: string, c: string, t: string, cSub: string, tSub: string, testId: string) => (
    <div className="score" data-testid={testId}>
      <div className="label">{label}</div>
      <div className="pair">
        <span className="big control">
          {c}
          <span className="sub">
            {cSub} {controlName}
          </span>
        </span>
        <span className="big treatment">
          {t}
          <span className="sub">
            {tSub} {treatmentName}
          </span>
        </span>
      </div>
    </div>
  );
  return (
    <div className="scoreboard" aria-label="Scoreboard">
      {pair('Divorced', oneInN(control.divorced, nControl), oneInN(treatment.divorced, nTreatment), `${control.divorced} of ${nControl},`, `${treatment.divorced} of ${nTreatment},`, 'score-divorced')}
      {pair('In conflict', String(control.conflict), String(treatment.conflict), `${pct(control.conflict, nControl)} of`, `${pct(treatment.conflict, nTreatment)} of`, 'score-conflict')}
      {trustControl !== undefined && trustTreatment !== undefined
        ? pair('Mean trust', safeFixed(trustControl, 2), safeFixed(trustTreatment, 2), '0 to 1,', '0 to 1,', 'score-trust')
        : null}
    </div>
  );
}

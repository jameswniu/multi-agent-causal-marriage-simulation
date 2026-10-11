import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from 'recharts';
import type { AgentRow } from '../types';
import { armColor, gridColor } from '../palette';
import { safeFixed } from '../format';

export const TRAITS: (keyof AgentRow)[] = ['neuroticism', 'agreeableness', 'conscientiousness', 'openness', 'extraversion', 'forgiveness', 'commitment', 'closeness_pref', 'conflict_engagement'];

/** Short axis labels for narrow radars; the table below carries the full names. */
const SHORT: Record<string, string> = { conscientiousness: 'conscient.', closeness_pref: 'closeness', conflict_engagement: 'engagement', agreeableness: 'agreeable', extraversion: 'extravert', neuroticism: 'neurotic', forgiveness: 'forgiving', commitment: 'committed', openness: 'open' };

export default function TraitRadar({ agent, size }: { agent: AgentRow; size: number }) {
  const narrow = size < 420;
  const data = TRAITS.map((t) => ({ trait: narrow ? SHORT[String(t)] : String(t).replace(/_/g, ' '), full: String(t).replace(/_/g, ' '), value: Number(agent[t]) }));
  const color = armColor(agent.arm);
  return (
    <div>
      <RadarChart width={size} height={size} data={data} outerRadius={size * 0.3} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
        <PolarGrid stroke={gridColor()} />
        <PolarAngleAxis dataKey="trait" tick={{ fontSize: 14 }} />
        <PolarRadiusAxis domain={[0, 1]} tick={{ fontSize: 14 }} />
        <Radar dataKey="value" stroke={color} strokeWidth={2} fill={color} fillOpacity={0.12} isAnimationActive={false} />
      </RadarChart>
      <div className="table-wrap">
        <table className="data" aria-label="Traits">
          <tbody>
            {data.map((d) => (
              <tr key={d.full}>
                <td>{d.full}</td>
                <td className="num">{safeFixed(d.value, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

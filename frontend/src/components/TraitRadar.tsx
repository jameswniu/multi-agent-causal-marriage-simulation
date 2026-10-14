// Radar chart of one simulated partner's nine personality traits, each from 0 at the centre to 1 at the outer
// ring, drawn in the colour of the arm the partner's couple is in, with a table of the exact values below it. The
// agent page draws it and says the scale in its subtitle (RADAR_SCALE_WORDS).
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from 'recharts';
import type { AgentRow } from '../types';
import { armColor, gridColor } from '../palette';
import { safeFixed } from '../format';
import { CHART_TEXT_PX } from '../chartText';

export const TRAITS: (keyof AgentRow)[] = ['neuroticism', 'agreeableness', 'conscientiousness', 'openness', 'extraversion', 'forgiveness', 'commitment', 'closeness_pref', 'conflict_engagement'];

/** The radar's scale in words, for the chart's subtitle: no number is drawn on the radar itself. */
export const RADAR_SCALE_WORDS = 'Each trait from 0 at the centre to 1 at the outer ring';

/** Short axis labels for narrow radars; the table below carries the full names. */
const SHORT: Record<string, string> = { conscientiousness: 'conscient.', closeness_pref: 'closeness', conflict_engagement: 'engagement', agreeableness: 'agreeable', extraversion: 'extravert', neuroticism: 'neurotic', forgiveness: 'forgiving', commitment: 'committed', openness: 'open' };

export default function TraitRadar({ agent, size }: { agent: AgentRow; size: number }) {
  const narrow = size < 420;
  const data = TRAITS.map((t) => ({ trait: narrow ? SHORT[String(t)] : String(t).replace(/_/g, ' '), full: String(t).replace(/_/g, ' '), value: Number(agent[t]) }));
  const color = armColor(agent.arm);
  // The trait names sit outside the radar, so it is drawn at a quarter of the box to keep every name inside at
  // 16px chart text, down to a phone's width. The scale draws no numbers: a 1 at the rim sat on a trait name and
  // a 0 on the centre, so the subtitle says it in words (RADAR_SCALE_WORDS) and the table gives each value.
  const radius = size * 0.24;
  return (
    <div>
      <RadarChart width={size} height={size} data={data} outerRadius={radius} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
        <PolarGrid stroke={gridColor()} />
        <PolarAngleAxis dataKey="trait" tick={{ fontSize: CHART_TEXT_PX }} />
        <PolarRadiusAxis domain={[0, 1]} tick={false} axisLine={false} />
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

export const BANNER_TEXT = 'Simulated evidence: these are agents under an explicit rule-based policy, not human data';

export default function Banner() {
  return (
    <div className="banner" role="note">
      {BANNER_TEXT}
    </div>
  );
}

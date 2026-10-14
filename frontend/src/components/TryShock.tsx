// LoveWorld simulates 1,000 married couples for a year, and a shock is one event added to a finished world,
// such as a layoff, after which the same couples run again on the same random draws. This is "Try a shock" on
// the read-only demo's World page, in place of "Shock this world". The demo has no server, so
// its shocks were run in advance on the example town (experiments/demo/), and this panel shows one card each:
// the request in plain words, where the shock came from, the shock as it ran and which houses it hits.
// Picking one switches the page to that world in place, exactly as a finished run does in the live app: the
// URL's experiment becomes the shocked world, which replays from just before the shock with every house that
// differs ringed and counted.
import { useMemo } from 'react';
import { getShocksCatalog } from '../api';
import { shockWords, toCatalog, type Catalog } from '../arms';
import { useExperiment } from '../experiment';
import { useExpNavigate, useOpenNewWorld } from '../nav';
import { replayStartForSpecs } from '../shockForm';
import { demoCards, type DemoCard } from '../staticApi';
import { QUICKSTART_URL } from '../staticMode';
import { useAsync } from '../useAsync';
import { ErrorBox, Loading } from './Status';
import { recordedDate } from '../format';

export { recordedDate };

/** Where a card's shock came from, in one sentence. */
export function sourceWords(card: DemoCard, catalog: Catalog | null): string {
  const t = card.translation;
  if (t && card.typed) return `Typed into the shock box and turned into this shock by ${t.model} on ${recordedDate(t.recorded)}.`;
  if (t) return `Turned into this shock by ${t.model} on ${recordedDate(t.recorded)}. Only a fingerprint of the words typed was kept, so the sentence above was written for this demo.`;
  const kinds = [...new Set(card.shocks.map((s) => (catalog?.[s.kind]?.label ?? s.kind.replace(/_/g, ' ')).toLowerCase()))];
  return `Built by hand from the catalog's ${kinds.join(' and ')} ${kinds.length === 1 ? 'kind' : 'kinds'}, with no model.`;
}

/** Which houses a card's shock reaches. */
export function hitsWords(card: DemoCard): string {
  return card.hits === 'all'
    ? 'Every house: both arms, and the couples who remarry during the year.'
    : 'The treatment arm only: the district on the right, or its tab on a phone.';
}

export default function TryShock({ world, onClose, onReplayHere }: { world: string; onClose: () => void; onReplayHere: (fromDay: number) => void }) {
  const exp = useExperiment();
  const cards = useAsync(demoCards, []);
  const catalogData = useAsync(getShocksCatalog, []);
  const catalog = useMemo(() => toCatalog(catalogData.data?.kinds), [catalogData.data]);
  const openWorld = useOpenNewWorld();
  const navigate = useExpNavigate();
  const list = cards.data ?? [];
  const parent = list[0]?.parent ?? null;

  const pick = (card: DemoCard) => {
    const days = exp.items.find((i) => i.name === card.parent)?.days ?? exp.items.find((i) => i.name === card.name)?.days ?? 365;
    const from = replayStartForSpecs(card.shocks, days);
    if (card.name === world) onReplayHere(from);
    else openWorld(card.name, from);
  };

  return (
    <section className="card shock-panel try-shock" aria-label="Try a shock" data-testid="try-shock">
      <div className="shock-panel-head">
        <h2>Try a shock</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="try-lead">
        Each shock below was run in advance on the example town: the same couples on the same random draws, with only that shock added. Pick one, and the town switches to that world, replays it from just before the shock and rings every house that differs.
      </p>
      {cards.error ? (
        <ErrorBox message={`the shocks run in advance did not load: ${cards.error}`} />
      ) : !cards.data ? (
        <Loading what="the shocks run in advance" />
      ) : (
        <div className="try-cards">
          {list.map((card) => {
            const here = card.name === world;
            return (
              <article key={card.name} className={here ? 'try-card here' : 'try-card'} data-testid={`demo-card-${card.name}`} aria-label={card.title}>
                <h3>{card.title}</h3>
                {card.typed ? <p className="try-typed">&ldquo;{card.words}&rdquo;</p> : <p className="try-words">{card.words}.</p>}
                <p className="try-source">{sourceWords(card, catalog)}</p>
                <p>
                  <strong>Ran as:</strong> {card.shocks.map((s) => shockWords(s, catalog)).join(' ')}
                </p>
                <p>
                  <strong>Hits:</strong> {hitsWords(card)}
                </p>
                <button type="button" className="button-link" onClick={() => pick(card)} data-testid={`pick-${card.name}`}>
                  {here ? 'Replay this world' : 'Show this world'}
                </button>
                {here ? <span className="try-here">You are watching this world.</span> : null}
              </article>
            );
          })}
        </div>
      )}
      {parent && world !== parent ? (
        <p>
          <button type="button" onClick={() => navigate('/world', parent)} data-testid="back-to-parent">
            Back to the {parent} town
          </button>
        </p>
      ) : null}
      <p className="try-lead">
        To type a shock of your own, run LoveWorld from the <a href={QUICKSTART_URL}>README quickstart</a>.
      </p>
    </section>
  );
}

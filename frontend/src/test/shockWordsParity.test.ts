// The dashboard says each shock as one plain sentence (shockWords and effectWords in arms.tsx), and the translate
// endpoint answers with the same sentence, written in Python (shock_words in python/loveworld/translate.py). Both
// sides read the shocks and sentences in fixtures/shockWords.json, so the two wordings cannot drift apart.
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/shockWords.json';
import { effectWords, shockWords, toCatalog } from '../arms';
import type { ShockKind, ShockSpec } from '../types';

interface SharedCase {
  spec: ShockSpec;
  words: string;
  effects?: string[];
}

const shared = fixture as unknown as { catalog: ShockKind[]; cases: SharedCase[] };

describe('the sentences shared with the translate endpoint', () => {
  const catalog = toCatalog(shared.catalog);

  it('covers every kind in the catalog, a custom shock with every channel, and each target and partner', () => {
    const specs = shared.cases.map((c) => c.spec);
    expect(new Set(specs.map((s) => s.kind))).toEqual(new Set([...shared.catalog.map((k) => k.kind), 'custom', 'heatwave']));
    expect(new Set(specs.map((s) => s.target))).toEqual(new Set(['treatment', 'all', 'control']));
    expect(new Set(specs.map((s) => s.member))).toEqual(new Set(['random', 'a', 'b']));
    const channels = new Set(specs.flatMap((s) => (s.effects ?? []).map((e) => e.channel)));
    expect(channels).toEqual(new Set(['stress', 'affect', 'trust', 'episode', 'outside', 'onset_hazard', 'repair_propensity', 'trait']));
  });

  it('says every shared shock as its shared sentence', () => {
    const wrong = shared.cases.filter((c) => shockWords(c.spec, catalog) !== c.words).map((c) => ({ spec: c.spec, want: c.words, got: shockWords(c.spec, catalog) }));
    expect(wrong).toEqual([]);
  });

  it('says every effect of a shared custom shock as its shared sentence', () => {
    for (const c of shared.cases.filter((x) => x.spec.kind === 'custom')) {
      expect((c.spec.effects ?? []).map((e) => effectWords(e, c.spec))).toEqual(c.effects);
    }
  });
});

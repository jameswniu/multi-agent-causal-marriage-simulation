// The size of the words in every chart, in px: 14 in the live app, and 16 in the read-only demo (VITE_STATIC=1),
// which is read at 75% zoom, where 16px shows as 12px, the least any text may be. styles.css sets the same size
// on chart text, and the charts lay out their labels for it.
export const CHART_TEXT_PX = import.meta.env.VITE_STATIC === '1' ? 16 : 14;

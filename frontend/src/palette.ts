// Series colours resolved from the CSS tokens so light and dark stay in sync with styles.css.
import type { Arm, RelState } from './types';

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export const ARM_FALLBACK: Record<Arm, string> = { control: '#2a78d6', treatment: '#eb6834' };

export function armColor(arm: Arm): string {
  return cssVar(`--${arm}`, ARM_FALLBACK[arm]);
}

export function memberColor(side: 'a' | 'b'): string {
  return cssVar(`--member-${side}`, side === 'a' ? '#1baf7a' : '#6250d6');
}

export function stateColor(state: RelState): string {
  switch (state) {
    case 'married':
      return cssVar('--state-married', '#2a78d6');
    case 'dating':
      return cssVar('--state-dating', '#1baf7a');
    case 'separated':
      return cssVar('--state-separated', '#eb6834');
    case 'divorced':
      return cssVar('--state-divorced', '#3b3b37');
    case 'broken_up':
      return cssVar('--state-broken', '#c9c8c0');
    default:
      return cssVar('--state-ended', '#898781');
  }
}

export function inkColor(): string {
  return cssVar('--ink-2', '#52514e');
}

export function gridColor(): string {
  return cssVar('--grid', '#e1e0d9');
}

export function axisColor(): string {
  return cssVar('--axis', '#c3c2b7');
}


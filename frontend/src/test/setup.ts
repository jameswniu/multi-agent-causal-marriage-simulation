import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * jsdom has no canvas. This asserting mock records every drawing call so the World tests can
 * check that tiles were really painted (a null context would hide a broken draw loop).
 */
export const canvasStats = { fillRect: 0, strokeRect: 0, clearRect: 0, contexts: 0 };

export function resetCanvasStats(): void {
  canvasStats.fillRect = 0;
  canvasStats.strokeRect = 0;
  canvasStats.clearRect = 0;
  canvasStats.contexts = 0;
}

function fakeContext(): CanvasRenderingContext2D {
  canvasStats.contexts += 1;
  const noop = () => {};
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    setTransform: noop,
    clearRect: () => {
      canvasStats.clearRect += 1;
    },
    fillRect: () => {
      canvasStats.fillRect += 1;
    },
    strokeRect: () => {
      canvasStats.strokeRect += 1;
    },
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    setLineDash: noop,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement, kind: string) {
  if (kind !== '2d') throw new Error(`unexpected canvas context ${kind}`);
  return fakeContext();
}) as unknown as HTMLCanvasElement['getContext'];

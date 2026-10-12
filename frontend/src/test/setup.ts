import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * jsdom has no canvas. This asserting mock records every drawing call so the World tests can
 * check that tiles were really painted (a null context would hide a broken draw loop).
 */
export const canvasStats = { fillRect: 0, strokeRect: 0, clearRect: 0, contexts: 0 };

/** One outlined rectangle, with the colour and width it was stroked in. */
export interface StrokedRect {
  style: string;
  width: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each canvas's outlined rectangles since it was last cleared: what the frame it shows now outlines. */
const frames = new WeakMap<HTMLCanvasElement, StrokedRect[]>();

/** The rectangles a canvas outlines in the frame it shows now. */
export function strokesOn(canvas: HTMLCanvasElement): StrokedRect[] {
  return frames.get(canvas) ?? [];
}

export function resetCanvasStats(): void {
  canvasStats.fillRect = 0;
  canvasStats.strokeRect = 0;
  canvasStats.clearRect = 0;
  canvasStats.contexts = 0;
}

function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
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
      frames.set(canvas, []);
    },
    fillRect: () => {
      canvasStats.fillRect += 1;
    },
    strokeRect: (x: number, y: number, w: number, h: number) => {
      canvasStats.strokeRect += 1;
      const list = frames.get(canvas) ?? [];
      list.push({ style: String(ctx.strokeStyle), width: ctx.lineWidth, x, y, w, h });
      frames.set(canvas, list);
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
  return fakeContext(this);
}) as unknown as HTMLCanvasElement['getContext'];

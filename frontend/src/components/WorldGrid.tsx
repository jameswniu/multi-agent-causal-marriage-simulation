import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StateChar } from '../types';
import { stateColor, inkColor, gridColor } from '../palette';
import { DIFF_RING_CSS, DIFF_RING_PX, RING_WORDS } from '../worldDiff';

export interface TileStyle {
  fill: string;
  /** Open conflict: an ink square filling about half the tile. */
  inner: boolean;
  /** Broken up (a dating couple that split): a diagonal slash over the tile. */
  slash: boolean;
  label: string;
  empty: boolean;
}

/** Legend letter to tile style. Conflict keeps the married hue and adds the inner square. */
export function charStyle(ch: string): TileStyle {
  switch (ch as StateChar) {
    case 'M':
      return { fill: stateColor('married'), inner: false, slash: false, label: 'married', empty: false };
    case 'C':
      return { fill: stateColor('married'), inner: true, slash: false, label: 'married, in conflict', empty: false };
    case 'S':
      return { fill: stateColor('separated'), inner: false, slash: false, label: 'separated', empty: false };
    case 'T':
      return { fill: stateColor('dating'), inner: false, slash: false, label: 'dating', empty: false };
    case 'D':
      return { fill: stateColor('divorced'), inner: false, slash: false, label: 'divorced', empty: false };
    case 'B':
      return { fill: stateColor('broken_up'), inner: false, slash: true, label: 'broken up', empty: false };
    default:
      return { fill: 'transparent', inner: false, slash: false, label: 'not formed yet', empty: true };
  }
}

/** A tile pulses on the day its state changed: compare with the previous day, not the last frame. */
export function changedOnDay(states: string[], day: number, idx: number): boolean {
  if (day <= 0 || day >= states.length) return false;
  return states[day][idx] !== states[day - 1][idx];
}

interface Props {
  title: string;
  subtitle?: ReactNode;
  couples: number[];
  /** One string per day, one char per couple (index into `couples`). */
  states: string[];
  /** Positions to draw, in order. */
  indices: number[];
  day: number;
  tile?: number;
  onPick: (coupleId: number) => void;
  /** Extra hover text for a tile, e.g. the twin's state. */
  hoverExtra?: (idx: number, day: number) => string;
  /** Positions to ring today, as the town rings their houses: the couples whose state differs from the world this one is compared with. */
  rings?: number[] | null;
  testId?: string;
}

const GAP = 2;

/** One canvas per grid; redraws on day change without any per-tile React work. Keyboard: focus the
 * canvas, arrows move between tiles, Enter opens the couple; a live region reads the tile out. */
export default function WorldGrid({ title, subtitle, couples, states, indices, day, tile = 12, onPick, hoverExtra, rings = null, testId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState('');
  const [focus, setFocus] = useState<number | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const ringed = useMemo(() => (rings && rings.length ? new Set(rings) : null), [rings]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((width + GAP) / (tile + GAP)));
  const rows = Math.max(1, Math.ceil(indices.length / cols));
  const height = rows * (tile + GAP);
  const d = Math.min(Math.max(0, day), Math.max(0, states.length - 1));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const chars = states[d] ?? '';
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const ink = inkColor();
    const grid = gridColor();
    const innerSide = Math.max(4, Math.round(tile * 0.55));
    const innerOff = Math.floor((tile - innerSide) / 2);
    const ringPx = Math.min(DIFF_RING_PX, Math.max(1, Math.floor(tile / 4)));
    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k];
      const ch = chars[idx] ?? '-';
      const st = charStyle(ch);
      const x = (k % cols) * (tile + GAP);
      const y = Math.floor(k / cols) * (tile + GAP);
      if (st.empty) {
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
      } else {
        ctx.fillStyle = st.fill;
        ctx.fillRect(x, y, tile, tile);
        if (st.inner) {
          ctx.fillStyle = ink;
          ctx.fillRect(x + innerOff, y + innerOff, innerSide, innerSide);
        }
        if (st.slash) {
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + 2, y + tile - 2);
          ctx.lineTo(x + tile - 2, y + 2);
          ctx.stroke();
        }
      }
      if (ringed?.has(idx)) {
        // Inside the tile, as the town's ring sits inside its lot, so the pulse and the focus ring
        // drawn around the tile still show.
        ctx.strokeStyle = DIFF_RING_CSS;
        ctx.lineWidth = ringPx;
        ctx.strokeRect(x + ringPx / 2, y + ringPx / 2, tile - ringPx, tile - ringPx);
      }
      if (changedOnDay(states, d, idx)) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y - 1, tile + 2, tile + 2);
      }
      if (hasFocus && focus === k) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(x - 2, y - 2, tile + 4, tile + 4);
        ctx.setLineDash([]);
      }
    }
  }, [states, indices, d, width, height, cols, tile, focus, hasFocus, ringed]);

  const tileAt = (ev: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const c = Math.floor(px / (tile + GAP));
    const r = Math.floor(py / (tile + GAP));
    if (c < 0 || c >= cols) return null;
    const k = r * cols + c;
    return k >= 0 && k < indices.length ? k : null;
  };

  const describe = (k: number): string => {
    const idx = indices[k];
    const ch = states[d]?.[idx] ?? '-';
    const extra = hoverExtra ? ` ${hoverExtra(idx, d)}` : '';
    const ring = ringed?.has(idx) ? ` ${RING_WORDS}.` : '';
    return `Couple ${couples[idx]}: ${charStyle(ch).label}.${ring}${extra}`;
  };

  const onKey = (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (indices.length === 0) return;
    const cur = focus ?? 0;
    let next: number;
    if (ev.key === 'ArrowRight') next = Math.min(indices.length - 1, cur + 1);
    else if (ev.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (ev.key === 'ArrowDown') next = Math.min(indices.length - 1, cur + cols);
    else if (ev.key === 'ArrowUp') next = Math.max(0, cur - cols);
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = indices.length - 1;
    else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      ev.stopPropagation();
      onPick(couples[indices[cur]]);
      return;
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
    setFocus(next);
  };

  const focusText = hasFocus && focus !== null && focus < indices.length ? describe(focus) : '';

  return (
    <div className="card" ref={wrapRef} style={{ minWidth: 0 }}>
      <p className="chart-title">{title}</p>
      {subtitle ? <div className="chart-sub">{subtitle}</div> : null}
      <p className="chart-sub" data-testid={testId ? `${testId}-hover` : undefined}>
        {hover || focusText || `${indices.length} couples. Hover or focus a tile for its state, click or press Enter to open the couple.`}
      </p>
      <canvas
        ref={canvasRef}
        data-testid={testId ?? `grid-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
        style={{ width, height, maxWidth: '100%', display: 'block', cursor: 'pointer' }}
        tabIndex={0}
        role="group"
        aria-label={`${title} tiles, ${indices.length} couples. Use arrow keys to move between tiles and Enter to open one.`}
        onFocus={() => {
          setHasFocus(true);
          setFocus((f) => f ?? 0);
        }}
        onBlur={() => setHasFocus(false)}
        onKeyDown={onKey}
        onMouseMove={(ev) => {
          const k = tileAt(ev);
          setHover(k === null ? '' : describe(k));
        }}
        onMouseLeave={() => setHover('')}
        onClick={(ev) => {
          const k = tileAt(ev);
          if (k !== null) onPick(couples[indices[k]]);
        }}
      />
      <div className="sr-only" aria-live="polite" data-testid={testId ? `${testId}-live` : undefined}>
        {focusText}
      </div>
    </div>
  );
}

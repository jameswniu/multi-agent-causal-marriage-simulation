// The town view of the World page. Every couple is a house and its two agents are figures drawn
// with PixiJS on one canvas. Each day's logged states decide where every figure stands, and the
// walk from one day's place to the next is cosmetic. The engine has no space, so this is a layout
// that shows each agent's state, not a map of where anyone went.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { listCouples } from '../api';
import type { CoupleRow, WorldResponse } from '../types';
import {
  LOT_H,
  LOT_W,
  MARGIN,
  buildAgents,
  buildLayout,
  everMarried,
  focusOrder,
  hash01,
  houseState,
  lotAt,
  moveFocus,
  placeAgent,
  roofsOnly,
  shouldSnap,
  stateWords,
  stepToward,
  walkSpeed,
  type AgentInfo,
  type Posture,
  type TownLayout,
} from './layout';

type Pixi = typeof import('pixi.js');

const ASSET = '/assets/kenney';
const PEOPLE = 8;
/** Screen pixels per lot when the town first opens: figures readable, both districts in view. */
const OPEN_LOT_PX = 36;
const MAX_SCALE = 4;
const DRAG_PX = 5;
const STATS_WINDOW = 120;
/** How long the town waits for the couples table before drawing stand-in people instead. */
const COUPLES_TIMEOUT_MS = 8000;

export interface TownStats {
  avgFrameMs: number;
  p95FrameMs: number;
  avgUpdateMs: number;
  figures: number;
  frames: number;
}

declare global {
  interface Window {
    __loveworldTown?: TownStats;
  }
}

interface Props {
  world: WorldResponse;
  day: number;
  speed: number;
  controlTitle: string;
  treatmentTitle: string;
  onPickCouple: (coupleId: number) => void;
  onPickAgent: (agentId: number) => void;
  onFallback: (reason: string) => void;
}

const POSTURE_CODE: Record<Posture, number> = { home: 0, conflict: 1, away: 2, single: 3, dating: 4 };

interface Scene {
  root: Container;
  houses: (Sprite | null)[];
  markers: (Sprite | null)[];
  figures: Sprite[];
  figureLayer: Container;
  markerLayer: Container;
  highlight: Graphics;
  owned: Texture[];
  allTextures: Texture[];
}

function houseKey(left: string | null, right: string | null): string {
  return `${left === 'treatment' ? 't' : 'c'}${right === 'treatment' ? 't' : 'c'}`;
}

async function loadTextures(PIXI: Pixi): Promise<Record<string, Texture>> {
  const town = [
    'grass',
    'grass-tuft',
    'grass-flower',
    'tree-pine',
    'tree-orange',
    'tree-round',
    'bush',
    'cobble',
    'dirt-tl',
    'dirt-t',
    'dirt-tr',
    'dirt-l',
    'dirt-c',
    'dirt-r',
    'dirt-bl',
    'dirt-b',
    'dirt-br',
    'wall-window',
    'wall-door',
    'roof-left-control',
    'roof-right-control',
    'roof-left-treatment',
    'roof-right-treatment',
  ];
  const urls: Record<string, string> = {};
  for (const name of town) urls[name] = `${ASSET}/town/${name}.png`;
  for (let i = 0; i < PEOPLE; i++) urls[`person-${i}`] = `${ASSET}/people/person-${i}.png`;
  const loaded = (await PIXI.Assets.load(Object.values(urls))) as Record<string, Texture>;
  const out: Record<string, Texture> = {};
  for (const [name, url] of Object.entries(urls)) {
    const tex = loaded[url];
    if (!tex) throw new Error(`missing town art ${url}`);
    tex.source.scaleMode = 'nearest';
    out[name] = tex;
  }
  return out;
}

function buildScene(PIXI: Pixi, app: Application, layout: TownLayout, agents: AgentInfo[], world: WorldResponse, tex: Record<string, Texture>, titles: [string, string]): Scene {
  const owned: Texture[] = [];
  const root = new PIXI.Container();

  // Ground: grass everywhere, a few tufts and flowers, trees along the edges, a dirt plaza.
  root.addChild(new PIXI.TilingSprite({ texture: tex.grass, width: layout.width, height: layout.height }));
  const decor = new PIXI.Container();
  const scatter = Math.floor((layout.width * layout.height) / (LOT_W * LOT_W * 6));
  for (let i = 0; i < scatter; i++) {
    const s = new PIXI.Sprite(hash01(i, 11) < 0.7 ? tex['grass-tuft'] : tex['grass-flower']);
    s.position.set(Math.floor(hash01(i, 12) * (layout.width - 16)), Math.floor(hash01(i, 13) * (layout.height - 16)));
    decor.addChild(s);
  }
  const trees = [tex['tree-pine'], tex['tree-round'], tex['tree-orange'], tex.bush];
  const treeAt = (x: number, y: number, n: number) => {
    const s = new PIXI.Sprite(trees[Math.floor(hash01(n, 14) * trees.length)]);
    s.anchor.set(0.5, 1);
    s.position.set(x, y);
    decor.addChild(s);
  };
  for (let x = 24, n = 0; x < layout.width - 8; x += 26 + Math.floor(hash01(n, 15) * 18), n++) {
    treeAt(x, MARGIN - 6, n);
    treeAt(x + 9, layout.height - 6, n + 500);
  }
  for (let y = MARGIN + 30, n = 0; y < layout.height - 20; y += 30 + Math.floor(hash01(n, 16) * 20), n++) {
    treeAt(16, y, n + 1000);
    treeAt(layout.width - 16, y, n + 2000);
  }
  root.addChild(decor);

  const pad = 10;
  const px = layout.plaza.x - pad;
  const py = layout.plaza.y - pad;
  const pw = layout.plaza.w + pad * 2;
  const ph = layout.plaza.h + pad * 2;
  const plaza = new PIXI.Container();
  const tile = (t: Texture, x: number, y: number, w = 16, h = 16) => {
    const s = new PIXI.TilingSprite({ texture: t, width: w, height: h });
    s.position.set(x, y);
    plaza.addChild(s);
  };
  tile(tex['dirt-c'], px + 16, py + 16, pw - 32, ph - 32);
  tile(tex['dirt-t'], px + 16, py, pw - 32, 16);
  tile(tex['dirt-b'], px + 16, py + ph - 16, pw - 32, 16);
  tile(tex['dirt-l'], px, py + 16, 16, ph - 32);
  tile(tex['dirt-r'], px + pw - 16, py + 16, 16, ph - 32);
  tile(tex['dirt-tl'], px, py);
  tile(tex['dirt-tr'], px + pw - 16, py);
  tile(tex['dirt-bl'], px, py + ph - 16);
  tile(tex['dirt-br'], px + pw - 16, py + ph - 16);
  for (let i = 0; i < 14; i++) {
    const s = new PIXI.Sprite(tex.cobble);
    s.position.set(layout.plaza.x + Math.floor(hash01(i, 17) * (layout.plaza.w - 16)), layout.plaza.y + Math.floor(hash01(i, 18) * (layout.plaza.h - 16)));
    s.alpha = 0.55;
    plaza.addChild(s);
  }
  root.addChild(plaza);

  const label = (text: string, x: number, y: number, size = 22, weight: '400' | '600' = '600', alignRight = false) => {
    const t = new PIXI.Text({
      text,
      style: { fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: size, fontWeight: weight, fill: 0x14301c },
      resolution: 3,
    });
    if (alignRight) t.anchor.set(1, 0);
    t.position.set(x, y);
    root.addChild(t);
  };
  // The control titles sit at the district's inner edge, so the opening view shows both arms' names.
  const controlRight = layout.control.x + layout.control.w;
  label(titles[0], controlRight, MARGIN + 8, 22, '600', true);
  label(`${layout.order.control.length.toLocaleString()} couples`, controlRight, MARGIN + 36, 16, '400', true);
  label(titles[1], layout.treatment.x, MARGIN + 8);
  label(`${layout.order.treatment.length.toLocaleString()} couples`, layout.treatment.x, MARGIN + 36, 16, '400');
  label('Plaza', layout.plaza.x, MARGIN + 8);
  label('singles, dating, new homes', layout.plaza.x, MARGIN + 36, 16, '400');

  // Houses: four textures (left and right roof halves in either arm colour) shared by all lots.
  const houseTex: Record<string, Texture> = {};
  for (const l of ['control', 'treatment']) {
    for (const r of ['control', 'treatment']) {
      const c = new PIXI.Container();
      const parts: [Texture, number, number][] = [
        [tex[`roof-left-${l}`], 0, 0],
        [tex[`roof-right-${r}`], 16, 0],
        [tex['wall-window'], 0, 16],
        [tex['wall-door'], 16, 16],
      ];
      for (const [t, x, y] of parts) {
        const s = new PIXI.Sprite(t);
        s.position.set(x, y);
        c.addChild(s);
      }
      const rt = app.renderer.generateTexture({ target: c, resolution: 1, antialias: false });
      rt.source.scaleMode = 'nearest';
      houseTex[houseKey(l, r)] = rt;
      owned.push(rt);
      c.destroy({ children: true });
    }
  }
  const sideArms = new Map<number, [string | null, string | null]>();
  for (const a of agents) {
    a.couples.forEach((idx, j) => {
      const pair = sideArms.get(idx) ?? [null, null];
      pair[a.sides[j] === 'a' ? 0 : 1] = a.homeArm;
      sideArms.set(idx, pair);
    });
  }
  const houseLayer = new PIXI.Container();
  const houses: (Sprite | null)[] = world.couples.map((_, idx) => {
    const lot = layout.lots[idx];
    if (!lot) return null;
    const key = lot.zone === 'newhomes' ? houseKey(...(sideArms.get(idx) ?? [null, null])) : houseKey(world.arms[idx], world.arms[idx]);
    const s = new PIXI.Sprite(houseTex[key]);
    s.position.set(lot.x + 8, lot.y + 4);
    houseLayer.addChild(s);
    return s;
  });
  root.addChild(houseLayer);

  // Conflict markers: a small yellow sign above the roof, shown only while the couple fights.
  const g = new PIXI.Graphics();
  g.poly([6, 0, 12, 7, 6, 14, 0, 7]).fill(0xf6c945).stroke({ width: 1.5, color: 0x3f2631 });
  g.rect(5.2, 3.2, 1.6, 5).fill(0x3f2631);
  g.rect(5.2, 9.4, 1.6, 1.6).fill(0x3f2631);
  const markerTex = app.renderer.generateTexture({ target: g, resolution: 4, antialias: true });
  owned.push(markerTex);
  g.destroy();
  const markerLayer = new PIXI.Container();
  const markers: (Sprite | null)[] = world.couples.map((_, idx) => {
    const lot = layout.lots[idx];
    if (!lot) return null;
    const s = new PIXI.Sprite(markerTex);
    s.anchor.set(0.5, 1);
    s.position.set(lot.x + 24, lot.y + 4);
    s.visible = false;
    markerLayer.addChild(s);
    return s;
  });

  const figureLayer = new PIXI.Container();
  figureLayer.sortableChildren = true;
  const figures = agents.map((a) => {
    const s = new PIXI.Sprite(tex[`person-${Math.floor(hash01(Math.abs(a.id), 7) * PEOPLE)}`]);
    s.anchor.set(0.5, 1);
    figureLayer.addChild(s);
    return s;
  });
  root.addChild(figureLayer);
  root.addChild(markerLayer);

  const highlight = new PIXI.Graphics();
  root.addChild(highlight);

  return { root, houses, markers, figures, figureLayer, markerLayer, highlight, owned, allTextures: [...Object.values(tex), ...owned] };
}

export default function TownView({ world, day, speed, controlTitle, treatmentTitle, onPickCouple, onPickAgent, onFallback }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<CoupleRow[] | null>(null);
  const [rowsNote, setRowsNote] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState('');
  const dayRef = useRef(day);
  const speedRef = useRef(speed);
  const pickCouple = useRef(onPickCouple);
  const pickAgent = useRef(onPickAgent);
  const fallback = useRef(onFallback);
  const camera = useRef<{ fit: () => void; open: () => void; zoom: (f: number) => void } | null>(null);

  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    pickCouple.current = onPickCouple;
    pickAgent.current = onPickAgent;
    fallback.current = onFallback;
  }, [onPickCouple, onPickAgent, onFallback]);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const standIns = (why: string) => {
      if (cancelled || settled) return;
      settled = true;
      setRowsNote(`${why}, so each couple's two people are drawn as stand-ins and a divorced agent is not followed into a new couple.`);
      setRows([]);
    };
    const timer = window.setTimeout(() => standIns(`The couples table did not arrive within ${COUPLES_TIMEOUT_MS / 1000} seconds`), COUPLES_TIMEOUT_MS);
    listCouples({ limit: 10000 }).then(
      (r) => {
        if (cancelled || settled) return;
        settled = true;
        setRows(r.items);
      },
      (err: unknown) => standIns(`Could not load the couples table (${err instanceof Error ? err.message : String(err)})`),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [world]);

  const layout = useMemo(() => buildLayout(world, everMarried(world)), [world]);
  const agents = useMemo(() => (rows === null ? null : buildAgents(world, rows)), [world, rows]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !agents) return;
    let disposed = false;
    let app: Application | null = null;
    let scene: Scene | null = null;
    const cleanups: (() => void)[] = [];

    const start = async () => {
      const PIXI = await import('pixi.js');
      if (disposed) return;
      const created = new PIXI.Application();
      await created.init({
        resizeTo: host,
        background: 0x7cc576,
        antialias: false,
        preference: 'webgl',
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
      });
      if (disposed) {
        created.destroy(true, { children: true });
        return;
      }
      app = created;
      const tex = await loadTextures(PIXI);
      if (disposed) return;
      const canvas = app.canvas;
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'group');
      canvas.setAttribute('aria-label', `Town of ${world.couples.length.toLocaleString()} couples, each a house with its two people. Arrow keys move between houses, Enter opens one, plus and minus zoom.`);
      canvas.style.display = 'block';
      host.appendChild(canvas);
      scene = buildScene(PIXI, app, layout, agents, world, tex, [controlTitle, treatmentTitle]);
      app.stage.addChild(scene.root);
      const sc = scene;
      const theApp = app;

      // Camera: pan, zoom about a point, the opening view on the plaza, and the whole town.
      let scale = 1;
      let nearest: boolean | null = null;
      const view = () => ({ w: theApp.screen.width, h: theApp.screen.height });
      const clampCamera = () => {
        const { w, h } = view();
        const tw = layout.width * scale;
        const th = layout.height * scale;
        sc.root.x = tw <= w ? (w - tw) / 2 : Math.min(w * 0.08, Math.max(w * 0.92 - tw, sc.root.x));
        sc.root.y = th <= h ? (h - th) / 2 : Math.min(h * 0.08, Math.max(h * 0.92 - th, sc.root.y));
      };
      const applyScale = (s: number) => {
        scale = s;
        sc.root.scale.set(s);
        const roofs = roofsOnly(s);
        sc.figureLayer.visible = !roofs;
        sc.markerLayer.visible = !roofs;
        const wantNearest = s * theApp.renderer.resolution >= 1;
        if (wantNearest !== nearest) {
          nearest = wantNearest;
          for (const t of sc.allTextures) t.source.scaleMode = wantNearest ? 'nearest' : 'linear';
        }
      };
      const minScale = () => Math.min(view().w / layout.width, view().h / layout.height) * 0.9;
      const zoomAt = (sx: number, sy: number, next: number) => {
        const s = Math.min(MAX_SCALE, Math.max(minScale(), next));
        const wx = (sx - sc.root.x) / scale;
        const wy = (sy - sc.root.y) / scale;
        applyScale(s);
        sc.root.x = sx - wx * s;
        sc.root.y = sy - wy * s;
        clampCamera();
      };
      const fit = () => {
        applyScale(minScale() / 0.9);
        clampCamera();
      };
      const open = () => {
        const { w } = view();
        const s = Math.max(minScale(), OPEN_LOT_PX / LOT_W);
        applyScale(s);
        sc.root.x = w / 2 - (layout.plaza.x + layout.plaza.w / 2) * s;
        sc.root.y = 4 - 12 * s;
        clampCamera();
      };
      camera.current = { fit, open, zoom: (f: number) => zoomAt(view().w / 2, view().h / 2, scale * f) };
      open();

      // Figures: targets come from the day's states; positions walk toward them each frame.
      const n = agents.length;
      const tx = new Float32Array(n);
      const ty = new Float32Array(n);
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      const posture = new Uint8Array(n);
      const facing = new Int8Array(n);
      const anchorCouple = new Int32Array(n);
      const phase = new Float32Array(n);
      for (let i = 0; i < n; i++) phase[i] = hash01(Math.abs(agents[i].id), 9) * Math.PI * 2;
      const placements = new Array<number | null>(n).fill(null);
      let lastDay: number | null = null;
      let snapFrame = true;
      const retarget = (d: number) => {
        const states = world.states[Math.min(Math.max(0, d), world.states.length - 1)] ?? '';
        for (let i = 0; i < n; i++) {
          const p = placeAgent(agents[i], states, layout, world.couples);
          tx[i] = p.x;
          ty[i] = p.y;
          posture[i] = POSTURE_CODE[p.posture];
          facing[i] = p.facing;
          anchorCouple[i] = p.couple ?? -1;
          placements[i] = p.couple;
        }
        world.couples.forEach((_, idx) => {
          const st = houseState(states[idx] ?? '-', world.origin[idx]);
          const h = sc.houses[idx];
          if (h) {
            h.visible = st.visible;
            h.alpha = st.dim ? 0.45 : 1;
            h.tint = st.dim ? 0x9a9a9a : 0xffffff;
          }
          const m = sc.markers[idx];
          if (m) m.visible = st.conflict;
        });
      };

      const frames: number[] = [];
      const updates: number[] = [];
      let frameCount = 0;
      const tick = () => {
        const t0 = performance.now();
        const d = dayRef.current;
        const sp = speedRef.current;
        if (d !== lastDay) {
          snapFrame = snapFrame || shouldSnap(lastDay, d, sp);
          retarget(d);
          lastDay = d;
        }
        const walk = walkSpeed(sp);
        const dt = Math.min(0.1, theApp.ticker.deltaMS / 1000);
        const now = t0 / 1000;
        const maxStep = walk === null ? Infinity : walk * dt;
        for (let i = 0; i < n; i++) {
          let gx = tx[i];
          let gy = ty[i];
          const p = posture[i];
          if (p === POSTURE_CODE.single) {
            gx += Math.cos(now * 0.55 + phase[i]) * 5;
            gy += Math.sin(now * 0.4 + phase[i] * 1.3) * 3;
          } else if (p === POSTURE_CODE.dating) {
            const a = now * 0.7 + hash01(anchorCouple[i], 21) * Math.PI * 2;
            gx += Math.cos(a) * 10;
            gy += Math.sin(a) * 5;
          }
          let moving = false;
          if (snapFrame) {
            x[i] = gx;
            y[i] = gy;
          } else {
            const px0 = x[i];
            const py0 = y[i];
            const [nx, ny, still] = stepToward(px0, py0, gx, gy, maxStep);
            moving = still && Math.hypot(nx - px0, ny - py0) > 0.5;
            if (moving) facing[i] = nx < px0 ? -1 : 1;
            x[i] = nx;
            y[i] = ny;
          }
          const s = sc.figures[i];
          const bob = moving ? Math.abs(Math.sin(now * 14 + phase[i])) * 1.5 : 0;
          s.position.set(x[i], y[i] - bob);
          s.scale.x = facing[i];
          s.zIndex = y[i];
        }
        snapFrame = false;
        frames.push(theApp.ticker.deltaMS);
        updates.push(performance.now() - t0);
        if (frames.length > STATS_WINDOW) frames.shift();
        if (updates.length > STATS_WINDOW) updates.shift();
        frameCount += 1;
        if (frameCount % 30 === 0) {
          const sorted = [...frames].sort((p, q) => p - q);
          window.__loveworldTown = {
            avgFrameMs: frames.reduce((p, q) => p + q, 0) / frames.length,
            p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            avgUpdateMs: updates.reduce((p, q) => p + q, 0) / updates.length,
            figures: n,
            frames: frameCount,
          };
        }
      };
      theApp.ticker.add(tick);
      cleanups.push(() => theApp.ticker.remove(tick));

      // Pointer: drag to pan, wheel to zoom, hover names the house or person, click opens it.
      const toWorld = (ev: { clientX: number; clientY: number }) => {
        const r = canvas.getBoundingClientRect();
        const sx = ev.clientX - r.left;
        const sy = ev.clientY - r.top;
        return { sx, sy, wx: (sx - sc.root.x) / scale, wy: (sy - sc.root.y) / scale };
      };
      // Every drawn person can be hovered and opened. A figure stands below its house's walls, so
      // a point on the house itself still opens the couple.
      const figureAt = (wx: number, wy: number): number | null => {
        if (!sc.figureLayer.visible) return null;
        let best: number | null = null;
        let bestD = 8;
        for (let i = 0; i < n; i++) {
          const dd = Math.hypot(x[i] - wx, y[i] - 8 - wy);
          if (dd < bestD) {
            bestD = dd;
            best = i;
          }
        }
        return best;
      };
      const lotText = (idx: number): string => {
        const states = world.states[Math.min(Math.max(0, dayRef.current), world.states.length - 1)] ?? '';
        const zone = layout.lots[idx]?.zone ?? 'newhomes';
        const where = zone === 'newhomes' ? 'remarried' : zone;
        return `Couple ${world.couples[idx]} (${where}): ${stateWords(states[idx] ?? '-')}.`;
      };
      const describe = (wx: number, wy: number): { text: string; couple: number | null; agent: number | null; lot: number | null } => {
        const states = world.states[Math.min(Math.max(0, dayRef.current), world.states.length - 1)] ?? '';
        const fig = figureAt(wx, wy);
        if (fig !== null) {
          const a = agents[fig];
          const c = placements[fig];
          const who = a.id >= 0 ? `Agent ${a.id}` : `A partner from couple ${world.couples[a.couples[0]]}`;
          const agent = a.id >= 0 ? a.id : null;
          if (c !== null) return { text: `${who}, couple ${world.couples[c]}: ${stateWords(states[c] ?? '-')}.`, couple: world.couples[c], agent, lot: null };
          return { text: `${who}: single in the plaza.`, couple: null, agent, lot: null };
        }
        const idx = lotAt(layout, wx, wy);
        if (idx === null) return { text: '', couple: null, agent: null, lot: null };
        return { text: lotText(idx), couple: world.couples[idx], agent: null, lot: idx };
      };
      let drag: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
      let lastHover = '';
      const onDown = (ev: PointerEvent) => {
        const p = toWorld(ev);
        drag = { sx: p.sx, sy: p.sy, ox: sc.root.x, oy: sc.root.y, moved: false };
        canvas.setPointerCapture(ev.pointerId);
      };
      const onMove = (ev: PointerEvent) => {
        const p = toWorld(ev);
        if (drag) {
          const dx = p.sx - drag.sx;
          const dy = p.sy - drag.sy;
          if (drag.moved || Math.hypot(dx, dy) > DRAG_PX) {
            drag.moved = true;
            sc.root.x = drag.ox + dx;
            sc.root.y = drag.oy + dy;
            clampCamera();
            canvas.style.cursor = 'grabbing';
            return;
          }
        }
        const info = describe(p.wx, p.wy);
        canvas.style.cursor = info.couple !== null || info.agent !== null ? 'pointer' : 'grab';
        if (info.text !== lastHover) {
          lastHover = info.text;
          setHover(info.text);
        }
        sc.highlight.clear();
        const lot = info.lot === null ? undefined : layout.lots[info.lot];
        if (lot) {
          sc.highlight.rect(lot.x + 2, lot.y + 1, LOT_W - 4, 54).stroke({ width: 2, color: 0x0b0b0b, alpha: 0.8 });
        }
      };
      const onUp = (ev: PointerEvent) => {
        const p = toWorld(ev);
        const wasClick = drag !== null && !drag.moved;
        drag = null;
        canvas.style.cursor = 'grab';
        if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
        if (!wasClick) return;
        const info = describe(p.wx, p.wy);
        if (info.agent !== null) pickAgent.current(info.agent);
        else if (info.couple !== null) pickCouple.current(info.couple);
      };
      const onLeave = () => {
        sc.highlight.clear();
        lastHover = '';
        setHover('');
      };
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault();
        const p = toWorld(ev);
        zoomAt(p.sx, p.sy, scale * Math.exp(-ev.deltaY * 0.0015));
      };
      // Keyboard: focus walks the houses in order, Enter opens one, plus and minus zoom, and the
      // camera follows the focused house.
      const order = focusOrder(layout);
      let focusK: number | null = null;
      const nearestToCenter = (): number => {
        const { w, h } = view();
        const wx = (w / 2 - sc.root.x) / scale;
        const wy = (h / 2 - sc.root.y) / scale;
        let best = 0;
        let bestD = Infinity;
        order.forEach((idx, k) => {
          const lot = layout.lots[idx];
          if (!lot) return;
          const dd = Math.hypot(lot.x + LOT_W / 2 - wx, lot.y + LOT_H / 2 - wy);
          if (dd < bestD) {
            bestD = dd;
            best = k;
          }
        });
        return best;
      };
      const showFocus = () => {
        sc.highlight.clear();
        if (focusK === null) return;
        const idx = order[focusK];
        const lot = layout.lots[idx];
        if (!lot) return;
        sc.highlight.rect(lot.x + 1, lot.y, LOT_W - 2, LOT_H - 1).stroke({ width: 3, color: 0x0b0b0b, alpha: 0.9 });
        const { w, h } = view();
        const cx = sc.root.x + (lot.x + LOT_W / 2) * scale;
        const cy = sc.root.y + (lot.y + LOT_H / 2) * scale;
        const pad = LOT_W * scale;
        if (cx < pad || cx > w - pad || cy < pad || cy > h - pad) {
          sc.root.x = w / 2 - (lot.x + LOT_W / 2) * scale;
          sc.root.y = h / 2 - (lot.y + LOT_H / 2) * scale;
          clampCamera();
        }
        const text = lotText(idx);
        lastHover = text;
        setHover(text);
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === '_') {
          ev.preventDefault();
          ev.stopPropagation();
          zoomAt(view().w / 2, view().h / 2, scale * (ev.key === '+' || ev.key === '=' ? 1.4 : 1 / 1.4));
          showFocus();
          return;
        }
        const cur = focusK ?? nearestToCenter();
        const next = moveFocus(layout, order, cur, ev.key);
        if (next === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (next === 'open') {
          pickCouple.current(world.couples[order[cur]]);
          return;
        }
        focusK = next;
        showFocus();
      };
      const onFocus = () => {
        // A click also focuses the canvas; only keyboard focus draws the focus ring.
        if (!canvas.matches(':focus-visible')) return;
        if (focusK === null) focusK = nearestToCenter();
        showFocus();
      };
      const onBlur = () => {
        sc.highlight.clear();
        lastHover = '';
        setHover('');
      };
      canvas.addEventListener('keydown', onKeyDown);
      canvas.addEventListener('focus', onFocus);
      canvas.addEventListener('blur', onBlur);
      cleanups.push(() => {
        canvas.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('focus', onFocus);
        canvas.removeEventListener('blur', onBlur);
      });
      canvas.style.cursor = 'grab';
      canvas.style.touchAction = 'none';
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointerleave', onLeave);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      cleanups.push(() => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointerleave', onLeave);
        canvas.removeEventListener('wheel', onWheel);
      });
      host.dataset.townReady = '1';
      setReady(true);
    };

    start().catch((err: unknown) => {
      if (disposed) return;
      fallback.current(`the town could not start (${err instanceof Error ? err.message : String(err)})`);
    });

    return () => {
      disposed = true;
      camera.current = null;
      for (const c of cleanups.splice(0)) c();
      delete host.dataset.townReady;
      if (scene) for (const t of scene.owned) t.destroy(true);
      if (app) app.destroy(true, { children: true });
      app = null;
      scene = null;
    };
  }, [agents, layout, world, controlTitle, treatmentTitle]);

  const zoomIn = useCallback(() => camera.current?.zoom(1.4), []);
  const zoomOut = useCallback(() => camera.current?.zoom(1 / 1.4), []);
  const fitAll = useCallback(() => camera.current?.fit(), []);
  const openView = useCallback(() => camera.current?.open(), []);

  return (
    <div className="card town" data-testid="town">
      <div className="town-toolbar" role="group" aria-label="Town camera">
        <button type="button" onClick={zoomIn} disabled={!ready} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={zoomOut} disabled={!ready} aria-label="Zoom out">
          -
        </button>
        <button type="button" onClick={openView} disabled={!ready}>
          Plaza view
        </button>
        <button type="button" onClick={fitAll} disabled={!ready}>
          Whole town
        </button>
        <span className="muted town-hint">Drag to move, scroll to zoom, click a house or a person to open it. With the keyboard, tab into the town and use the arrow keys.</span>
      </div>
      <p className="chart-sub town-hover" aria-live="polite" data-testid="town-hover">
        {hover || (ready ? `${world.couples.length.toLocaleString()} couples and ${(agents?.length ?? 0).toLocaleString()} people. Hover a house or a person for their state today.` : 'Building the town...')}
      </p>
      <div ref={hostRef} className="town-canvas" />
      {rowsNote ? <p className="muted">{rowsNote}</p> : null}
      <TownLegend controlTitle={controlTitle} treatmentTitle={treatmentTitle} />
      <p className="muted town-footnote" data-testid="town-footnote">
        Positions are a layout. The engine has no space, so where a figure stands only shows its state that day, and everything shown is simulated.
      </p>
    </div>
  );
}

function Roof({ left, right }: { left: 'control' | 'treatment'; right: 'control' | 'treatment' }) {
  return (
    <span className="town-roof" aria-hidden="true">
      <img src={`${ASSET}/town/roof-left-${left}.png`} alt="" />
      <img src={`${ASSET}/town/roof-right-${right}.png`} alt="" />
    </span>
  );
}

export function TownLegend({ controlTitle, treatmentTitle }: { controlTitle: string; treatmentTitle: string }) {
  return (
    <div className="town-legend" aria-label="Town legend">
      <span>
        <Roof left="control" right="control" />
        {controlTitle}
      </span>
      <span>
        <Roof left="treatment" right="treatment" />
        {treatmentTitle}
      </span>
      <span>
        <Roof left="control" right="treatment" />
        Remarried, each roof half from where a partner came from
      </span>
      <span>
        <span className="town-marker" aria-hidden="true" />
        In a conflict, both outside and apart
      </span>
      <span>Separated, one partner waits at the plaza edge</span>
      <span>Divorced, the house dims and both walk to the plaza</span>
      <span>Dating again, pairs strolling in the plaza</span>
    </div>
  );
}

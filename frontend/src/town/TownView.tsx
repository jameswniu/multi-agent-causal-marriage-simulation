// The town view of the World page. Every couple is a house and its two agents are figures drawn
// with PixiJS on one canvas. Each day's logged states decide where every figure stands, and the
// walk from one day's place to the next is cosmetic. The engine has no space, so this is a layout
// that shows each agent's state, not a map of where anyone went.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { listCouples } from '../api';
import type { Arm, CoupleRow, LensData, LensMeta, Origin, WorldResponse } from '../types';
import { DIFF_RING, DIFF_RING_PX, RING_WORDS } from '../worldDiff';
import { LENS_EMPTY, cssColor, fmtLens, lensByte, lensColor, meanValue, rampColor } from './lens';
import {
  DISTRICT_COLS,
  LOT_H,
  LOT_W,
  MARGIN,
  TITLE_BAND,
  buildAgents,
  buildLayout,
  chooseDistrictCols,
  dotTint,
  dotWorldSize,
  everMarried,
  townCounts,
  focusOrder,
  hash01,
  houseState,
  lotAt,
  moveFocus,
  placeAgent,
  ringWidth,
  roofsOnly,
  shouldSnap,
  stateWords,
  stepToward,
  walkSpeed,
  type AgentInfo,
  type Posture,
  type Rect,
  type TownLayout,
} from './layout';

type Pixi = typeof import('pixi.js');

// Under the site's base path, which is the root in the live app and /<repository>/ on the read-only demo.
const ASSET = `${import.meta.env.BASE_URL}assets/kenney`;
const PEOPLE = 8;
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
  /** The colour views the server offers, and the one in use (null shows the arm roofs). */
  lenses?: LensMeta[];
  lensName?: string | null;
  lens?: LensData | null;
  lensError?: string | null;
  onLensChange?: (name: string | null) => void;
  onLensRetry?: () => void;
  /** The couple open in the panel beside the town, ringed on the map. */
  selectedCouple?: number | null;
  /** World indices of the couples to ring today: those whose state differs from the world this one is compared with. Null draws no rings and no ring key. */
  rings?: number[] | null;
  /** Whose couples table to read when `world` is not the experiment in the URL (the world a fork came from). */
  experiment?: string | null;
  /** Called each time the town has been built and is drawing. */
  onReady?: () => void;
  /**
   * The district a phone opens on, when the page picks one: the read-only demo opens a shock that reaches only
   * the treatment arm on that district, where its rings are, and keeps the district on screen when the town
   * draws the other world. Left out, a phone opens on control and every rebuild returns there.
   */
  phoneDistrict?: District | null;
}

/** Below this host width the town shows one district at a time with a switch. */
export const PHONE_MAX_PX = 600;
const MINI_W = 200;
export type District = 'control' | 'plaza' | 'treatment';

/** Mini-map colour of a state letter, the same colours the town's dots use (remarried couples purple). */
export function miniColor(ch: string, arm: Arm | null, origin: Origin | null): string | null {
  switch (ch) {
    case 'M':
      return cssColor(dotTint('home', arm, origin));
    case 'C':
      return cssColor(dotTint('conflict', arm, origin));
    case 'S':
      return cssColor(dotTint('away', arm, origin));
    case 'D':
      return '#898781';
    case 'T':
      return '#1baf7a';
    case 'B':
      return '#c9c8c0';
    default:
      return null;
  }
}

const POSTURE_CODE: Record<Posture, number> = { home: 0, conflict: 1, away: 2, single: 3, dating: 4 };

interface Scene {
  root: Container;
  houses: (Sprite | null)[];
  /** Each house's own roof texture, restored when the lens is turned off. */
  houseBase: (Texture | null)[];
  /** A plain white house, tinted by the lens colour. */
  plainHouse: Texture;
  /** Rings around the houses that differ from the compared world, drawn over the houses and under the people. */
  rings: Graphics;
  selection: Graphics;
  markers: (Sprite | null)[];
  figures: Sprite[];
  /** Each figure's own person sprite, swapped for the dot when people are drawn as dots. */
  personTex: Texture[];
  dot: Texture;
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

  // District titles, counts and the plaza label are HTML over the canvas (see TownLabels), so they
  // stay readable at every zoom; `titles` is kept for the caller's signature.
  void titles;

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
  const rings = new PIXI.Graphics();
  root.addChild(rings);

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
  const personTex = agents.map((a) => tex[`person-${Math.floor(hash01(Math.abs(a.id), 7) * PEOPLE)}`]);
  const figures = agents.map((_, i) => {
    const s = new PIXI.Sprite(personTex[i]);
    s.anchor.set(0.5, 1);
    figureLayer.addChild(s);
    return s;
  });
  // A white dot with a dark rim, tinted per person, for zoom levels where the sprites are too small.
  const dotG = new PIXI.Graphics();
  dotG.circle(8, 8, 7).fill(0xffffff).stroke({ width: 2, color: 0x1a1a1a });
  const dot = app.renderer.generateTexture({ target: dotG, resolution: 4, antialias: true });
  owned.push(dot);
  dotG.destroy();
  root.addChild(figureLayer);
  root.addChild(markerLayer);

  const highlight = new PIXI.Graphics();
  root.addChild(highlight);

  // A plain house for the colour views: white roof and walls, so a tint shows the lens colour.
  const plainG = new PIXI.Graphics();
  plainG.rect(0, 2, 32, 14).fill(0xffffff).stroke({ width: 1, color: 0x4a4a4a });
  plainG.poly([0, 6, 16, 0, 32, 6]).fill(0xffffff).stroke({ width: 1, color: 0x4a4a4a });
  plainG.rect(0, 16, 32, 16).fill(0xe8e8e8).stroke({ width: 1, color: 0x4a4a4a });
  plainG.rect(19, 21, 7, 11).fill(0x8a8a8a);
  plainG.rect(5, 21, 7, 6).fill(0xb8b8b8);
  const plainHouse = app.renderer.generateTexture({ target: plainG, resolution: 2, antialias: false });
  owned.push(plainHouse);
  plainG.destroy();
  const houseBase = houses.map((h) => (h ? h.texture : null));

  const selection = new PIXI.Graphics();
  root.addChild(selection);

  return {
    root,
    houses,
    houseBase,
    plainHouse,
    rings,
    selection,
    markers,
    figures,
    personTex,
    dot,
    figureLayer,
    markerLayer,
    highlight,
    owned,
    allTextures: [...Object.values(tex), ...owned],
  };
}

export default function TownView({
  world,
  day,
  speed,
  controlTitle,
  treatmentTitle,
  onPickCouple,
  onPickAgent,
  onFallback,
  lenses = [],
  lensName = null,
  lens = null,
  lensError = null,
  onLensChange,
  onLensRetry,
  selectedCouple = null,
  rings = null,
  experiment = null,
  onReady,
  phoneDistrict = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<LensData | null>(lens);
  const selectedRef = useRef<number | null>(selectedCouple);
  const ringsRef = useRef<number[] | null>(rings);
  const dirtyRef = useRef(true);
  // New rings only redraw the rings and the mini-map, not every figure.
  const ringsDirtyRef = useRef(true);
  const [narrow, setNarrow] = useState(false);
  const [district, setDistrict] = useState<District>(phoneDistrict ?? 'control');
  // The district on a phone's screen. When the page picked where a phone opens, a rebuild (the town drawing
  // the other world) stays on it; otherwise a rebuild opens on control, as it always has.
  const districtRef = useRef<District>(phoneDistrict ?? 'control');
  const keepDistrictRef = useRef(phoneDistrict !== null);
  // The couples table belongs to one world, so each world drawn in this town keeps its own: a table
  // read for another world is never used for this one, and flipping back to a world rebuilds at once.
  const [rowsBy, setRowsBy] = useState<Map<WorldResponse, { rows: CoupleRow[]; note: string | null }>>(() => new Map());
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState('');
  const dayRef = useRef(day);
  const speedRef = useRef(speed);
  const pickCouple = useRef(onPickCouple);
  const pickAgent = useRef(onPickAgent);
  const fallback = useRef(onFallback);
  const readyRef = useRef(onReady);
  const camera = useRef<{ fit: () => void; zoom: (f: number) => void; focusDistrict: (d: District) => void } | null>(null);
  // Where the camera stood, so switching the world drawn (this one or the one it came from) keeps the view.
  const savedCamera = useRef<{ scale: number; x: number; y: number; cols: number } | null>(null);

  useEffect(() => {
    lensRef.current = lens && lensName && lens.name === lensName ? lens : null;
    dirtyRef.current = true;
  }, [lens, lensName]);
  useEffect(() => {
    selectedRef.current = selectedCouple;
    dirtyRef.current = true;
  }, [selectedCouple]);
  useEffect(() => {
    ringsRef.current = rings;
    ringsDirtyRef.current = true;
  }, [rings]);
  // A page that picks another opening district later moves a phone there too.
  useEffect(() => {
    keepDistrictRef.current = phoneDistrict !== null;
    if (phoneDistrict === null || districtRef.current === phoneDistrict) return;
    districtRef.current = phoneDistrict;
    setDistrict(phoneDistrict);
    const host = hostRef.current;
    if (host && host.clientWidth > 0 && host.clientWidth < PHONE_MAX_PX) camera.current?.focusDistrict(phoneDistrict);
  }, [phoneDistrict]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(host.clientWidth > 0 && host.clientWidth < PHONE_MAX_PX));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

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
    readyRef.current = onReady;
  }, [onPickCouple, onPickAgent, onFallback, onReady]);

  const rowsEntry = rowsBy.get(world) ?? null;
  const haveRows = rowsEntry !== null;
  useEffect(() => {
    if (haveRows) return;
    let cancelled = false;
    let settled = false;
    const keep = (rows: CoupleRow[], note: string | null) => {
      if (cancelled || settled) return;
      settled = true;
      setRowsBy((prev) => new Map(prev).set(world, { rows, note }));
    };
    const standIns = (why: string) => keep([], `${why}, so each couple's two people are drawn as stand-ins and a divorced agent is not followed into a new couple.`);
    const timer = window.setTimeout(() => standIns(`The couples table did not arrive within ${COUPLES_TIMEOUT_MS / 1000} seconds`), COUPLES_TIMEOUT_MS);
    listCouples({ limit: 10000 }, experiment).then(
      (r) => keep(r.items, null),
      (err: unknown) => standIns(`Could not load the couples table (${err instanceof Error ? err.message : String(err)})`),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [world, experiment, haveRows]);
  const rows = rowsEntry ? rowsEntry.rows : null;
  const rowsNote = rowsEntry ? rowsEntry.note : null;

  // Columns per district follow the canvas shape, so a wide window gets a wide town that fills it.
  const homes = useMemo(() => everMarried(world), [world]);
  const counts = useMemo(() => townCounts(world, homes), [world, homes]);
  const [cols, setCols] = useState<number | null>(() => (typeof ResizeObserver === 'undefined' ? DISTRICT_COLS : null));
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      const c = w > 0 && h > 0 ? chooseDistrictCols(counts.nDistrict, counts.nHomes, w, h) : DISTRICT_COLS;
      setCols((prev) => (prev === c ? prev : c));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [counts]);
  const layout = useMemo(() => buildLayout(world, homes, cols ?? DISTRICT_COLS), [world, homes, cols]);
  const agents = useMemo(() => (rows === null ? null : buildAgents(world, rows)), [world, rows]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !agents || cols === null) return;
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

      // Camera: pan, zoom about a point, and the whole town, which is the opening view.
      let scale = 1;
      // The rings keep their width on screen, so a new zoom draws them again.
      let ringsStale = true;
      let nearest: boolean | null = null;
      let dotMode: boolean | null = null;
      let onCamera = () => {};
      const n = agents.length;
      const tints = new Uint32Array(n).fill(0x3b3b3b);
      // People are never hidden: when the sprites would be too small, each person is a dot in the
      // colour of their state, and dots walk exactly as the figures do.
      const swapFigures = () => {
        for (let i = 0; i < n; i++) {
          const f = sc.figures[i];
          if (dotMode) {
            f.texture = sc.dot;
            f.anchor.set(0.5, 0.5);
            f.tint = tints[i];
          } else {
            f.texture = sc.personTex[i];
            f.anchor.set(0.5, 1);
            f.tint = 0xffffff;
            f.scale.set(1);
          }
        }
      };
      const view = () => ({ w: theApp.screen.width, h: theApp.screen.height });
      const clampCamera = () => {
        const { w, h } = view();
        const tw = layout.width * scale;
        const th = layout.height * scale;
        sc.root.x = tw <= w ? (w - tw) / 2 : Math.min(w * 0.08, Math.max(w * 0.92 - tw, sc.root.x));
        sc.root.y = th <= h ? (h - th) / 2 : Math.min(h * 0.08, Math.max(h * 0.92 - th, sc.root.y));
        savedCamera.current = { scale, x: sc.root.x, y: sc.root.y, cols: layout.districtCols };
        onCamera();
      };
      const applyScale = (s: number) => {
        scale = s;
        ringsStale = true;
        sc.root.scale.set(s);
        const dots = roofsOnly(s);
        sc.markerLayer.visible = !dots;
        if (dots !== dotMode) {
          dotMode = dots;
          swapFigures();
        }
        if (dots) {
          const k = dotWorldSize(s, 7) / 16;
          for (const f of sc.figures) f.scale.set(k);
        }
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
      const districtRect = (d: District): Rect => (d === 'control' ? layout.control : d === 'treatment' ? layout.treatment : layout.plaza);
      // A phone shows one district at a time: fit its width and keep its title in view.
      const focusDistrict = (d: District) => {
        const r = districtRect(d);
        const { w } = view();
        const s = Math.min(MAX_SCALE, Math.max(minScale(), (w - 16) / (r.w + 24)));
        applyScale(s);
        sc.root.x = 8 - (r.x - 12) * s;
        sc.root.y = 4 - (r.y - TITLE_BAND) * s;
        clampCamera();
      };
      camera.current = { fit, zoom: (f: number) => zoomAt(view().w / 2, view().h / 2, scale * f), focusDistrict };

      // Labels: district titles, counts and the plaza, as HTML over the canvas at a fixed size.
      const labelBox = document.createElement('div');
      labelBox.className = 'town-labels';
      labelBox.setAttribute('aria-hidden', 'true');
      const makeLabel = (cls: string, title: string, sub: string) => {
        const el = document.createElement('div');
        el.className = `town-label ${cls}`;
        const strong = document.createElement('strong');
        strong.textContent = title;
        const span = document.createElement('span');
        span.textContent = sub;
        el.append(strong, span);
        labelBox.appendChild(el);
        return { el, span };
      };
      const lControl = makeLabel('town-label-end', controlTitle, `${layout.order.control.length.toLocaleString()} couples`);
      const lPlaza = makeLabel('town-label-mid', 'Plaza', 'singles, dating, new homes');
      const lTreatment = makeLabel('town-label-start', treatmentTitle, `${layout.order.treatment.length.toLocaleString()} couples`);
      host.appendChild(labelBox);
      cleanups.push(() => labelBox.remove());
      const placeLabels = () => {
        const top = Math.max(4, sc.root.y + (MARGIN + 6) * scale);
        // A long title (an arm with shocks in its name) stops at its district's edge instead of running off the canvas.
        lControl.el.style.maxWidth = `${Math.max(120, layout.control.w * scale).toFixed(0)}px`;
        lTreatment.el.style.maxWidth = `${Math.max(120, layout.treatment.w * scale).toFixed(0)}px`;
        lControl.el.style.transform = `translate(${(sc.root.x + (layout.control.x + layout.control.w) * scale).toFixed(1)}px, ${top.toFixed(1)}px) translateX(-100%)`;
        lTreatment.el.style.transform = `translate(${(sc.root.x + layout.treatment.x * scale).toFixed(1)}px, ${top.toFixed(1)}px)`;
        lPlaza.el.style.transform = `translate(${(sc.root.x + (layout.plaza.x + layout.plaza.w / 2) * scale).toFixed(1)}px, ${top.toFixed(1)}px) translateX(-50%)`;
        lPlaza.span.style.display = layout.plaza.w * scale < 200 ? 'none' : '';
      };

      // The couple open in the side panel gets a ring around its lot.
      const indexOfCouple = new Map<number, number>();
      world.couples.forEach((cid, idx) => indexOfCouple.set(cid, idx));
      const drawSelection = () => {
        sc.selection.clear();
        const sel = selectedRef.current;
        const idx = sel === null ? undefined : indexOfCouple.get(sel);
        const lot = idx === undefined ? undefined : layout.lots[idx];
        if (!lot) return;
        sc.selection.roundRect(lot.x - 2, lot.y - 3, LOT_W + 4, LOT_H + 4, 7).stroke({ width: 4, color: 0x0b0b0b, alpha: 0.9 });
        sc.selection.roundRect(lot.x, lot.y - 1, LOT_W, LOT_H, 6).stroke({ width: 2, color: 0xffffff, alpha: 0.95 });
      };

      // Every couple that differs from the compared world today gets a ring around its house, a few
      // screen pixels wide at any zoom so it still reads with the whole town in view.
      const drawRings = () => {
        sc.rings.clear();
        const list = ringsRef.current;
        if (!list || !list.length) return;
        const width = ringWidth(scale, DIFF_RING_PX);
        for (const idx of list) {
          const lot = layout.lots[idx];
          if (!lot) continue;
          sc.rings.roundRect(lot.x + 3, lot.y + 1, LOT_W - 6, LOT_H - 8, 7);
        }
        sc.rings.stroke({ width, color: DIFF_RING, alpha: 0.95 });
      };

      // Mini-map: every lot as a small tile in its state (or lens) colour, and a box for the view.
      const k = MINI_W / layout.width;
      const miniH = Math.max(40, Math.round(layout.height * k));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const mini = document.createElement('canvas');
      mini.className = 'town-mini';
      mini.width = Math.round(MINI_W * dpr);
      mini.height = Math.round(miniH * dpr);
      mini.style.width = `${MINI_W}px`;
      mini.style.height = `${miniH}px`;
      mini.setAttribute('role', 'img');
      mini.setAttribute('aria-label', 'Map of the whole town. The box shows what the view covers, and a click on the map moves the view there.');
      mini.dataset.testid = 'town-mini';
      host.appendChild(mini);
      const mctx = mini.getContext('2d');
      const drawMini = () => {
        if (!mctx) return;
        const d = Math.min(Math.max(0, dayRef.current), world.states.length - 1);
        const states = world.states[d] ?? '';
        const lensNow = lensRef.current;
        mctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
        mctx.fillStyle = '#7cc576';
        mctx.fillRect(0, 0, layout.width, layout.height);
        mctx.fillStyle = '#f5a05e';
        mctx.fillRect(layout.plaza.x, layout.plaza.y, layout.plaza.w, layout.plaza.h);
        world.couples.forEach((_, idx) => {
          const lot = layout.lots[idx];
          if (!lot) return;
          const ch = states[idx] ?? '-';
          if (ch === '-') return;
          const color = lensNow ? cssColor(lensColor(lensByte(lensNow, d, idx), lensNow.worseHigh)) : miniColor(ch, world.arms[idx], world.origin[idx]);
          if (!color) return;
          mctx.fillStyle = color;
          mctx.fillRect(lot.x + 4, lot.y + 4, LOT_W - 8, LOT_H - 10);
        });
        const ringed = ringsRef.current;
        if (ringed && ringed.length) {
          mctx.strokeStyle = cssColor(DIFF_RING);
          mctx.lineWidth = 1.5 / k;
          for (const idx of ringed) {
            const lot = layout.lots[idx];
            if (lot) mctx.strokeRect(lot.x + 2, lot.y + 2, LOT_W - 4, LOT_H - 6);
          }
        }
        const { w, h } = view();
        mctx.strokeStyle = '#0b0b0b';
        mctx.lineWidth = 2 / k;
        mctx.strokeRect(-sc.root.x / scale, -sc.root.y / scale, w / scale, h / scale);
      };
      onCamera = () => {
        placeLabels();
        drawMini();
      };
      const onMini = (ev: MouseEvent) => {
        const r = mini.getBoundingClientRect();
        const wx = (ev.clientX - r.left) / k;
        const wy = (ev.clientY - r.top) / k;
        const { w, h } = view();
        sc.root.x = w / 2 - wx * scale;
        sc.root.y = h / 2 - wy * scale;
        clampCamera();
      };
      mini.addEventListener('click', onMini);
      cleanups.push(() => {
        mini.removeEventListener('click', onMini);
        mini.remove();
      });

      // A resize that keeps the same columns still moves the canvas edges: re-clamp the camera,
      // which also repositions the labels.
      const onResize = () => clampCamera();
      theApp.renderer.on('resize', onResize);
      cleanups.push(() => theApp.renderer.off('resize', onResize));

      // Open on the whole town, or on one district on a phone. When only the world drawn changed (this
      // one or the one it came from), the camera stays where it was.
      const kept = savedCamera.current;
      if (host.clientWidth > 0 && host.clientWidth < PHONE_MAX_PX) focusDistrict(keepDistrictRef.current ? districtRef.current : 'control');
      else if (kept && kept.cols === layout.districtCols) {
        applyScale(Math.min(MAX_SCALE, Math.max(minScale(), kept.scale)));
        sc.root.x = kept.x;
        sc.root.y = kept.y;
        clampCamera();
      } else fit();

      // Figures: targets come from the day's states; positions walk toward them each frame.
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
          tints[i] = dotTint(p.posture, p.couple === null ? null : (world.arms[p.couple] ?? null), p.couple === null ? null : (world.origin[p.couple] ?? null));
          if (dotMode) sc.figures[i].tint = tints[i];
        }
        const lensNow = lensRef.current;
        world.couples.forEach((_, idx) => {
          const st = houseState(states[idx] ?? '-', world.origin[idx]);
          const h = sc.houses[idx];
          if (h) {
            h.visible = st.visible;
            if (lensNow) {
              if (h.texture !== sc.plainHouse) h.texture = sc.plainHouse;
              h.tint = lensColor(lensByte(lensNow, d, idx), lensNow.worseHigh);
              h.alpha = st.dim ? 0.55 : 1;
            } else {
              const base = sc.houseBase[idx];
              if (base && h.texture !== base) h.texture = base;
              h.alpha = st.dim ? 0.45 : 1;
              h.tint = st.dim ? 0x9a9a9a : 0xffffff;
            }
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
        if (d !== lastDay || dirtyRef.current) {
          if (d !== lastDay) snapFrame = snapFrame || shouldSnap(lastDay, d, sp);
          retarget(d);
          lastDay = d;
          dirtyRef.current = false;
          ringsStale = true;
          drawSelection();
          drawMini();
        }
        if (ringsDirtyRef.current) {
          ringsDirtyRef.current = false;
          ringsStale = true;
          drawMini();
        }
        if (ringsStale) {
          ringsStale = false;
          drawRings();
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
          if (dotMode) {
            s.position.set(x[i], y[i] - 6);
          } else {
            const bob = moving ? Math.abs(Math.sin(now * 14 + phase[i])) * 1.5 : 0;
            s.position.set(x[i], y[i] - bob);
            s.scale.x = facing[i];
          }
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
        let best: number | null = null;
        let bestD = dotMode ? Math.max(8, dotWorldSize(scale, 5)) : 8;
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
        // A figure that belongs to a couple opens that couple's panel; a single opens the agent.
        if (info.couple !== null) pickCouple.current(info.couple);
        else if (info.agent !== null) pickAgent.current(info.agent);
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
      readyRef.current?.();
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
  }, [agents, layout, world, controlTitle, treatmentTitle, cols]);

  const pickDistrict = useCallback((d: District) => {
    districtRef.current = d;
    setDistrict(d);
    camera.current?.focusDistrict(d);
  }, []);
  useEffect(() => {
    if (narrow && ready) camera.current?.focusDistrict(district);
    // Only when the layout switches to the phone view or the town becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, ready]);
  const activeLens = lens && lensName && lens.name === lensName ? lens : null;
  const lensMeta = lensName ? lenses.find((l) => l.name === lensName) ?? null : null;
  const zoomIn = useCallback(() => camera.current?.zoom(1.4), []);
  const zoomOut = useCallback(() => camera.current?.zoom(1 / 1.4), []);
  const fitAll = useCallback(() => camera.current?.fit(), []);

  return (
    <div className="card town" data-testid="town">
      <div className="town-toolbar" role="group" aria-label="Town camera">
        <button type="button" onClick={zoomIn} disabled={!ready} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={zoomOut} disabled={!ready} aria-label="Zoom out">
          -
        </button>
        <button type="button" onClick={fitAll} disabled={!ready}>
          Whole town
        </button>
        {lenses.length && onLensChange ? (
          <label className="town-lens">
            Colour houses by
            <select value={lensName ?? ''} onChange={(e) => onLensChange(e.target.value || null)} aria-label="Colour houses by" data-testid="lens-select">
              <option value="">Arm (roof colours)</option>
              {lenses.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="muted town-hint">Drag to move, scroll to zoom, click a house or a person to open it. With the keyboard, tab into the town and use the arrow keys.</span>
      </div>
      <p className="chart-sub town-hover" aria-live="polite" data-testid="town-hover">
        {hover || (ready ? `${world.couples.length.toLocaleString()} couples and ${(agents?.length ?? 0).toLocaleString()} people. Hover a house or a person for their state today.` : 'Building the town...')}
      </p>
      {narrow ? (
        <div className="segmented town-districts" role="group" aria-label="District">
          {(['control', 'plaza', 'treatment'] as District[]).map((d) => (
            <button key={d} type="button" onClick={() => pickDistrict(d)} aria-pressed={district === d} disabled={!ready}>
              {d === 'control' ? controlTitle : d === 'treatment' ? treatmentTitle : 'Plaza'}
            </button>
          ))}
        </div>
      ) : null}
      <div ref={hostRef} className="town-canvas" />
      {lensMeta ? (
        <LensKey meta={lensMeta} data={activeLens} error={lensError} onRetry={onLensRetry} day={day} world={world} controlTitle={controlTitle} treatmentTitle={treatmentTitle} />
      ) : null}
      {rowsNote ? <p className="muted">{rowsNote}</p> : null}
      <TownLegend controlTitle={controlTitle} treatmentTitle={treatmentTitle} ringed={rings !== null} />
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

export function TownLegend({ controlTitle, treatmentTitle, ringed = false }: { controlTitle: string; treatmentTitle: string; ringed?: boolean }) {
  return (
    <div className="town-legend" aria-label="Town legend">
      {ringed ? (
        <span data-testid="ring-key">
          <span className="diff-ring-key" aria-hidden="true" />
          {RING_WORDS}
        </span>
      ) : null}
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
      <span>Zoomed far out, each person is a dot: their arm colour at home, yellow in a conflict, red when one has walked out, grey in the plaza</span>
    </div>
  );
}

/** The key under the town while a lens is on: what the colour means, its range, and each arm's average today. */
function LensKey({
  meta,
  data,
  error,
  onRetry,
  day,
  world,
  controlTitle,
  treatmentTitle,
}: {
  meta: LensMeta;
  data: LensData | null;
  error: string | null;
  onRetry?: () => void;
  day: number;
  world: WorldResponse;
  controlTitle: string;
  treatmentTitle: string;
}) {
  const groups = useMemo(() => {
    const control: number[] = [];
    const treatment: number[] = [];
    world.couples.forEach((_, i) => {
      if (world.origin[i] === 'remarriage') return;
      (world.arms[i] === 'treatment' ? treatment : control).push(i);
    });
    return { control, treatment };
  }, [world]);
  const lowWord = meta.higher_is_worse ? 'green is low' : 'green is high';
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${cssColor(rampColor(t))} ${t * 100}%`).join(', ');
  const c = data ? meanValue(data, day, groups.control) : null;
  const t = data ? meanValue(data, day, groups.treatment) : null;
  return (
    <div className="lens-key" data-testid="lens-key">
      <p>
        <strong>{meta.label}</strong>: {meta.words}. Each house shows its couple on this day, {lowWord} and red is the bad end. A grey house has no couple that day.
      </p>
      <div className="lens-ramp">
        <span>{fmtLens(meta.higher_is_worse ? meta.lo : meta.hi, meta.hi)}</span>
        <span className="lens-bar" style={{ background: `linear-gradient(to right, ${stops})` }} aria-hidden="true" />
        <span>{fmtLens(meta.higher_is_worse ? meta.hi : meta.lo, meta.hi)}</span>
        <span className="lens-empty" style={{ background: cssColor(LENS_EMPTY) }} aria-hidden="true" />
        <span className="muted">no couple</span>
      </div>
      {error ? (
        <div className="status error" role="alert">
          Could not load this view: {error}
          {onRetry ? (
            <div>
              <button type="button" onClick={onRetry}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      ) : !data ? (
        <p className="muted">Loading the colours...</p>
      ) : (
        <p data-testid="lens-means">
          Average today: {controlTitle} {c === null ? 'none' : fmtLens(c, meta.hi)}, {treatmentTitle} {t === null ? 'none' : fmtLens(t, meta.hi)}.
        </p>
      )}
    </div>
  );
}

#!/usr/bin/env bun
/**
 * Pixel-art asset source of truth for Agent Mission Control.
 *
 *   bun apps/web/public/assets/_src/make.ts
 *
 * Every asset is authored as a character grid (one char = one pixel, see
 * PALETTE). A few (emblem, stamp, spinner) are painted procedurally into a
 * grid because circles by hand at 24-32px are a great way to lose an
 * afternoon. Either way the grid is the artwork; the SVG/PNG files next to
 * this script are build output and should not be hand-edited.
 *
 * Output per asset: <name>.svg (one <path> per colour, crispEdges) and
 * <name>.png at 8x nearest-neighbour. Sheets are emitted the same way.
 * PNGs are written by a tiny inline encoder (zlib from node, CRC32 here) so
 * the repo has zero image dependencies.
 *
 * Conventions:
 *  - Transparent background everywhere ('.').
 *  - 1px outline in `k` (#1a1a1f) on sprites so they read on any bezel.
 *  - Crew sprites use ONLY greys 1/2/3 + k so the UI can palette-swap them
 *    per persona (see crew.json).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dir, ".."); // apps/web/public/assets
const PUBLIC = join(OUT, ".."); // apps/web/public
const SCALE = 8;

// ───────────────────────────────────────────────────────────────────────────
// Palette (matches packages/shared PersonaColor keys + UI phosphor tokens)
// ───────────────────────────────────────────────────────────────────────────

const PALETTE: Record<string, string | null> = {
  ".": null, // transparent
  k: "#1a1a1f", // outline
  s: "#0d1a12", // dark screen / seal interior
  a: "#ffb000", // amber
  A: "#a86f00", // amber shade
  g: "#33ff66", // green
  G: "#1c9c3f", // green shade
  h: "#c8ffd8", // green highlight (phosphor bloom)
  c: "#33e0ff", // cyan
  m: "#ff4fd8", // magenta
  r: "#ff3b3b", // red
  R: "#8a1f1f", // red shade / lamp off
  b: "#4f7cff", // blue
  w: "#f4f4f0", // near-white
  "1": "#d4d4dc", // grey light  (crew: face)
  "2": "#8c8c98", // grey mid    (crew: hair / gear)
  "3": "#4c4c58", // grey dark   (crew: shirt / cups)
};

// ───────────────────────────────────────────────────────────────────────────
// Grid helpers
// ───────────────────────────────────────────────────────────────────────────

type Grid = string[];

const W = (g: Grid) => g[0].length;
const H = (g: Grid) => g.length;

function grid(name: string, rows: string[], w: number, h: number): Grid {
  if (rows.length !== h) throw new Error(`${name}: expected ${h} rows, got ${rows.length}`);
  rows.forEach((r, i) => {
    if (r.length !== w) throw new Error(`${name}: row ${i} is ${r.length} wide, expected ${w}`);
  });
  return [...rows];
}

const blank = (w: number, h: number): Grid => Array.from({ length: h }, () => ".".repeat(w));

function get(g: Grid, x: number, y: number): string {
  return g[y]?.[x] ?? ".";
}

function set(g: Grid, x: number, y: number, ch: string) {
  if (y < 0 || y >= H(g) || x < 0 || x >= W(g)) return;
  g[y] = g[y].slice(0, x) + ch + g[y].slice(x + 1);
}

/** Replace characters via a map; unmapped chars pass through. */
function remap(g: Grid, map: Record<string, string>): Grid {
  return g.map((row) => [...row].map((c) => map[c] ?? c).join(""));
}

/** Paste src onto dst at (ox, oy); '.' in src is transparent. */
function blit(dst: Grid, src: Grid, ox: number, oy: number) {
  for (let y = 0; y < H(src); y++)
    for (let x = 0; x < W(src); x++) {
      const c = src[y][x];
      if (c !== ".") set(dst, ox + x, oy + y, c);
    }
}

/** Shift a grid by (dx, dy), dropping anything that falls off. */
function shift(g: Grid, dx: number, dy: number): Grid {
  const out = blank(W(g), H(g));
  blit(out, g, dx, dy);
  return out;
}

/** Add a 1px `k` outline around every opaque pixel (4-neighbour). Clipped at edges. */
function outline(g: Grid): Grid {
  const out = [...g];
  for (let y = 0; y < H(g); y++)
    for (let x = 0; x < W(g); x++) {
      if (get(g, x, y) !== ".") continue;
      const near = [get(g, x - 1, y), get(g, x + 1, y), get(g, x, y - 1), get(g, x, y + 1)];
      if (near.some((c) => c !== "." && c !== "k")) set(out, x, y, "k");
    }
  return out;
}

/** Lay frames out left-to-right, wrapping after `cols`. All frames must share a size. */
function sheet(frames: Grid[], cols: number): Grid {
  const fw = W(frames[0]);
  const fh = H(frames[0]);
  const rows = Math.ceil(frames.length / cols);
  const out = blank(fw * cols, fh * rows);
  frames.forEach((f, i) => {
    blit(out, f, (i % cols) * fw, Math.floor(i / cols) * fh);
  });
  return out;
}

/** Bresenham line, painting a callback per pixel. */
function line(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  paint: (x: number, y: number) => void,
) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    paint(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Encoders
// ───────────────────────────────────────────────────────────────────────────

function toSvg(g: Grid, title?: string): string {
  // One <path> per colour; each pixel run becomes "M x y h w v 1 h -w z".
  const byColour = new Map<string, string[]>();
  for (let y = 0; y < H(g); y++) {
    let x = 0;
    while (x < W(g)) {
      const ch = g[y][x];
      const fill = PALETTE[ch];
      if (fill === undefined) throw new Error(`unknown palette char '${ch}'`);
      let run = 1;
      while (x + run < W(g) && g[y][x + run] === ch) run++;
      if (fill) {
        if (!byColour.has(fill)) byColour.set(fill, []);
        byColour.get(fill)?.push(`M${x} ${y}h${run}v1h-${run}z`);
      }
      x += run;
    }
  }
  const paths = [...byColour]
    .map(([fill, d]) => `<path fill="${fill}" d="${d.join("")}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W(g)} ${H(g)}" width="${W(g)}" height="${H(g)}" shape-rendering="crispEdges">${title ? `<title>${title}</title>` : ""}${paths}</svg>\n`;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toPng(g: Grid, scale: number): Uint8Array {
  const w = W(g) * scale;
  const h = H(g) * scale;
  const stride = w * 4 + 1; // +1 filter byte per scanline
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const fill = PALETTE[g[Math.floor(y / scale)][Math.floor(x / scale)]];
      if (!fill) continue; // stays 0,0,0,0 = transparent
      const [r, gg, b] = hexToRgb(fill);
      raw.set([r, gg, b, 255], row + 1 + x * 4);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, no filter method, no interlace
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

interface Emitted {
  file: string;
  w: number;
  h: number;
}
const manifest: Record<string, Emitted & { scale: number }> = {};

function emit(name: string, g: Grid, opts: { scale?: number; dir?: string; svg?: boolean } = {}) {
  const dir = opts.dir ?? OUT;
  const scale = opts.scale ?? SCALE;
  mkdirSync(dir, { recursive: true });
  if (opts.svg !== false) writeFileSync(join(dir, `${name}.svg`), toSvg(g));
  writeFileSync(join(dir, `${name}.png`), toPng(g, scale));
  manifest[name] = { file: `${name}.png`, w: W(g), h: H(g), scale };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Favicon (16x16): CRT monitor, amber V antenna, green blip, amber cursor
// ───────────────────────────────────────────────────────────────────────────

const favicon = grid(
  "favicon",
  [
    "....a......a....",
    "....a......a....",
    ".....a....a.....",
    "......aaaa......",
    ".kkkkkkkkkkkkkk.",
    "k22222222222222k",
    "k2kkkkkkkkkkkk2k",
    "k2kssssssssssk2k",
    "k2kssssssssssk2k",
    "k2kssssggsssak2k",
    "k2kssssggssssk2k",
    "k2kssssssssssk2k",
    "k2kkkkkkkkkkkk2k",
    "k22222222222222k",
    ".kkkkkkkkkkkkkk.",
    "....kk3333kk....",
  ],
  16,
  16,
);

// ───────────────────────────────────────────────────────────────────────────
// 2. Emblem (24x24): satellite dish with feed horn and two signal arcs
// ───────────────────────────────────────────────────────────────────────────

function emblem(signal: string): Grid {
  const g = blank(24, 24);
  // Reflector = ellipse rotated 45deg (long axis NW-SE) so the face tilts toward
  // NE. Rim in amber, dished interior in dark amber.
  const C = { x: 10, y: 13 };
  const ell = (x: number, y: number, a: number, b: number) => {
    const dx = x + 0.5 - C.x;
    const dy = y + 0.5 - C.y;
    const u = (dx + dy) * Math.SQRT1_2; // along SE
    const v = (dy - dx) * Math.SQRT1_2; // along SW
    return (u / a) ** 2 + (v / b) ** 2 <= 1;
  };
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      if (ell(x, y, 9, 5)) set(g, x, y, "a");
      if (ell(x, y, 7, 3.2)) set(g, x, y, "A");
    }
  // Feed strut from the dish centre out to the horn at the focus.
  line(9, 13, 14, 8, (x, y) => {
    set(g, x, y, "a");
    set(g, x + 1, y, "a"); // 2px wide so it survives on top of the dark interior
  });
  for (const [x, y] of [
    [15, 7],
    [16, 7],
    [15, 8],
    [16, 8],
  ])
    set(g, x, y, "a");
  // Pedestal.
  for (const [x, y] of [
    [12, 20],
    [13, 20],
    [12, 21],
    [13, 21],
  ])
    set(g, x, y, "a");
  for (let x = 8; x <= 17; x++) set(g, x, 22, "a");
  const out = outline(g);
  // Signal arcs (1px, NE quadrant) centred on the horn. Painted after
  // outlining on purpose: a dark halo around a 1px glow line just muddies it.
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      const dx = x - 15.5;
      const dy = y - 7.5;
      const d = Math.hypot(dx, dy);
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (deg >= -82 && deg <= -8 && (Math.abs(d - 3.5) < 0.71 || Math.abs(d - 6.5) < 0.71))
        set(out, x, y, signal);
    }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Warning lamp (16x16 x4): rotating beacon. D dome, H glint, S shade, C core
// ───────────────────────────────────────────────────────────────────────────

const lampBase = grid(
  "lamp",
  [
    "................",
    "................",
    "......kkkk......",
    "....kkDDDDkk....",
    "...kDHHDDDDDk...",
    "..kDHHDDDDDDSk..",
    "..kDDDDCCDDDSk..",
    "..kDDDDCCDDDSk..",
    "..kDDDDDDDDSSk..",
    "..kSDDDDDDSSSk..",
    ".kkkkkkkkkkkkkk.",
    ".k222222222222k.",
    ".k333333333333k.",
    ".kkkkkkkkkkkkkk.",
    "...k33333333k...",
    "...kkkkkkkkkk...",
  ],
  16,
  16,
);

const lampRays: [number, number][] = [
  [7, 0],
  [8, 0],
  [1, 1],
  [2, 2],
  [14, 1],
  [13, 2],
  [0, 6],
  [0, 7],
  [15, 6],
  [15, 7],
];

const lampFrames: Record<string, Grid> = {
  off: remap(lampBase, { D: "R", H: "2", S: "R", C: "R" }),
  dim: remap(lampBase, { D: "R", H: "r", S: "R", C: "r" }),
  bright: remap(lampBase, { D: "r", H: "w", S: "R", C: "w" }),
  rays: (() => {
    const g = remap(lampBase, { D: "r", H: "w", S: "R", C: "w" });
    for (const [x, y] of lampRays) set(g, x, y, "r");
    return g;
  })(),
};

// ───────────────────────────────────────────────────────────────────────────
// 4. Klaxon (16x16 x2): side-view horn. Blaring frame recoils 1px left and
//    throws two amber sound arcs; the driver's 2x2 window goes red.
// ───────────────────────────────────────────────────────────────────────────

const klaxonIdle = grid(
  "klaxon",
  [
    "................",
    "................",
    "..........kk....",
    ".........k21k...",
    "........k221k...",
    ".kkkkkkk2221k...",
    "k333333k2221k...",
    "k3XX333k2221k...",
    "k3XX333k2221k...",
    "k333333k2221k...",
    ".kkkkkkk3331k...",
    "........k331k...",
    ".........k31k...",
    "..........kk....",
    "................",
    "................",
  ],
  16,
  16,
);

const klaxonFrames: Record<string, Grid> = {
  idle: remap(klaxonIdle, { X: "2" }),
  blare: (() => {
    const g = shift(remap(klaxonIdle, { X: "r" }), -1, 0);
    // arc 1: tips at col 12, body col 13
    for (const [x, y] of [
      [12, 5],
      [13, 6],
      [13, 7],
      [13, 8],
      [13, 9],
      [12, 10],
    ])
      set(g, x, y, "a");
    // arc 2: tips at col 14, body col 15
    for (const [x, y] of [
      [14, 3],
      [15, 4],
      [15, 5],
      [15, 6],
      [15, 7],
      [15, 8],
      [15, 9],
      [15, 10],
      [15, 11],
      [14, 12],
    ])
      set(g, x, y, "a");
    return g;
  })(),
};

// ───────────────────────────────────────────────────────────────────────────
// 5. Status badges (8x8). Glyph drawn inside cols/rows 1..6, then auto-outlined.
// ───────────────────────────────────────────────────────────────────────────

// Clockwise ring of 12 positions around a 2x2 hole.
const SPIN_RING: [number, number][] = [
  [3, 1],
  [4, 1],
  [5, 2],
  [6, 3],
  [6, 4],
  [5, 5],
  [4, 6],
  [3, 6],
  [2, 5],
  [1, 4],
  [1, 3],
  [2, 2],
];

function spinner(frame: number): Grid {
  const g = blank(8, 8);
  const head = (frame * 3) % 12;
  const trail = ["h", "g", "g", "G", "G"];
  SPIN_RING.forEach(([x, y], i) => {
    const back = (head - i + 12) % 12;
    set(g, x, y, trail[back] ?? "3");
  });
  return outline(g);
}

const badgeGlyphs: Record<string, Grid> = {
  "working-0": spinner(0),
  "working-1": spinner(1),
  "working-2": spinner(2),
  "working-3": spinner(3),
  "waiting-decision": outline(
    grid(
      "decision",
      [
        "........",
        "..aaa...",
        ".a...a..",
        "....a...",
        "...a....",
        "........",
        "...a....",
        "........",
      ],
      8,
      8,
    ),
  ),
  "waiting-permission": outline(
    grid(
      "permission",
      [
        "........",
        "..mmm...",
        ".m...m..",
        ".mmmmm..",
        ".mmmmm..",
        ".mmkmm..",
        ".mmmmm..",
        "........",
      ],
      8,
      8,
    ),
  ),
  "idle-0": outline(
    grid(
      "idle0",
      [
        "........",
        "....bbb.",
        ".....b..",
        "....bbb.",
        ".bb.....",
        "..b.....",
        ".bb.....",
        "........",
      ],
      8,
      8,
    ),
  ),
  "idle-1": outline(
    grid(
      "idle1",
      [
        "........",
        ".....bb.",
        "......b.",
        ".....bb.",
        ".bbb....",
        "..b.....",
        ".bbb....",
        "........",
      ],
      8,
      8,
    ),
  ),
  offline: outline(
    grid(
      "offline",
      [
        "........",
        "..2..2..",
        "..2..2..",
        ".222222.",
        ".222222.",
        "..2222..",
        "...22...",
        "........",
      ],
      8,
      8,
    ),
  ),
};

// ───────────────────────────────────────────────────────────────────────────
// 6. Audio (12x12): speaker with cyan waves / red cross
// ───────────────────────────────────────────────────────────────────────────

const speaker = grid(
  "speaker",
  [
    "............",
    "......k.....",
    ".....k1k....",
    "....k11k....",
    "kkkk111k....",
    "k111111k....",
    "k111111k....",
    "kkkk111k....",
    "....k11k....",
    ".....k1k....",
    "......k.....",
    "............",
  ],
  12,
  12,
);

const audioOn = (() => {
  const g = [...speaker];
  for (const [x, y] of [
    [9, 4],
    [10, 5],
    [10, 6],
    [9, 7],
  ])
    set(g, x, y, "c");
  for (const [x, y] of [
    [10, 2],
    [11, 3],
    [11, 4],
    [11, 5],
    [11, 6],
    [11, 7],
    [11, 8],
    [10, 9],
  ])
    set(g, x, y, "c");
  return g;
})();

const audioOff = (() => {
  const g = remap(speaker, { "1": "2" });
  for (const [x, y] of [
    [8, 4],
    [9, 5],
    [10, 6],
    [11, 7],
    [11, 4],
    [10, 5],
    [9, 6],
    [8, 7],
  ])
    set(g, x, y, "r");
  return g;
})();

// ───────────────────────────────────────────────────────────────────────────
// 7. Crew (12x12 x 8 x 2 frames). Greys only. `e` = eye (k open / 2 closed),
//    `E` = lens glint for glasses (1 open / 2 closed).
// ───────────────────────────────────────────────────────────────────────────

const crewDefs: { name: string; rows: string[] }[] = [
  {
    name: "cap",
    rows: [
      "...kkkkkk...",
      "..k222222k..",
      "..k222222kkk",
      ".kk11111222k",
      ".k31111113kk",
      ".k31e11e13k.",
      ".kk111111kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
  {
    name: "mohawk",
    rows: [
      ".....kk.....",
      "....k22k....",
      "..kkk22kkk..",
      ".kk112211kk.",
      ".k31111113k.",
      ".k31e11e13k.",
      ".kk111111kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
  {
    name: "bun",
    rows: [
      ".....kkk....",
      "....k222k...",
      "..kkk222kk..",
      ".kk222222kk.",
      ".k32111123k.",
      ".k31e11e13k.",
      ".kk111111kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
  {
    name: "helmet",
    rows: [
      "...kkkkkk...",
      "..k212222k..",
      ".k22222222k.",
      ".k23333332k.",
      ".k31111113k.",
      ".k31e11e13k.",
      ".kk111111kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
  {
    name: "antenna",
    rows: [
      ".........k1k",
      "....kkkk.k2k",
      "...k2222kk2k",
      ".kk222222k2k",
      ".k31111113k.",
      ".k31e11e13k.",
      ".kk111111kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
  {
    name: "glasses",
    rows: [
      "............",
      "...kkkkkk...",
      "..k222222k..",
      ".kk222222kk.",
      ".k32111123k.",
      ".k3E233E23k.",
      ".kk221122kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
  {
    name: "hood",
    rows: [
      "...kkkkkk...",
      "..k333333k..",
      ".k33333333k.",
      "k3k111111k3k",
      "k2k111111k2k",
      "k2k1e11e1k2k",
      "k3k111111k3k",
      "k3k111111k2k",
      "k3k211112k2k",
      "k33k1111k23k",
      "k333k11k333k",
      "k3333333333k",
    ],
  },
  {
    name: "goggles",
    rows: [
      "....kkkk....",
      "...k1111k...",
      ".k31233123k.",
      ".k32211223k.",
      ".k31111113k.",
      ".k31e11e13k.",
      ".kk111111kk.",
      "..k111111k2.",
      "..k211112k2.",
      "...k1111k3..",
      ".kkk3113kkk.",
      "k3333333333k",
    ],
  },
];

const crewFrames = crewDefs.map((d) => {
  const base = grid(`crew-${d.name}`, d.rows, 12, 12);
  return {
    name: d.name,
    open: remap(base, { e: "k", E: "1" }),
    blink: remap(base, { e: "2", E: "2" }),
  };
});

// ───────────────────────────────────────────────────────────────────────────
// 8. Signal bar cap (4x8) + transmission envelope (8x8)
// ───────────────────────────────────────────────────────────────────────────

const signalCapShape = grid(
  "cap",
  ["kk..", "Xk..", "XXk.", "XXXk", "XXXk", "XXk.", "Xk..", "kk.."],
  4,
  8,
);
const signalCaps: Record<string, Grid> = {
  green: remap(signalCapShape, { X: "g" }),
  amber: remap(signalCapShape, { X: "a" }),
  red: remap(signalCapShape, { X: "r" }),
  cyan: remap(signalCapShape, { X: "c" }),
};

const envelope = grid(
  "envelope",
  ["kkkkkkkk", "kaaaaaak", "kAaaaaAk", "kaAaaAak", "kaaAAaak", "kaaaaaak", "kaaaaaak", "kkkkkkkk"],
  8,
  8,
);

// ───────────────────────────────────────────────────────────────────────────
// 9. TRANSMITTED stamp (32x32 x3): check in a ring with starburst
// ───────────────────────────────────────────────────────────────────────────

function stamp(kind: "small" | "full" | "sparkle"): Grid {
  const g = blank(32, 32);
  const cx = 15.5;
  const cy = 15.5;
  const ro = kind === "small" ? 8 : 12;
  const ri = ro - 2;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d < ri) set(g, x, y, "s");
      else if (d < ro) set(g, x, y, dx > 0 && dy > 0 ? "G" : "g");
    }
  // Checkmark, 2px thick (stroke + the pixel above).
  const pts = kind === "small" ? [12, 16, 14, 18, 19, 13] : [9, 16, 13, 20, 22, 11];
  const stroke = (x: number, y: number) => {
    set(g, x, y, "h");
    set(g, x, y - 1, "h");
  };
  line(pts[0], pts[1], pts[2], pts[3], stroke);
  line(pts[2], pts[3], pts[4], pts[5], stroke);
  if (kind !== "small") {
    // Starburst: 8 rays just outside the ring's outline.
    for (let i = 0; i < 8; i++) {
      const t = (i * Math.PI) / 4;
      for (const d of [14, 15])
        set(g, Math.floor(cx + d * Math.cos(t)), Math.floor(cy + d * Math.sin(t)), "a");
    }
  }
  if (kind === "sparkle") {
    for (const [x, y] of [
      [4, 4],
      [27, 3],
      [3, 27],
      [28, 28],
    ]) {
      set(g, x, y, "w");
      set(g, x - 1, y, "h");
      set(g, x + 1, y, "h");
      set(g, x, y - 1, "h");
      set(g, x, y + 1, "h");
    }
  }
  return outline(g);
}

// ───────────────────────────────────────────────────────────────────────────
// Emit everything
// ───────────────────────────────────────────────────────────────────────────

// 1. favicon: SVG at public root, 32px PNG in assets
writeFileSync(join(PUBLIC, "favicon.svg"), toSvg(favicon, "Mission Control"));
emit("favicon-32", favicon, { scale: 2, svg: false });
emit("favicon", favicon);

// 2. emblem
emit("logo-emblem", emblem("a"));
emit("logo-emblem-2c", emblem("g"));

// 3. lamp
const lampOrder = ["off", "dim", "bright", "rays"];
for (const k of lampOrder) emit(`warning-lamp-${k}`, lampFrames[k]);
emit(
  "warning-lamp-sheet",
  sheet(
    lampOrder.map((k) => lampFrames[k]),
    4,
  ),
);

// 4. klaxon
emit("klaxon-idle", klaxonFrames.idle);
emit("klaxon-blare", klaxonFrames.blare);
emit("klaxon-sheet", sheet([klaxonFrames.idle, klaxonFrames.blare], 2));

// 5. badges
const badgeOrder = Object.keys(badgeGlyphs);
for (const k of badgeOrder) emit(`badge-${k}`, badgeGlyphs[k]);
emit(
  "badges-sheet",
  sheet(
    badgeOrder.map((k) => badgeGlyphs[k]),
    badgeOrder.length,
  ),
);

// 6. audio
emit("audio-on", audioOn);
emit("audio-off", audioOff);

// 7. crew
crewFrames.forEach((c, i) => {
  emit(`crew-${i}`, c.open);
  emit(`crew-${i}-blink`, c.blink);
});
emit("crew-sheet", sheet([...crewFrames.map((c) => c.open), ...crewFrames.map((c) => c.blink)], 8));
writeFileSync(
  join(OUT, "crew.json"),
  `${JSON.stringify(
    {
      sheet: "/assets/crew-sheet.png",
      scale: SCALE,
      frameWidth: 12,
      frameHeight: 12,
      columns: 8,
      rows: 2,
      frameNames: ["open", "blink"],
      greys: {
        outline: PALETTE.k,
        light: PALETTE["1"],
        mid: PALETTE["2"],
        dark: PALETTE["3"],
      },
      sprites: crewFrames.map((c, i) => ({
        index: i,
        name: c.name,
        svg: [`/assets/crew-${i}.svg`, `/assets/crew-${i}-blink.svg`],
        frames: [
          { x: i * 12, y: 0 },
          { x: i * 12, y: 12 },
        ],
      })),
    },
    null,
    2,
  )}\n`,
);

// 8. signal cap + envelope
for (const [k, g] of Object.entries(signalCaps)) emit(`signal-cap-${k}`, g);
emit("envelope", envelope);

// 9. stamp
const stampOrder = ["small", "full", "sparkle"] as const;
for (const k of stampOrder) emit(`stamp-${k}`, stamp(k));
emit(
  "stamp-sheet",
  sheet(
    stampOrder.map((k) => stamp(k)),
    3,
  ),
);

writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Dump the procedural grids so they can be eyeballed in the terminal.
if (process.argv.includes("--dump")) {
  for (const [n, g] of Object.entries({
    emblem: emblem("g"),
    "stamp-full": stamp("full"),
    "spinner-0": spinner(0),
  })) {
    console.log(`\n${n}`);
    console.log(g.join("\n"));
  }
}
console.log(`wrote ${Object.keys(manifest).length} assets to ${OUT}`);

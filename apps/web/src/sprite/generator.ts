/**
 * Procedural crew sprites, the algorithm the user approved in the design preview.
 * A 12x12 grid: the left 6 columns are rolled from a seeded xorshift and mirrored, so every
 * persona is a symmetric creature that is stable across reloads. Edges (top two rows, bottom
 * two rows, outer column) are sparser so the silhouette reads as a body rather than a blob.
 * A single white "eye" pixel sits at row 4 col 3 with blanks below and beside it so the face
 * reads; the blink frame clears the eye. The renderer darkens every third row for banding.
 *
 * Cell values: 0 off, 1 persona colour, 2 eye (white).
 */
export type Cell = 0 | 1 | 2;
export const SPRITE_SIZE = 12;
const HALF = SPRITE_SIZE / 2;

export interface SpriteFrames {
  open: Cell[];
  blink: Cell[];
}

function xorshift(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000) / 1000;
  };
}

export function generateSprite(seed: number): SpriteFrames {
  const r = xorshift(seed);
  const half: Cell[][] = [];
  for (let y = 0; y < SPRITE_SIZE; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < HALF; x++) {
      const edge = y < 2 || y > 9 || x === 0;
      row.push(r() > (edge ? 0.72 : 0.45) ? 1 : 0);
    }
    half.push(row);
  }
  const set = (y: number, x: number, v: Cell) => {
    const row = half[y];
    if (row) row[x] = v;
  };
  set(4, 3, 2);
  set(5, 3, 0);
  set(4, 4, 0);

  const mirror = (): Cell[] => {
    const out: Cell[] = [];
    for (const row of half) {
      for (let x = 0; x < SPRITE_SIZE; x++) out.push(row[x < HALF ? x : SPRITE_SIZE - 1 - x] ?? 0);
    }
    return out;
  };
  const open = mirror();
  set(4, 3, 0);
  const blink = mirror();
  return { open, blink };
}

/** Every third row is drawn darker; this is the banding the approved preview uses. */
export function isBandRow(index: number): boolean {
  return Math.floor(index / SPRITE_SIZE) % 3 === 0;
}

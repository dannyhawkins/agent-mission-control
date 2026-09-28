# Pixel assets

All artwork is generated from character grids in `_src/make.ts`. Edit the grid,
re-run, commit the output:

```sh
bun apps/web/public/assets/_src/make.ts        # --dump prints the procedural grids
```

Every asset ships as `<name>.svg` (viewBox in pixel units, `shape-rendering="crispEdges"`,
one `<path>` per colour) and `<name>.png` (8x nearest-neighbour, RGBA, transparent).
Served from `/assets/<name>.<ext>`. Always render with `image-rendering: pixelated`.

`manifest.json` lists every emitted file with its unscaled `w`/`h` and PNG `scale`.

## Palette

| key | hex | use |
|---|---|---|
| outline | `#1a1a1f` | 1px outline on every sprite |
| amber | `#ffb000` / shade `#a86f00` | primary, dish, `?` badge, envelope, cap |
| green | `#33ff66` / shade `#1c9c3f` / bloom `#c8ffd8` | working spinner, stamp, signal arcs |
| cyan | `#33e0ff` | audio waves |
| magenta | `#ff4fd8` | permission badge |
| red | `#ff3b3b` / shade `#8a1f1f` | lamp, klaxon window, audio-off cross |
| blue | `#4f7cff` | idle badge |
| greys | `#d4d4dc` light, `#8c8c98` mid, `#4c4c58` dark | crew sprites, lamp base, horn |

## Assets

| asset | grid (px) | frames | files | use |
|---|---|---|---|---|
| favicon | 16x16 | 1 | `/favicon.svg` (public root, has `<title>`), `favicon.svg/png`, `favicon-32.png` (2x = 32px) | tab icon: CRT with green blip, amber V antenna |
| logo emblem | 24x24 | 1 | `logo-emblem` (amber mono), `logo-emblem-2c` (amber dish + green signal) | mark next to the MISSION CONTROL wordmark |
| warning lamp | 16x16 | 4 | `warning-lamp-off/dim/bright/rays`, `warning-lamp-sheet` (64x16, 512x128 png) | escalation beacon. Frame order = `off, dim, bright, rays` which maps 1:1 onto `EscalationTier` `calm, amber, red, alarm` |
| klaxon | 16x16 | 2 | `klaxon-idle`, `klaxon-blare`, `klaxon-sheet` (32x16) | alarm horn; blare frame recoils 1px left, red window, amber sound arcs. Alternate at ~6fps |
| status badges | 8x8 | 9 | `badge-working-0..3`, `badge-waiting-decision`, `badge-waiting-permission`, `badge-idle-0..1`, `badge-offline`, `badges-sheet` (72x8) | `SessionStatus` glyphs. Sheet column order is exactly that list. Spinner: 4 frames, rotate ~8fps. Idle: 2 frames, swap ~1fps |
| audio | 12x12 | 1 each | `audio-on` (cyan waves), `audio-off` (dim speaker, red cross) | sound toggle |
| crew | 12x12 | 2 each (open, blink) | `crew-0..7`, `crew-0..7-blink`, `crew-sheet` (96x24), `crew.json` | operator portraits per persona. See below |
| signal cap | 4x8 | 1 | `signal-cap-green/amber/red/cyan` | rounded right-hand end cap for an 8px-tall pulse/signal bar. Left column is bar-coloured so it butts flush against the bar |
| envelope | 8x8 | 1 | `envelope` | "transmission" icon for the decision card header |
| stamp | 32x32 | 3 | `stamp-small`, `stamp-full`, `stamp-sparkle`, `stamp-sheet` (96x32) | TRANSMITTED seal for the resolve animation: play small -> full -> sparkle, hold on full |

## Crew sheet

`crew-sheet.png` is 8 columns x 2 rows of 12x12 frames: row 0 = eyes open, row 1 = blink.
Sprite index = column. Names in order:

| # | silhouette |
|---|---|
| 0 | cap |
| 1 | mohawk |
| 2 | bun |
| 3 | helmet |
| 4 | antenna |
| 5 | glasses |
| 6 | hood |
| 7 | goggles (bald) |

Pick a sprite with `spriteSeed % 8`. Blink by showing row 1 for ~100ms every 3-5s.

Sprites are drawn in exactly three greys plus the outline so the UI can recolour
per `PersonaColor`. Two workable approaches:

- **CSS**: `filter: sepia(1) saturate(N) hue-rotate(Xdeg)` on the `<img>`. Cheap, approximate.
- **Canvas palette swap** (exact): draw the frame to an offscreen canvas, then
  replace each grey with a tint. `crew.json` gives the grey hexes as `greys.light/mid/dark`;
  map light -> persona colour at ~85% lightness, mid -> the persona colour, dark -> ~35%.
  Leave `greys.outline` alone.

`crew.json` shape:

```json
{
  "sheet": "/assets/crew-sheet.png",
  "scale": 8,
  "frameWidth": 12, "frameHeight": 12, "columns": 8, "rows": 2,
  "frameNames": ["open", "blink"],
  "greys": { "outline": "#1a1a1f", "light": "#d4d4dc", "mid": "#8c8c98", "dark": "#4c4c58" },
  "sprites": [
    { "index": 0, "name": "cap", "svg": ["/assets/crew-0.svg", "/assets/crew-0-blink.svg"],
      "frames": [{ "x": 0, "y": 0 }, { "x": 0, "y": 12 }] }
  ]
}
```

Frame `x`/`y` are in unscaled pixels; multiply by `scale` when slicing the PNG.

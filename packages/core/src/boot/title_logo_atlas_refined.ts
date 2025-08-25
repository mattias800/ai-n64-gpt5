import type { TileAtlas, DLCommand } from './title_dl_hle.js';
import { buildRefinedSM64Tiles } from './title_logo_sm64_refined.js';

// Build an atlas of 16x16 quadrants for S, M, SIX (6), FOUR (4) from refined 32x32 masks.
// The atlas keys are of the form: S00,S01,S10,S11, M00.., SIX00.., FOUR00..
export function buildRefinedSM64Atlas16(): TileAtlas {
  // Create 32x32 glyph tiles split into 16x16 (tileSize=16), with zero spacing and origin at (0,0)
  const tiles = buildRefinedSM64Tiles(256, 256, { tileSize: 16, spacing: 0, offsetX: 0, offsetY: 0 });
  // Order in buildRefinedSM64Tiles: S, M, SIX, FOUR (each 4 tiles gy=0..1, gx=0..1)
  const names = ['S', 'M', 'SIX', 'FOUR'] as const;
  const atlas: Record<string, { width: number; height: number; pixels: Uint16Array }> = {};
  let idx = 0;
  for (const n of names) {
    for (let gy = 0; gy < 2; gy++) {
      for (let gx = 0; gx < 2; gx++) {
        const t = tiles[idx++]!; // 16x16 tile
        const key = `${n}${gy}${gx}`;
        atlas[key] = { width: t.width, height: t.height, pixels: t.pixels };
      }
    }
  }
  return atlas;
}

// Return DL commands to draw a 32x32 glyph from its four quadrants at (x,y)
// The atlas is expected to contain keys name00,name01,name10,name11.
export function dlCommandsForGlyph32(name: 'S'|'M'|'SIX'|'FOUR', x: number, y: number): DLCommand[] {
  return [
    { op: 'draw_tile', id: `${name}00`, x,       y       },
    { op: 'draw_tile', id: `${name}01`, x: x+16, y       },
    { op: 'draw_tile', id: `${name}10`, x,       y: y+16 },
    { op: 'draw_tile', id: `${name}11`, x: x+16, y: y+16 },
  ];
}


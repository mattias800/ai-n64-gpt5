import type { TileAtlas } from './title_dl_hle.js';
import { makeTileS16, makeTileM16 } from './title_logo_sm_tiles.js';

// Build a small RGBA5551 atlas for an SM logo segment with 16x16 tiles.
export function buildSMLogoAtlas16(): TileAtlas {
  const s = makeTileS16();
  const m = makeTileM16();
  return {
    S: { width: 16, height: 16, pixels: s },
    M: { width: 16, height: 16, pixels: m },
  };
}


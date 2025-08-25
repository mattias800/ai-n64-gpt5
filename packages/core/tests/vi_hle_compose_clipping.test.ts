import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viComposeTiles, viDrawSolidRGBA5551, Tile5551 } from '../src/system/video_hle.js';
import { viScanout } from '../src/system/video.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]];
}

const OPAQUE_BLACK = ((0 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
const OPAQUE_RED   = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
const OPAQUE_GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

function solidTile5551(w: number, h: number, color: number): Uint16Array {
  const t = new Uint16Array(w * h); t.fill(color >>> 0); return t;
}

describe('VI HLE compose clipping and layering', () => {
  it('layers tiles and clips those partially outside', () => {
    const bus = new Bus(new RDRAM(0x8000));
    const w = 8, h = 5; const origin = 0x2000;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    viDrawSolidRGBA5551(bus, w, h, OPAQUE_BLACK);

    const tiles: Tile5551[] = [
      // Bottom layer red, partially outside left/top
      { dstX: -1, dstY: -1, width: 4, height: 3, pixels: solidTile5551(4,3, OPAQUE_RED) },
      // Top layer green, overlapping center area
      { dstX: 1, dstY: 1, width: 3, height: 2, pixels: solidTile5551(3,2, OPAQUE_GREEN) },
      // Partially outside right/bottom
      { dstX: 6, dstY: 3, width: 4, height: 3, pixels: solidTile5551(4,3, OPAQUE_RED) },
    ];

    viComposeTiles(bus, w, h, tiles);
    const out = viScanout(bus, w, h);

    // Top-left clipped red should appear at (0,0)
    expect(px(out, 0,0,w)).toEqual([255,0,0,255]);
    // Overlapping area should be top layer green
    expect(px(out, 2,2,w)).toEqual([0,255,0,255]);
    // Right/bottom clipped area
    expect(px(out, 6,3,w)).toEqual([255,0,0,255]);
    expect(px(out, 7,4,w)).toEqual([255,0,0,255]);
    // Outside unclipped areas remain black
    expect(px(out, 5,0,w)).toEqual([0,0,0,255]);
  });
});


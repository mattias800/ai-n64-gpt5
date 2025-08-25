import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viScanout } from '../src/system/video.js';
import { viDrawSolidRGBA5551, viComposeTiles, Tile5551 } from '../src/system/video_hle.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]];
}

describe('VI composition of multiple tiles with alpha', () => {
  it('composes two overlapping tiles; top tile respects alpha', () => {
    const bus = new Bus(new RDRAM(0x8000));
    const origin = 0x1400; const w = 6; const h = 4;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    // Background solid blue (opaque)
    const blue = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    viDrawSolidRGBA5551(bus, w, h, blue);

    // Foreground 3x2 tile with a transparent center pixel
    const red = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
    const trn = ((0 << 11) | (0 << 6) | (0 << 1) | 0) >>> 0; // alpha=0
    const tileFg = new Uint16Array([
      red, red, red,
      red, trn, red,
    ]);
    const tiles: Tile5551[] = [
      { dstX: 2, dstY: 1, width: 3, height: 2, pixels: tileFg },
    ];

    viComposeTiles(bus, w, h, tiles);

    const out = viScanout(bus, w, h);

    // Corners remain background blue
    expect(px(out, 0,0,w)).toEqual([0,0,255,255]);

    // Overlapping red area drawn
    expect(px(out, 2,1,w)).toEqual([255,0,0,255]);
    expect(px(out, 4,2,w)).toEqual([255,0,0,255]);

    // Transparent center should show background blue
    expect(px(out, 3,2,w)).toEqual([0,0,255,255]);
  });
});


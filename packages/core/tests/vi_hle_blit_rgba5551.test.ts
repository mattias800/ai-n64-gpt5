import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viScanout } from '../src/system/video.js';
import { viDrawSolidRGBA5551, viBlitRGBA5551 } from '../src/system/video_hle.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]];
}

describe('VI HLE texture blit RGBA5551', () => {
  it('blits a 2x2 tile at (1,1) into a 4x4 framebuffer', () => {
    const bus = new Bus(new RDRAM(0x4000));
    const origin = 0x1200; const w = 4; const h = 4;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    // Start with solid black transparent
    const black0 = ((0 << 11) | (0 << 6) | (0 << 1) | 0) >>> 0;
    viDrawSolidRGBA5551(bus, w, h, black0);

    // 2x2 tile: red, green, blue, white (all alpha 1)
    const red   = ((31 << 11) | (0 << 6)  | (0 << 1)  | 1) >>> 0;
    const green = ((0 << 11)  | (31 << 6) | (0 << 1)  | 1) >>> 0;
    const blue  = ((0 << 11)  | (0 << 6)  | (31 << 1) | 1) >>> 0;
    const white = ((31 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;
    const tile = new Uint16Array([
      red, green,
      blue, white,
    ]);

    viBlitRGBA5551(bus, w, h, 1, 1, tile, 2, 2);
    const out = viScanout(bus, w, h);

    // Corners that remain black
    expect(px(out, 0,0,w)).toEqual([0,0,0,0]);
    expect(px(out, 3,3,w)).toEqual([0,0,0,0]);

    // Blitted area
    expect(px(out, 1,1,w)).toEqual([255, 0, 0, 255]);
    expect(px(out, 2,1,w)).toEqual([0, 255, 0, 255]);
    expect(px(out, 1,2,w)).toEqual([0, 0, 255, 255]);
    expect(px(out, 2,2,w)).toEqual([255, 255, 255, 255]);
  });
});


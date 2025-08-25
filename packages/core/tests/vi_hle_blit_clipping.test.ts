import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viBlitRGBA5551, viDrawSolidRGBA5551 } from '../src/system/video_hle.js';
import { viScanout } from '../src/system/video.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]];
}

const OPAQUE_BLACK = ((0 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
const OPAQUE_RED   = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

// Build a solid tile of given w,h,color
function solidTile(w: number, h: number, color5551: number): Uint16Array {
  const t = new Uint16Array(w * h);
  t.fill(color5551 >>> 0);
  return t;
}

describe('VI HLE blit clipping at framebuffer edges', () => {
  it('clips tile partially outside left/top', () => {
    const bus = new Bus(new RDRAM(0x8000));
    const w = 6, h = 4; const origin = 0x1000;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    viDrawSolidRGBA5551(bus, w, h, OPAQUE_BLACK);

    const tile = solidTile(4, 3, OPAQUE_RED);
    // Place so that the tile covers from (-2,-1) to (1,1) relative to framebuffer
    viBlitRGBA5551(bus, w, h, -2, -1, tile, 4, 3);

    const out = viScanout(bus, w, h);
    // Only pixels within [0..1]x[0..1] should be red
    expect(px(out, 0, 0, w)).toEqual([255,0,0,255]);
    expect(px(out, 1, 0, w)).toEqual([255,0,0,255]);
    expect(px(out, 0, 1, w)).toEqual([255,0,0,255]);
    expect(px(out, 1, 1, w)).toEqual([255,0,0,255]);
    // Others remain black
    expect(px(out, 2, 0, w)).toEqual([0,0,0,255]);
    expect(px(out, 0, 2, w)).toEqual([0,0,0,255]);
  });

  it('clips tile partially outside right/bottom', () => {
    const bus = new Bus(new RDRAM(0x8000));
    const w = 6, h = 4; const origin = 0x1800;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    viDrawSolidRGBA5551(bus, w, h, OPAQUE_BLACK);

    const tile = solidTile(4, 3, OPAQUE_RED);
    // Place so bottom-right overflows by (2,1)
    viBlitRGBA5551(bus, w, h, 4, 2, tile, 4, 3);

    const out = viScanout(bus, w, h);
    // Only pixels within [4..5]x[2..3] should be red
    expect(px(out, 4, 2, w)).toEqual([255,0,0,255]);
    expect(px(out, 5, 2, w)).toEqual([255,0,0,255]);
    expect(px(out, 4, 3, w)).toEqual([255,0,0,255]);
    expect(px(out, 5, 3, w)).toEqual([255,0,0,255]);
    // Neighbors remain black
    expect(px(out, 3, 3, w)).toEqual([0,0,0,255]);
  });
});


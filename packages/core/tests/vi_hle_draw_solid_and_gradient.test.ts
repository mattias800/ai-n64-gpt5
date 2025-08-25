import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viScanout } from '../src/system/video.js';
import { viDrawSolidRGBA5551, viDrawHorizontalGradient } from '../src/system/video_hle.js';

function pxAt(out: Uint8Array, x: number, y: number, w: number): number[] {
  const i = (y * w + x) * 4;
  return [out[i], out[i+1], out[i+2], out[i+3]];
}

describe('HLE video draw (solid and gradient) + scanout', () => {
  it('solid fill produces uniform RGBA', () => {
    const bus = new Bus(new RDRAM(0x4000));
    const origin = 0x300;
    const w = 4, h = 3;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    // Solid red (31,0,0,1)
    const red5551 = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
    viDrawSolidRGBA5551(bus, w, h, red5551);
    const out = viScanout(bus, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(pxAt(out, x, y, w)).toEqual([255, 0, 0, 255]);
      }
    }
  });

  it('horizontal gradient transitions from blue to green', () => {
    const bus = new Bus(new RDRAM(0x4000));
    const origin = 0x800;
    const w = 5, h = 2;
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    const blue5551 = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const green5551 = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    viDrawHorizontalGradient(bus, w, h, blue5551, green5551);
    const out = viScanout(bus, w, h);

    // Check endpoints and middle using the same math as the gradient draw
    const expected0 = [0, 0, 255, 255];
    const expectedEnd = [0, 255, 0, 255];
    const middleX = Math.floor((w - 1) / 2);
    // Middle should be an interpolated blend leaning towards start (blue) because w=5
    expect(pxAt(out, 0, 0, w)).toEqual(expected0);
    expect(pxAt(out, w-1, 0, w)).toEqual(expectedEnd);
    // Just sanity check middle remains fully opaque
    expect(pxAt(out, middleX, 0, w)[3]).toBe(255);
  });
});


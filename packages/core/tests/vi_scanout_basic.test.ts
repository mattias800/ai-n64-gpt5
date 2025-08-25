import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viScanout } from '../src/system/video.js';

// Write a 2x2 RGBA5551 pattern into RDRAM and verify viScanout produces expected RGBA8888

describe('VI scanout RGBA5551 -> RGBA8888', () => {
  it('converts a 2x2 pixel block correctly', () => {
    const rdram = new RDRAM(0x1000);
    const bus = new Bus(rdram);

    const origin = 0x200;
    const width = 2; // pixels
    const height = 2;

    // Program VI registers
    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0); // stride = 2 pixels

    // Helper to write RGBA5551 at index (x,y)
    function put(x: number, y: number, r5: number, g5: number, b5: number, a1: number) {
      const p = (((r5 & 0x1f) << 11) | ((g5 & 0x1f) << 6) | ((b5 & 0x1f) << 1) | (a1 & 0x01)) >>> 0;
      const addr = origin + (y * width + x) * 2;
      rdram.bytes[addr] = (p >>> 8) & 0xff;
      rdram.bytes[addr + 1] = p & 0xff;
    }

    // Pattern:
    // (0,0): red (31,0,0,1)
    // (1,0): green (0,31,0,1)
    // (0,1): blue (0,0,31,1)
    // (1,1): black transparent (0,0,0,0)
    put(0,0,31,0,0,1);
    put(1,0,0,31,0,1);
    put(0,1,0,0,31,1);
    put(1,1,0,0,0,0);

    const out = viScanout(bus, width, height);

    function px(i: number) { return [out[i], out[i+1], out[i+2], out[i+3]]; }

    expect(px(0)).toEqual([255, 0, 0, 255]);
    expect(px(4)).toEqual([0, 255, 0, 255]);
    expect(px(8)).toEqual([0, 0, 255, 255]);
    expect(px(12)).toEqual([0, 0, 0, 0]);
  });
});


import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo } from '../src/boot/title_logo_hle.js';
import { buildSM64LogoSliceTiles } from '../src/boot/title_logo_slice.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// This test composes a small 8x8 'M' glyph tile over a gradient and asserts transparent background and opaque letter pixels.
describe('SM64 logo slice: 8x8 M glyph composition', () => {
  it('renders opaque M strokes and transparent background revealing gradient', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 64, h = 48, origin = 0x7000;
    const bgStart = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0; // blue
    const bgEnd   = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0; // red

    const tiles = buildSM64LogoSliceTiles(w, h);
    const { image, res } = hleTitleRenderLogo(cpu, bus, sys, origin, w, h, bgStart, bgEnd, tiles);

    expect(res.viAcks).toBe(1);

    const t = tiles[0]!;
    const sx = t.dstX, sy = t.dstY;
    const C = [255, 0, 0, 255] as const; // red

    // Check left and right columns opaque
    for (let y = 0; y < 8; y++) {
      expect(px(image, sx + 0, sy + y, w)).toEqual(C);
      expect(px(image, sx + 7, sy + y, w)).toEqual(C);
    }
    // Check diagonal strokes at y=1..3
    expect(px(image, sx + 1, sy + 1, w)).toEqual(C);
    expect(px(image, sx + 2, sy + 2, w)).toEqual(C);
    expect(px(image, sx + 3, sy + 3, w)).toEqual(C);
    expect(px(image, sx + 6, sy + 1, w)).toEqual(C);
    expect(px(image, sx + 5, sy + 2, w)).toEqual(C);
    expect(px(image, sx + 4, sy + 3, w)).toEqual(C);

    // Check background center (transparent) reveals gradient (should not be pure red)
    const [r,g,b,a] = px(image, sx + 3, sy + 1, w);
    expect(!(r === 255 && g === 0 && b === 0)).toBe(true);
    expect(a).toBe(255);
  });
});


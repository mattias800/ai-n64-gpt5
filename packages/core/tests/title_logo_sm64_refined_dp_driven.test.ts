import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleDPDrivenTitleFramesAndRun } from '../src/boot/title_dp_driven.js';
import { buildRefinedSM64Tiles } from '../src/boot/title_logo_sm64_refined.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// Refined SM64 tiles in 32x32 per glyph, split into tiles; verify edges and hollow regions.
describe('Refined SM64 mask-based tiles (32x32 per glyph)', () => {
  it('renders S,M,6,4 with strong edges and hollow regions, via DP-driven frame', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 256, h = 160, origin = 0xA000;
    const blue  = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const cyan  = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;

    const tiles = buildRefinedSM64Tiles(w, h, { tileSize: 8, spacing: 16 });
    const frames = [ { at: 4, bgStart5551: blue, bgEnd5551: cyan, tiles } ];
    const { image, res } = scheduleDPDrivenTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 8);

    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);

    // Sample a few key pixels: S top bar, M left vertical, 6 interior hollow, 4 crossbar mid
    // These are approximate positions based on builder math.
    const Sx = Math.floor((w - (32*4 + 16*3)) / 2);
    const Sy = Math.floor(h * 0.25);
    expect(px(image, Sx + 6, Sy + 1, w)).toEqual([0,0,255,255]); // S top bar

    const Mx = Sx + 32 + 16;
    expect(px(image, Mx + 1, Sy + 10, w)).toEqual([255,0,0,255]); // M left vertical

    const SIXx = Mx + 32 + 16;
    const [r6,g6,b6,a6] = px(image, SIXx + 16, Sy + 16, w); // center hollow of '6' should be background (gradient)
    expect(a6).toBe(255);
    expect(g6).toBeGreaterThan(10); expect(b6).toBeGreaterThan(10);

    const FOURx = SIXx + 32 + 16;
    expect(px(image, FOURx + 10, Sy + Math.floor(32/2), w)).toEqual([255,255,0,255]); // 4 crossbar mid
  });
});

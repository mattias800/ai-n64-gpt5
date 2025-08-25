import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleDPDrivenTitleFramesAndRun } from '../src/boot/title_dp_driven.js';
import { buildSM64TilesSlice } from '../src/boot/title_logo_sm64_tiles.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// Simple DP-driven animation: SM64 slice shifts by +1px X in the second frame.
describe('SM64 slice DP-driven animation (+1px X shift)', () => {
  it('acknowledges DP and VI for both frames and image reflects the 1px shift', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 192, h = 120, origin = 0xE800;
    const blue  = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const cyan  = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;
    const red   = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

    const tiles0 = buildSM64TilesSlice(w, h, { spacing: 10, offsetX: 0 });
    const tiles1 = buildSM64TilesSlice(w, h, { spacing: 10, offsetX: 1 });

    const frames = [
      { at: 3, bgStart5551: blue, bgEnd5551: cyan, tiles: tiles0 },
      { at: 6, bgStart5551: red,  bgEnd5551: red,  tiles: tiles1 },
    ];

    const { image, res } = scheduleDPDrivenTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 10);

    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);

    // Pick a pixel on S top bar from frame 0 and ensure it's background after the shift; shifted position should be blue
    const S0 = tiles0[0]!; const S1 = tiles1[0]!;
    const yS = S0.dstY + 0; const xS0 = S0.dstX + 2; const xS1 = S1.dstX + 2; // leftmost bar column to avoid overlap after shift
    const [r0,g0,b0,a0] = px(image, xS0, yS, w);
    const [r1,g1,b1,a1] = px(image, xS1, yS, w);
    // final frame: xS1 is blue, xS0 should be red background
    expect([r1,g1,b1,a1]).toEqual([0,0,255,255]);
    expect(a0).toBe(255);
    expect(r0).toBeGreaterThan(200);
    expect(g0).toBeLessThan(50);
    expect(b0).toBeLessThan(50);
  });
});

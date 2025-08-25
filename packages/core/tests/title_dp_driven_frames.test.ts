import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleDPDrivenTitleFramesAndRun } from '../src/boot/title_dp_driven.js';
import { buildTitleAtlasSlice } from '../src/boot/title_logo_atlas_data.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// Validates a DP-driven sequence: on DP completion compose frame and raise VI.
// Asserts DP acks occur alongside VI acks and final image matches last composition.
describe('DP-driven title frames', () => {
  it('composes on DP completion and raises VI; acks are counted and image matches last frame', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 96, h = 72, origin = 0xC000;
    const green = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    const blue  = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const red   = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

    const tiles0 = buildTitleAtlasSlice(w, h, { spacing: 4 });
    const tiles1 = buildTitleAtlasSlice(w, h, { spacing: 6 });

    const frames = [
      { at: 2, bgStart5551: green, bgEnd5551: blue, tiles: tiles0 },
      { at: 5, bgStart5551: red, bgEnd5551: red, tiles: tiles1 },
    ];

    const { image, res } = scheduleDPDrivenTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 8);

    // Expect 2 DP acks and 2 VI acks
    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);

    // Final frame uses tiles1; verify a pixel from right tile center is not pure green/blue (since final bg is red)
    const t = tiles1[1]!;
    const cx = t.dstX + Math.floor(t.width / 2);
    const cy = t.dstY + Math.floor(t.height / 2);
    const [r,g,b,a] = px(image, cx, cy, w);
    expect(a).toBe(255);
    // Transparent cross reveals background red => r>200, g,b small
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(50);
    expect(b).toBeLessThan(50);
  });
});


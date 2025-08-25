import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleDPDrivenTitleFramesAndRun } from '../src/boot/title_dp_driven.js';
import { buildSMTilesSlice } from '../src/boot/title_logo_sm_tiles.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('SM logo slice (S blue, M red) composed via DP-driven frames', () => {
  it('renders S and M tiles over gradient; transparent areas show background; DP/VI acks counted', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 144, h = 96, origin = 0xD000;
    const blue = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const cyan = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;

    const tiles0 = buildSMTilesSlice(w, h, { spacing: 8 });

    // Two frames: first composes S/M over blue->cyan, second re-composes identical tiles (coalescing DP+VI counts)
    const frames = [
      { at: 3, bgStart5551: blue, bgEnd5551: cyan, tiles: tiles0 },
      { at: 6, bgStart5551: blue, bgEnd5551: cyan, tiles: tiles0 },
    ];

    const { image, res } = scheduleDPDrivenTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 10);

    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);

    const s = tiles0[0]!; const m = tiles0[1]!;

    // Sample a top bar pixel in S (blue)
    expect(px(image, s.dstX + 4, s.dstY + 0, w)).toEqual([0,0,255,255]);
    // Sample a middle bar pixel in S (blue)
    expect(px(image, s.dstX + 5, s.dstY + Math.floor(16/2)-1, w)).toEqual([0,0,255,255]);
    // Sample a bottom bar pixel in S (blue)
    expect(px(image, s.dstX + 6, s.dstY + 15, w)).toEqual([0,0,255,255]);

    // Sample a vertical stroke pixel in M (red)
    expect(px(image, m.dstX + 0, m.dstY + 4, w)).toEqual([255,0,0,255]);
    // Sample a diagonal pixel in M (red)
    expect(px(image, m.dstX + 4, m.dstY + 4, w)).toEqual([255,0,0,255]);

    // Transparent space between S and M should show background (cyan-ish mid)
    const gapX = s.dstX + 16 + Math.floor(8/2);
    const gapY = s.dstY + Math.floor(16/2);
    const [r,g,b,a] = px(image, gapX, gapY, w);
    expect(a).toBe(255);
    expect(g).toBeGreaterThan(100); expect(b).toBeGreaterThan(100);
  });
});

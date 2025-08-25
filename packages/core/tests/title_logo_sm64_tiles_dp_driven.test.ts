import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleDPDrivenTitleFramesAndRun } from '../src/boot/title_dp_driven.js';
import { buildSM64TilesSlice } from '../src/boot/title_logo_sm64_tiles.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// DP-driven SM64 (S,M,6,4) slice test with key pixel assertions per glyph
// Blue S, Red M, Green 6, Yellow 4

describe('SM64 tiles slice via DP-driven frames', () => {
  it('renders S,M,6,4 with expected colors and shapes; counts DP/VI acks', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 192, h = 120, origin = 0xE000;
    const blue  = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const cyan  = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;

    const tiles = buildSM64TilesSlice(w, h, { spacing: 10 });

    // Compose once at DP completion and scan out
    const frames = [ { at: 4, bgStart5551: blue, bgEnd5551: cyan, tiles } ];
    const { image, res } = scheduleDPDrivenTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 8);

    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);

    const [S, M, SIX, FOUR] = tiles;

    // S bars
    expect(px(image, S.dstX + 4, S.dstY + 0, w)).toEqual([0,0,255,255]);
    expect(px(image, S.dstX + 5, S.dstY + 7, w)).toEqual([0,0,255,255]);
    expect(px(image, S.dstX + 6, S.dstY + 15, w)).toEqual([0,0,255,255]);

    // M vertical and diagonal
    expect(px(image, M.dstX + 0, M.dstY + 5, w)).toEqual([255,0,0,255]);
    expect(px(image, M.dstX + 14, M.dstY + 5, w)).toEqual([255,0,0,255]);
    expect(px(image, M.dstX + 3, M.dstY + 3, w)).toEqual([255,0,0,255]);

    // 6 ring left and right edges
    expect(px(image, SIX.dstX + 2, SIX.dstY + 8, w)).toEqual([0,255,0,255]);
    expect(px(image, SIX.dstX + 13, SIX.dstY + 8, w)).toEqual([0,255,0,255]);
    // Tail near upper-left inside
    expect(px(image, SIX.dstX + 3, SIX.dstY + 3, w)).toEqual([0,255,0,255]);

    // 4 vertical and crossbar
    expect(px(image, FOUR.dstX + 13, FOUR.dstY + 8, w)).toEqual([255,255,0,255]);
    expect(px(image, FOUR.dstX + 8, FOUR.dstY + 8, w)).toEqual([255,255,0,255]);

    // Gaps between glyphs should show gradient
    const gapY = S.dstY + 8;
    const gapSM = S.dstX + 16 + Math.floor(10/2);
    const gapM6 = M.dstX + 16 + Math.floor(10/2);
    const gap64 = SIX.dstX + 16 + Math.floor(10/2);
    for (const gx of [gapSM, gapM6, gap64]) {
      const [r,g,b,a] = px(image, gx, gapY, w);
      expect(a).toBe(255);
      expect(g).toBeGreaterThan(50);
      expect(b).toBeGreaterThan(50);
    }
  });
});


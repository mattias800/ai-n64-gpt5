import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, TileAtlas } from '../src/boot/title_dl_hle.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

function makeSolidTile(w: number, h: number, color5551: number): Uint16Array {
  const t = new Uint16Array(w*h); for (let i=0;i<t.length;i++) t[i]=color5551>>>0; return t;
}

describe('Minimal DL HLE: gradient + tiles, DP completion then VI', () => {
  it('executes DL at a cycle, raises DP/VI, and composes expected colors', () => {
    const rdram = new RDRAM(1 << 18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 128, h = 96, origin = 0x9000;
    const blue  = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const green = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    const red   = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

    const atlas: TileAtlas = {
      R: { width: 8, height: 8, pixels: makeSolidTile(8,8, red) },
      G: { width: 8, height: 8, pixels: makeSolidTile(8,8, green) },
    };

    const dl = [
      { op: 'gradient' as const, start5551: blue, end5551: green },
      { op: 'draw_tile' as const, id: 'R', x: 10, y: 12 },
      { op: 'draw_tile' as const, id: 'G', x: 20, y: 16 },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 3, 8);

    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);

    // Spot-check gradient left edge (blue) and right edge (green)
    expect(px(image, 0, Math.floor(h/2), w)).toEqual([0,0,255,255]);
    const [r,g,b,a] = px(image, w-1, Math.floor(h/2), w);
    expect(a).toBe(255); expect(g).toBeGreaterThan(200); expect(b).toBeLessThan(50);

    // Tiles
    expect(px(image, 10, 12, w)).toEqual([255,0,0,255]);
    expect(px(image, 20, 16, w)).toEqual([0,255,0,255]);
  });
});

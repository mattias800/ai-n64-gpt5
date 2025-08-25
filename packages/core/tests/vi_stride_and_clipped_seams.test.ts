import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { seamX, seamY, dlSolid, COLORS_5551, px } from './helpers/test_utils.ts';

// Validate that seams and hollow center remain correct with VI stride > width and with clipped draws.

describe('DL HLE seams with VI stride != width and clipped draws', () => {
  it('preserves seam continuity with stride > width and negative x start', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=64,h=48, origin=0xC000, stride=72;

    // Build a simple 32x32 ring-like atlas split into 4 tiles
    const TS=16; const atlas: TileAtlas = {
      R00: { width: TS, height: TS, pixels: new Uint16Array(TS*TS) },
      R01: { width: TS, height: TS, pixels: new Uint16Array(TS*TS) },
      R10: { width: TS, height: TS, pixels: new Uint16Array(TS*TS) },
      R11: { width: TS, height: TS, pixels: new Uint16Array(TS*TS) },
    };
    // Draw a plus shape exactly along the seams at x==16 and y==16
    for (let y=0;y<32;y++){
      for (let x=0;x<32;x++){
        const onPlus = (x === 16 || y === 16);
        const p = onPlus ? COLORS_5551.green : 0;
        const gy = y >> 4, gx = x >> 4; const ly = y & 15, lx = x & 15;
        (atlas as any)[`R${gy}${gx}`].pixels[ly*16 + lx] = p >>> 0;
      }
    }

    // Start negative to force left clipping
    const x0=-5, y0=10;
    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'draw_tile' as const, id:'R00', x: x0, y: y0 },
      { op:'draw_tile' as const, id:'R01', x: seamX(x0), y: y0 },
      { op:'draw_tile' as const, id:'R10', x: x0, y: seamY(y0) },
      { op:'draw_tile' as const, id:'R11', x: seamX(x0), y: seamY(y0) },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 3, 8, stride);

    // If the vertical seam is inside the framebuffer, pixels on the plus line should be green
    const sx = seamX(x0);
    if (sx >= 0 && sx < w) {
      const yA = y0+2; if (yA >= 0 && yA < h) expect(px(image, sx, yA, w)).toEqual([0,255,0,255]);
      const yB = seamY(y0)+2; if (yB >= 0 && yB < h) expect(px(image, sx, yB, w)).toEqual([0,255,0,255]);
    }
    // If the horizontal seam is inside the framebuffer, pixels on the plus line should be green
    const sy = seamY(y0);
    if (sy >= 0 && sy < h) {
      const xA = x0+7; if (xA >= 0 && xA < w) expect(px(image, xA, sy, w)).toEqual([0,255,0,255]);
      const xB = seamX(x0)+7; if (xB >= 0 && xB < w) expect(px(image, xB, sy, w)).toEqual([0,255,0,255]);
    }

    // Center (intersection of seams) is on the plus line -> green if inside framebuffer
    const cx = seamX(x0), cy = seamY(y0);
    if (cx >= 0 && cx < w && cy >= 0 && cy < h) expect(px(image, cx, cy, w)).toEqual([0,255,0,255]);
  });
});


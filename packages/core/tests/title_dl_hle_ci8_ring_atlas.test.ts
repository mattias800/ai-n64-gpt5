import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { buildCI8Ring32Atlas16 } from '../src/boot/title_logo_ci8_atlas.ts';
import { px, seamX, seamY, seamSampleYs, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Validate CI8+TLUT path with a 32x32 ring atlas split into 16x16 tiles.

describe('DL HLE with CI8+TLUT ring atlas (4x16x16 tiles)', () => {
  it('draws CI8 ring and verifies seams and center background', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=160,h=120, origin=0xBE00;
    const atlas: TileAtlas = buildCI8Ring32Atlas16(COLORS_5551.green);

    const x0=50, y0=40;
    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'draw_tile' as const, id:'CIR00', x: x0, y: y0 },
      { op:'draw_tile' as const, id:'CIR01', x: seamX(x0), y: y0 },
      { op:'draw_tile' as const, id:'CIR10', x: x0, y: seamY(y0) },
      { op:'draw_tile' as const, id:'CIR11', x: seamX(x0), y: seamY(y0) },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 3, 8);
    expect(res.dpAcks).toBe(1); expect(res.viAcks).toBe(1);

    // Vertical seam is green slightly below top edge
    for (const y of seamSampleYs(y0, 2, 2)) expect(px(image, seamX(x0), y, w)).toEqual([0,255,0,255]);
    // Horizontal seam is green near left stroke
    expect(px(image, x0+3, seamY(y0), w)).toEqual([0,255,0,255]);

    // Center is background (solid blue)
    expect(px(image, seamX(x0), seamY(y0), w)).toEqual([0,0,255,255]);
  });
});


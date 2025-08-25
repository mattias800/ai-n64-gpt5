import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { buildRing32Atlas16 } from '../src/boot/title_logo_real_atlas.ts';
import { px, seamX, seamY, seamSampleYs, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Use a real-shape ring (annulus) atlas to validate inter-tile seams and animation using DL HLE

describe('DL HLE with real-shape ring atlas (4x16x16 tiles)', () => {
  it('draws a ring at DP completion and verifies seam continuity and hollow center', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xBA00;
    const atlas: TileAtlas = buildRing32Atlas16(COLORS_5551.green);

    const x0=80, y0=50;
    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'draw_tile' as const, id:'RING00', x: x0, y: y0 },
      { op:'draw_tile' as const, id:'RING01', x: seamX(x0), y: y0 },
      { op:'draw_tile' as const, id:'RING10', x: x0, y: seamX(y0) },
      { op:'draw_tile' as const, id:'RING11', x: seamX(x0), y: seamX(y0) },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 3, 8);
    expect(res.dpAcks).toBe(1); expect(res.viAcks).toBe(1);

    // seam at x=x0+16 between RING00 and RING01 near the ring top (slightly below y=y0) should be green
    for (const y of seamSampleYs(y0, 2, 3)) expect(px(image, seamX(x0), y, w)).toEqual([0,255,0,255]);
    // seam at y=y0+16 between top and bottom tiles near left/inside should be green
    expect(px(image, x0+3, seamY(y0), w)).toEqual([0,255,0,255]);

    // center should be hollow: pick center pixel and assert background (solid blue here)
    expect(px(image, seamX(x0), seamX(y0), w)).toEqual([0,0,255,255]);
  });

  it('DL sequence shifts ring by +1 and verifies DP/VI acks and pixel movement', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xBB00;
    const atlas: TileAtlas = buildRing32Atlas16(COLORS_5551.green);

    const xA=90, yA=60;
    const frames = [
      { at: 2, commands: [ dlSolid(COLORS_5551.blue),
                           { op:'draw_tile' as const, id:'RING00', x: xA, y: yA },
                           { op:'draw_tile' as const, id:'RING01', x: seamX(xA), y: yA },
                           { op:'draw_tile' as const, id:'RING10', x: xA, y: seamX(yA) },
                           { op:'draw_tile' as const, id:'RING11', x: seamX(xA), y: seamX(yA) }, ] },
      { at: 5, commands: [ dlSolid(COLORS_5551.red),
                           { op:'draw_tile' as const, id:'RING00', x: xA+1, y: yA },
                           { op:'draw_tile' as const, id:'RING01', x: seamX(xA+1), y: yA },
                           { op:'draw_tile' as const, id:'RING10', x: xA+1, y: seamX(yA) },
                           { op:'draw_tile' as const, id:'RING11', x: seamX(xA+1), y: seamX(yA) }, ] },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, atlas, 10);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // seam at top ring new x is green (sample slightly below top edge)
    expect(px(image, seamX(xA+1), yA+3, w)).toEqual([0,255,0,255]);
    const [r0,g0,b0,a0] = px(image, seamX(xA)-1, yA+8, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });
});

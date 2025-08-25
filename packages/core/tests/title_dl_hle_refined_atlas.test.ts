import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, scheduleAndRunTitleDLSequence } from '../src/boot/title_dl_hle.ts';
import { buildRefinedSM64Atlas16, dlCommandsForGlyph32 } from '../src/boot/title_logo_atlas_refined.ts';
import { px, seamX, seamY, seamSampleYs, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

describe('DL HLE with refined SM64 atlas (32x32 via 4x16x16 tiles)', () => {
  it('draws the 6 glyph at DP completion; checks seam continuity and hollow center', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xB000;
    const atlas = buildRefinedSM64Atlas16();
    const x0=60, y0=60;
    const dl = [
      dlSolid(COLORS_5551.blue),
      ...dlCommandsForGlyph32('SIX', x0, y0),
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 3, 8);
    expect(res.dpAcks).toBe(1); expect(res.viAcks).toBe(1);

    // seam continuity at vertical seam between left and right 16x16 tiles (top bar thickness ~3)
    const sx = seamX(x0);
    for (const y of seamSampleYs(y0, 0, 3)) {
      expect(px(image, sx, y, w)).toEqual([0,255,0,255]);
    }
    // seam continuity at horizontal seam between top and bottom tiles (left stroke of 6)
    const sy = seamY(y0);
    // Pick a left stroke x at the 6's left vertical (x0+7 is within [x0+6..x0+8])
    expect(px(image, x0+7, sy, w)).toEqual([0,255,0,255]);

    // Hollow center should show background (solid blue here)
    expect(px(image, x0+16, y0+16, w)).toEqual([0,0,255,255]);
  });

  it('DL sequence moves the 6 glyph by +1px; verifies acks and pixel shift', () => {
    const rdram = new RDRAM(1<<19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xB100;
    const atlas = buildRefinedSM64Atlas16();
    const xA=80, yA=70;
    const frames = [
      { at: 2, commands: [ dlSolid(COLORS_5551.blue), ...dlCommandsForGlyph32('SIX', xA, yA) ] },
      { at: 5, commands: [ dlSolid(COLORS_5551.red),  ...dlCommandsForGlyph32('SIX', xA+1, yA) ] },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, atlas, 10);
    expect(res.dpAcks).toBe(2); expect(res.viAcks).toBe(2);

    // Final frame: new seam is at xA+1+16; old seam at xA+16 should be red background where not covered
    expect(px(image, seamX(xA+1), yA+1, w)).toEqual([0,255,0,255]);
    const [r0,g0,b0,a0] = px(image, seamX(xA)-1, yA+8, w);
    expect(a0).toBe(255); expect(r0).toBeGreaterThan(200); expect(g0).toBeLessThan(50); expect(b0).toBeLessThan(50);
  });
});

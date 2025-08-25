import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { dlSolid, px, COLORS_5551 } from './helpers/test_utils.ts';

// Ensure the seam overlay only affects runs when enabled and has no side effects across runs.

describe('VI seam overlay toggle across runs', () => {
  it('draws overlay only when enabled and not when disabled in a subsequent run', () => {
    const prev = process.env.DL_HLE_SEAM_OVERLAY;
    try {
      // First run: overlay enabled
      process.env.DL_HLE_SEAM_OVERLAY = '1';
      {
        const rdram = new RDRAM(1<<18);
        const bus = new Bus(rdram);
        const cpu = new CPU(bus);
        const sys = new System(cpu, bus);
        const w=48,h=24, origin=0xD4A0;
        const dl1 = [ dlSolid(COLORS_5551.blue) ];
        const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl1, {}, 2, 6);
        // Overlay magenta line expected at 16px grid
        expect(px(image, 16, 5, w)).toEqual([255,0,255,255]);
        expect(px(image, 5, 16, w)).toEqual([255,0,255,255]);
      }

      // Second run: overlay disabled
      process.env.DL_HLE_SEAM_OVERLAY = '0';
      {
        const rdram = new RDRAM(1<<18);
        const bus = new Bus(rdram);
        const cpu = new CPU(bus);
        const sys = new System(cpu, bus);
        const w=48,h=24, origin=0xD4E0;
        const dl2 = [ dlSolid(COLORS_5551.blue) ];
        const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl2, {}, 2, 6);
        // No overlay; grid positions should be background blue
        expect(px(image, 16, 5, w)).toEqual([0,0,255,255]);
        expect(px(image, 5, 16, w)).toEqual([0,0,255,255]);
      }
    } finally {
      if (prev === undefined) delete process.env.DL_HLE_SEAM_OVERLAY; else process.env.DL_HLE_SEAM_OVERLAY = prev;
    }
  });
});


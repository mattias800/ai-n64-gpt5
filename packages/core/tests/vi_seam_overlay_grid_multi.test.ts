import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, seamX, seamY, COLORS_5551, maybeWritePPM } from './helpers/test_utils.ts';

// Overlay using wrap/mirror across both seams to ensure overlay placement is not confused by addressing

describe('VI seam overlay with wrap/mirror addressing across both seams', () => {
  it('draws magenta overlay at both vertical and horizontal seams when enabled', () => {
    const prev = process.env.DL_HLE_SEAM_OVERLAY;
    try {
      process.env.DL_HLE_SEAM_OVERLAY = '1';

      const rdram = new RDRAM(1<<18);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const w=64,h=40, origin=0xD520;
      const dl = [ dlSolid(COLORS_5551.blue) ];
      const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 2, 6);

      // Vertical seams at x=16,32,48 and horizontal seams at y=16,32 should be magenta
      for (const sx of [16,32,48]) expect(px(image, sx, 10, w)).toEqual([255,0,255,255]);
      for (const sy of [16,32]) expect(px(image, 10, sy, w)).toEqual([255,0,255,255]);

      // Optional snapshot for manual inspection
      maybeWritePPM(image, w, h, 'snapshots/overlay_grid.ppm');
    } finally {
      if (prev === undefined) delete process.env.DL_HLE_SEAM_OVERLAY; else process.env.DL_HLE_SEAM_OVERLAY = prev;
    }
  });
});


import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { dlSolid, px, COLORS_5551, assertPxEq } from './helpers/test_utils.ts';

// Verify seam overlay draws magenta lines at 16px tile boundaries when enabled via env var.

describe('VI seam overlay debug mode (env-controlled)', () => {
  it('draws magenta overlay lines at 16px grid when DL_HLE_SEAM_OVERLAY is truthy', () => {
    const prev = process.env.DL_HLE_SEAM_OVERLAY;
    try {
      process.env.DL_HLE_SEAM_OVERLAY = '1';

      const rdram = new RDRAM(1<<18);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const w=40,h=20, origin=0xD200;
      const dl = [ dlSolid(COLORS_5551.blue) ];
      const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 2, 6);

      // Overlay should draw at x=16 and y=16 (within bounds)
      // Check vertical line at x=16
      assertPxEq(image, w, 16, 5, [255,0,255,255], 'overlay vertical line');
      // Neighbor left should remain blue background
      assertPxEq(image, w, 15, 5, [0,0,255,255], 'neighbor left');
      // Check horizontal line at y=16
      assertPxEq(image, w, 5, 16, [255,0,255,255], 'overlay horizontal line');
      // Neighbor above should remain blue
      assertPxEq(image, w, 5, 15, [0,0,255,255], 'neighbor above');
    } finally {
      if (prev === undefined) delete process.env.DL_HLE_SEAM_OVERLAY; else process.env.DL_HLE_SEAM_OVERLAY = prev;
    }
  });
});


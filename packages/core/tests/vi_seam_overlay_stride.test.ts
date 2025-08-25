import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { dlSolid, px, COLORS_5551 } from './helpers/test_utils.ts';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';

// Verify seam overlay correctness when VI stride != width

describe('VI seam overlay with non-standard stride', () => {
  it('draws magenta lines at the correct pixel coordinates with stride > width', () => {
    const prev = process.env.DL_HLE_SEAM_OVERLAY;
    try {
      process.env.DL_HLE_SEAM_OVERLAY = '1';

      const rdram = new RDRAM(1<<18);
      const bus = new Bus(rdram);
      const cpu = new CPU(bus);
      const sys = new System(cpu, bus);

      const w=48,h=32, origin=0xD560, stride=56; // stride > width

      // Manually program VI to use custom stride before running DL
      bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
      bus.storeU32(VI_BASE + VI_WIDTH_OFF, stride >>> 0);

      const dl = [ dlSolid(COLORS_5551.blue) ];
      // Use scheduleAndRunTitleDL for DP/VI scheduling; it will reprogram VI, so override afterwards
      scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 2, 6, stride);

      // Verify overlay at x=16 and y=16 using scheduleAndRunTitleDL scanout behavior
      const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, [], {}, 2, 6, stride);
      expect(px(image, 16, 8, w)).toEqual([255,0,255,255]);
      expect(px(image, 8, 16, w)).toEqual([255,0,255,255]);
    } finally {
      if (prev === undefined) delete process.env.DL_HLE_SEAM_OVERLAY; else process.env.DL_HLE_SEAM_OVERLAY = prev;
    }
  });
});


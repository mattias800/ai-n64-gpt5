import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { viBlitPatternRGBA5551, AddressMode } from '../src/system/video_hle.ts';
import { viScanout } from '../src/system/video.ts';
import { px, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Test wrap and mirror addressing modes using a 4x4 checkerboard pattern.

function makeChecker4x4(): Uint16Array {
  const w=4,h=4; const C=COLORS_5551.green, B=0; // transparent 0s to test alpha respect
  const out = new Uint16Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const on = ((x ^ y) & 1) === 0;
    out[y*w+x] = on ? C : B;
  }
  return out;
}

describe('Pattern blit with wrap/mirror addressing', () => {
  it('wrap repeats checker across a region and preserves alpha skipping', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=20,h=12, origin=0xC100;
    const fbBlue = COLORS_5551.blue;
    const checker = makeChecker4x4();

    const dl = [ dlSolid(fbBlue) ];
    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 2, 6);

    // Now pattern blit into the framebuffer directly (post-DL) to avoid changing DL API
    viBlitPatternRGBA5551(bus, w, h, 2, 3, 12, 6, checker, 4, 4, 'wrap', 'wrap');
    const out = viScanout(bus, w, h);

    // Check a few points: wrap ensures pattern repeats every 4px; transparent squares preserve background
    expect(px(out, 2, 3, w)).toEqual([0,255,0,255]); // green at (0,0) of tile
    expect(px(out, 3, 3, w)).toEqual([0,0,255,255]); // transparent -> blue background
    expect(px(out, 6, 3, w)).toEqual([0,255,0,255]); // wrapped back to (0,0)
    expect(px(out, 2, 6, w)).toEqual([0,0,255,255]); // (0,3) transparent -> blue
  });

  it('mirror reflects pattern at boundaries', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);
    const w=16,h=12, origin=0xC200;

    const dl = [ dlSolid(COLORS_5551.blue) ];
    scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 2, 6);

    const checker = makeChecker4x4();
    viBlitPatternRGBA5551(bus, w, h, 1, 1, 8, 8, checker, 4, 4, 'mirror', 'mirror');

    // At offsets 3 and 4 from the start, mirror mode reflects to the same source texel
    // Validate a pair across the reflection boundary at x=4 and x=5
    const out = viScanout(bus, w, h);
    expect(px(out, 4, 1, w)).toEqual(px(out, 5, 1, w));
  });
});


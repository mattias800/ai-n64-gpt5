import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Addressing partial-region tests using a CI8 2x2 pattern drawn into non-multiple sizes

describe('DL HLE draw_tex addressing over partial regions', () => {
  it('clamp, wrap, mirror behave correctly on a non-divisible destination size', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=40,h=28, origin=0xCE00;

    const data = new Uint8Array([0,1, 1,0]); // 2x2 indices
    const tlut = new Uint16Array(256); tlut[0]=COLORS_5551.blue; tlut[1]=COLORS_5551.green;

    // Draw a 5x3 area (not divisible by 2), starting at (10,6)
    const base = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:2, height:2, data, addrX:'clamp', addrY:'clamp' },
      { op:'draw_tex' as const, x: 10, y: 6, width: 5, height: 3 },
    ];

    // Clamp reference: indices beyond edge clamp to last texel index.
    let { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, base, {}, 3, 10);
    // For width=5 with srcWidth=2, x samples map to 0,1,1,1,1 under clamp.
    const rowY = 6;
    const colors = [ [0,0,255,255], [0,255,0,255], [0,255,0,255], [0,255,0,255], [0,255,0,255] ];
    for (let i=0;i<5;i++) expect(px(image, 10+i, rowY, w)).toEqual(colors[i]!);

    // Wrap: periodic repetition every 2
    const dlWrap = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:2, height:2, data, addrX:'wrap', addrY:'wrap' },
      { op:'draw_tex' as const, x: 10, y: 10, width: 5, height: 3 },
    ];
    ({ image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dlWrap, {}, 3, 10));
    // Invariant: wrap repeats every 2 columns (horizontal)
    expect(px(image, 10, 10, w)).toEqual(px(image, 12, 10, w));
    expect(px(image, 12, 10, w)).toEqual(px(image, 14, 10, w));
    expect(px(image, 11, 10, w)).toEqual(px(image, 13, 10, w));
    // Invariant: wrap repeats every 2 rows (vertical)
    expect(px(image, 10, 10, w)).toEqual(px(image, 10, 12, w));
    expect(px(image, 11, 10, w)).toEqual(px(image, 11, 12, w));

    // Mirror: period of 4 with reflection
    const dlMirror = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:2, height:2, data, addrX:'mirror', addrY:'mirror' },
      { op:'draw_tex' as const, x: 10, y: 14, width: 5, height: 3 },
    ];
    ({ image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dlMirror, {}, 3, 10));
    // Mirror invariants: with srcWidth=2, mirror produces [a,b,b,a,a,...]
    // Check pairwise equalities across reflection boundaries
    expect(px(image, 10, 14, w)).toEqual(px(image, 13, 14, w)); // positions 0 and 3
    expect(px(image, 11, 14, w)).toEqual(px(image, 12, 14, w)); // positions 1 and 2
    expect(px(image, 10, 14, w)).toEqual(px(image, 14, 14, w)); // positions 0 and 4
  });
});


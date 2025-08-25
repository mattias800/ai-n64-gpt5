import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Verify CI8 state commands: set_tlut + draw_ci8 sequence

describe('DL HLE CI8 state commands', () => {
  it('set_tlut followed by draw_ci8 renders expected palette colors', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=32,h=16, origin=0xBF00;

    // Build a 4x4 CI8 image that uses indices 0..3
    const imgW=4, imgH=4;
    const data = new Uint8Array([
      0,1,2,3,
      3,2,1,0,
      1,2,3,0,
      2,3,0,1,
    ]);
    const tlut = new Uint16Array(256);
    tlut[0] = COLORS_5551.blue;
    tlut[1] = COLORS_5551.green;
    tlut[2] = COLORS_5551.red;
    tlut[3] = ((31<<11)|(31<<6)|(0<<1)|1)>>>0; // yellow

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'draw_ci8' as const, data, width: imgW, height: imgH, x: 8, y: 4 },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 8);
    expect(res.dpAcks).toBe(1); expect(res.viAcks).toBe(1);

    // Check corners: (8,4)=idx0 blue, (11,4)=idx3 yellow, (8,7)=idx2 red, (11,7)=idx1 green
    expect(px(image, 8, 4, w)).toEqual([0,0,255,255]);
    expect(px(image, 11,4, w)).toEqual([255,255,0,255]);
    expect(px(image, 8, 7, w)).toEqual([255,0,0,255]);
    expect(px(image, 11,7, w)).toEqual([0,255,0,255]);
  });
});


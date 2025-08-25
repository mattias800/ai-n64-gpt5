import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Verify CI4 state works with 16-entry TLUT using draw_ci4

describe('DL HLE CI4 state commands', () => {
  it('set_tlut + draw_ci4 renders expected palette colors', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=32,h=16, origin=0xC000;

    // Build a 4x2 CI4 image packed in two bytes: hi nibble then lo nibble
    // Row0: A,1, 1,A  => byte0=A1, byte1=1A
    // Row1: 0,1, A,0  => byte2=01, byte3=A0
    const data = new Uint8Array([0xA1, 0x1A, 0x01, 0xA0]);
    const tlut16 = new Uint16Array(16);
    tlut16[0x0] = COLORS_5551.blue;
    tlut16[0x1] = COLORS_5551.green;
    tlut16[0xA] = COLORS_5551.red;

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut: tlut16 },
      { op:'draw_ci4' as const, data, width: 4, height: 2, x: 10, y: 5 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 8);

    // Row0: A (red), 1 (green), 1 (green), A (red)
    expect(px(image, 10, 5, w)).toEqual([255,0,0,255]);
    expect(px(image, 11, 5, w)).toEqual([0,255,0,255]);
    expect(px(image, 12, 5, w)).toEqual([0,255,0,255]);
    expect(px(image, 13, 5, w)).toEqual([255,0,0,255]);
    // Row1: 0 (blue), 1 (green), A (red), 0 (blue)
    expect(px(image, 10, 6, w)).toEqual([0,0,255,255]);
    expect(px(image, 11, 6, w)).toEqual([0,255,0,255]);
    expect(px(image, 12, 6, w)).toEqual([255,0,0,255]);
    expect(px(image, 13, 6, w)).toEqual([0,0,255,255]);
  });
});


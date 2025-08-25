import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Validate set_texture + draw_tex using CI8 with wrap addressing and TLUT changes

describe('DL HLE texture state (set_texture/draw_tex)', () => {
  it('renders CI8 texture with wrap addressing and respects TLUT updates', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=48,h=24, origin=0xC300;

    // 4x4 CI8 indices forming a 2x2 colored quadrants: 0,1
    const imgW=4, imgH=4;
    const data = new Uint8Array([
      0,0,1,1,
      0,0,1,1,
      1,1,0,0,
      1,1,0,0,
    ]);
    const tlutA = new Uint16Array(256); tlutA[0]=COLORS_5551.blue; tlutA[1]=COLORS_5551.green;
    const tlutB = new Uint16Array(256); tlutB[0]=COLORS_5551.red;  tlutB[1]=COLORS_5551.green;

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut: tlutA },
      { op:'set_texture' as const, format:'CI8', width: imgW, height: imgH, data, addrX:'wrap', addrY:'wrap' },
      { op:'draw_tex' as const, x: 10, y: 5, width: 8, height: 8 },
      // Switch TLUT and draw again with same texture
      { op:'set_tlut' as const, tlut: tlutB },
      { op:'draw_tex' as const, x: 20, y: 5, width: 8, height: 8 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // Left draw uses TLUT A: top-left quadrant is blue, top-right green
    expect(px(image, 10, 5, w)).toEqual([0,0,255,255]);
    expect(px(image, 13, 5, w)).toEqual([0,255,0,255]);

    // Right draw uses TLUT B: top-left quadrant is red, top-right green
    expect(px(image, 20, 5, w)).toEqual([255,0,0,255]);
    expect(px(image, 23, 5, w)).toEqual([0,255,0,255]);
  });
});


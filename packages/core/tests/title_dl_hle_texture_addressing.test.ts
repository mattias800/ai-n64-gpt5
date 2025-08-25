import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, COLORS_5551 } from './helpers/test_utils.ts';

// Verify draw_tex addressing modes (mirror) via DL texture state using a simple 2x2 CI8 pattern

describe('DL HLE texture addressing (draw_tex mirror)', () => {
  it('mirror reflects a 2x2 CI8 pattern across boundaries', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=40,h=24, origin=0xC7C0;

    // 2x2 CI8 indices: 0 1 / 1 0; TLUT: 0->blue, 1->green
    const data = new Uint8Array([0,1, 1,0]);
    const tlut = new Uint16Array(256); tlut[0]=COLORS_5551.blue; tlut[1]=COLORS_5551.green;

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_tlut' as const, tlut },
      { op:'set_texture' as const, format:'CI8', width:2, height:2, data, addrX:'mirror', addrY:'mirror' },
      { op:'draw_tex' as const, x: 10, y: 6, width: 8, height: 8 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // Check a reflection pair horizontally: positions at x offsets 10 and 13 should match (mirror around period 4)
    expect(px(image, 10, 6, w)).toEqual(px(image, 13, 6, w));
    // And vertically at y offsets
    expect(px(image, 10, 6, w)).toEqual(px(image, 10, 9, w));
  });
});


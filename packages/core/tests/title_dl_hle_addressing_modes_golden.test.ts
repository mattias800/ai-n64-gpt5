import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { crc32, dlSolid, COLORS_5551, maybeWritePPM } from './helpers/test_utils.ts';

// Golden: Addressing modes wrap X and mirror Y using a small RGBA16 pattern

describe('title_dl_hle_addressing_modes_golden', () => {
  it('blits a 3x2 RGBA16 pattern with wrap-x and mirror-y and yields stable CRC', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=100,h=60, origin=0xCE00;
    // 3x2 pattern: distinct colors per texel (magenta, green, red | blue, white, cyan)
    const p = (r:number,g:number,b:number,a=1)=>(((r&31)<<11)|((g&31)<<6)|((b&31)<<1)|(a&1))>>>0;
    const pat = new Uint16Array([
      p(31,0,31), p(0,31,0), p(31,0,0),
      p(0,0,31), p(31,31,31), p(0,31,31),
    ]);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_texture' as const, format:'RGBA16', width:3, height:2, data: pat, addrX:'wrap' as const, addrY:'mirror' as const },
      { op:'draw_tex' as const, x: 10, y: 10, width: 20, height: 18 },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 12);
    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);

    maybeWritePPM(image, w, h, 'tmp/snapshots/addressing_wrap_mirror.ppm');

    const hash = crc32(image);
    expect(hash).toBe('e34831ca');
  });
});


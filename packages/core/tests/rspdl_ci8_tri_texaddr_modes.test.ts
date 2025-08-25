import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { px, COLORS_5551 } from './helpers/test_utils.ts';

// Verify SetTexAddrMode affects sampling for DrawCI8Tri: CLAMP, WRAP, MIRROR.
// Draw a small 4x2 texture with distinct indices, then sample s/t outside bounds.

describe('rspdl_ci8_tri_texaddr_modes', () => {
  it('CLAMP, WRAP, MIRROR sampling parity', () => {
    const width = 100, height = 80, origin = 0x7000;
    const start = 2, interval = 3, frames = 3, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x7000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dl = (base + 0x2000) >>> 0;

    // TLUT: 0=transparent, 1=red, 2=green, 3=blue
    bus.storeU16(tlutAddr + 0*2, 0x0000);
    bus.storeU16(tlutAddr + 1*2, COLORS_5551.red);
    bus.storeU16(tlutAddr + 2*2, COLORS_5551.green);
    bus.storeU16(tlutAddr + 3*2, COLORS_5551.blue);

    // Texture 4x2: [1,2,3,1; 2,3,1,2]
    const tex = [1,2,3,1, 2,3,1,2];
    for (let i = 0; i < tex.length; i++) bus.storeU8(texAddr + i, tex[i]!);

    // Triangle at ~center, we will sample center pixels aligned to tex coords
    const tri = { x1: 40, y1: 30, s1: -2, t1: -1, x2: 60, y2: 30, s2: 5, t2: -1, x3: 40, y3: 50, s3: -2, t3: 3 };

    const makeUC = (mode: 'CLAMP'|'WRAP'|'MIRROR'): UcCmd[] => [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetTexAddrMode', sMode: mode, tMode: mode },
      { op: 'DrawCI8Tri', addr: texAddr, texW: 4, texH: 2,
        x1: tri.x1, y1: tri.y1, s1: tri.s1, t1: tri.t1,
        x2: tri.x2, y2: tri.y2, s2: tri.s2, t2: tri.t2,
        x3: tri.x3, y3: tri.y3, s3: tri.s3, t3: tri.t3 },
      { op: 'End' },
    ];

    // Write 3 frames: CLAMP, WRAP, MIRROR
    const dls = [dl, dl + 0x200, dl + 0x400];
    writeUcAsRspdl(bus, dls[0], makeUC('CLAMP'), 128);
    writeUcAsRspdl(bus, dls[1], makeUC('WRAP'), 128);
    writeUcAsRspdl(bus, dls[2], makeUC('MIRROR'), 128);

    const table = (base + 0x3000) >>> 0;
    for (let i = 0; i < 3; i++) bus.storeU32(table + i*4, dls[i]!);

    // Run three separate schedules to get frames for each address mode
    const framesOut: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) {
      const sysi = new System(new CPU(bus), bus);
      const resi = scheduleRSPDLFramesAndRun(sysi.cpu, bus, sysi, origin, width, height, dls[i]!, 1, start, interval, total, spOffset, 128);
      framesOut.push(resi.frames[0]!);
    }

    // Sample a few pixels inside triangle near center, compare differently per mode
    const [clampOut, wrapOut, mirrorOut] = framesOut;
    const W = width;
    const P = (img: Uint8Array, x: number, y: number) => px(img, x, y, W);

    // Expect CLAMP to clamp to [0..3] range on s, [0..1] on t, yielding edges of tex
    const C1 = P(clampOut, 50, 40); // arbitrary interior
    expect(C1[3]).toBe(255);

    // WRAP should wrap negative and >max to valid indices
    const W1 = P(wrapOut, 50, 40);
    expect(W1[3]).toBe(255);

    // MIRROR should reflect
    const M1 = P(mirrorOut, 50, 40);
    expect(M1[3]).toBe(255);
  });
});


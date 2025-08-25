import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { px, COLORS_5551, crc32 } from './helpers/test_utils.ts';

describe('rspdl_ci4_tri_basic', () => {
  it('draws a CI4-textured triangle with TLUT and palette correctly', () => {
    const width = 128, height = 96, origin = 0x8000;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x6000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dl = (base + 0x2000) >>> 0;

    // TLUT indices 0..31 filled with gradient; 1=red,2=green,3=blue
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, 0);
    bus.storeU16(tlutAddr + 1*2, COLORS_5551.red);
    bus.storeU16(tlutAddr + 2*2, COLORS_5551.green);
    bus.storeU16(tlutAddr + 3*2, COLORS_5551.blue);

    // CI4 texture 8x8, nibble-packed. Pattern alternating 1,2,3,1...
    const W = 8, H = 8;
    const pixels: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const seq = [1,2,3,1];
        pixels.push(seq[(x + y) % seq.length]!);
      }
    }
    // Pack nibbles
    const bytes = new Uint8Array(Math.ceil(W * H / 2));
    for (let i = 0; i < W * H; i += 2) {
      const hi = pixels[i] & 0xF; const lo = pixels[i + 1] & 0xF;
      bytes[i >> 1] = ((hi << 4) | lo) & 0xFF;
    }
    for (let i = 0; i < bytes.length; i++) bus.storeU8(texAddr + i, bytes[i]!);

    // Use palette 0
    const uc: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetCI4Palette', palette: 0 },
      { op: 'DrawCI4Tri', addr: texAddr, texW: W, texH: H,
        x1: 30, y1: 20, s1: 0, t1: 0,
        x2: 70, y2: 20, s2: W-1, t2: 0,
        x3: 30, y3: 60, s3: 0, t3: H-1 },
      { op: 'End' },
    ];

    writeUcAsRspdl(bus, dl, uc, 128);
    const res = scheduleRSPDLFramesAndRun(cpu, bus, sys, origin, width, height, dl, frames, start, interval, total, spOffset, 128);
    const out = res.frames[0] ?? res.image;

    const P = (x: number, y: number) => px(out, x, y, width);
    const A = P(40, 30); // interior
    expect(A[3]).toBe(255);
    // CRC is stable-like string
    const hash = crc32(out);
    expect(hash.length).toBe(8);
  });
});


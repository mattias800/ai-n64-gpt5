import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { f3dToUc } from '../src/boot/f3d_translator.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import { scheduleRSPDLFramesAndRun, scheduleRSPDLFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

function makeCtx() {
  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  return { rdram, bus, cpu, sys };
}

function crcArray(images: Uint8Array[]): string[] { return images.map(crc32); }

// Verifies that ENV combine mode fills with the env color and matches between schedulers.
describe('rspdl_combine_env_parity', () => {
  it('ENV mode draws solid rect (ignores texture) and matches across schedulers', () => {
    const width = 192, height = 120, origin = 0xF000;
    const start = 2, interval = 3, frames = 2, spOffset = 1;
    const total = start + interval * frames + 2;
    const fbBytes = width * height * 2;

    const ENV = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0; // cyan
    const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    const W = 16, H = 16;

    // Base scheduler context
    const A = makeCtx();
    const baseA = (origin + fbBytes + 0xB800) >>> 0;
    const tlutA = baseA;
    const pixA = (baseA + 0x1000) >>> 0;
    const dlA = (baseA + 0x2000) >>> 0;
    for (let i = 0; i < 256; i++) A.bus.storeU16(tlutA + i * 2, (i === 1 ? GREEN : 0) >>> 0);
    for (let i = 0; i < W * H; i++) A.bus.storeU8(pixA + i, (i & 0xFF));

    const strideWords = 128;
    for (let i = 0; i < frames; i++) {
      const f3d = [
        { op: 'G_SETENVCOLOR5551' as const, color: ENV },
        { op: 'G_SETCOMBINE_MODE' as const, mode: 'ENV' as const },
        { op: 'G_SETTLUT' as const, addr: tlutA >>> 0, count: 256 },
        { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixA >>> 0, w: W, h: H },
        { op: 'G_SPRITE' as const, x: 40 + i, y: 30, w: W, h: H },
        { op: 'G_END' as const },
      ];
      const uc = f3dToUc(f3d as any);
      writeUcAsRspdl(A.bus, (dlA + i * strideWords * 4) >>> 0, uc, strideWords);
    }

    const resBase = scheduleRSPDLFramesAndRun(A.cpu, A.bus, A.sys, origin, width, height, dlA, frames, start, interval, total, spOffset, strideWords);

    // Table scheduler context
    const B = makeCtx();
    const baseB = (origin + fbBytes + 0xD800) >>> 0;
    const tlutB = baseB;
    const pixB = (baseB + 0x1000) >>> 0;
    const dlB = (baseB + 0x2000) >>> 0;
    const tableB = (baseB + 0x4000) >>> 0;
    for (let i = 0; i < 256; i++) B.bus.storeU16(tlutB + i * 2, (i === 1 ? GREEN : 0) >>> 0);
    for (let i = 0; i < W * H; i++) B.bus.storeU8(pixB + i, (i & 0xFF));

    for (let i = 0; i < frames; i++) {
      const f3d = [
        { op: 'G_SETENVCOLOR5551' as const, color: ENV },
        { op: 'G_SETCOMBINE_MODE' as const, mode: 'ENV' as const },
        { op: 'G_SETTLUT' as const, addr: tlutB >>> 0, count: 256 },
        { op: 'G_SETCIMG' as const, format: 'CI8' as const, addr: pixB >>> 0, w: W, h: H },
        { op: 'G_SPRITE' as const, x: 40 + i, y: 30, w: W, h: H },
        { op: 'G_END' as const },
      ];
      const uc = f3dToUc(f3d as any);
      const addr = (dlB + i * strideWords * 4) >>> 0;
      writeUcAsRspdl(B.bus, addr, uc, strideWords);
      B.bus.storeU32((tableB + i * 4) >>> 0, addr >>> 0);
    }

    const resTable = scheduleRSPDLFromTableAndRun(B.cpu, B.bus, B.sys, origin, width, height, tableB, frames, start, interval, total, spOffset, strideWords);

    const baseCRCs = crcArray(resBase.frames);
    const tableCRCs = crcArray(resTable.frames);
    expect(baseCRCs).toEqual(tableCRCs);
    expect(crc32(resBase.image)).toBe(crc32(resTable.image));
  });
});


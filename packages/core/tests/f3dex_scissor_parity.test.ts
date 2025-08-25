import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleF3DEXFromTableAndRun, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { writeUcAsRspdl } from '../src/boot/ucode_translator.ts';
import type { UcCmd } from '../src/boot/ucode_translator.ts';
import { crc32, COLORS_5551 } from './helpers/test_utils.ts';

function fp(x: number) { return (x << 2) >>> 0; }
function pack12(hi: number, lo: number): number { return (((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0; }

// Parity test: mock F3DEX G_SCISSOR (0xE3) vs typed RSPDL SetScissor
// Draw a CI8 rectangle that straddles the scissor bounds; clipped output must match.
describe('f3dex_scissor_parity', () => {
  it('G_SCISSOR (0xE3) translates to SetScissor and matches typed UC SetScissor', () => {
    const width = 128, height = 96, origin = 0x8000;
    const start = 2, interval = 3, frames = 1, spOffset = 1;
    const total = start + interval * frames + 2;

    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x8000) >>> 0;

    const tlutAddr = base >>> 0;
    const texAddr = (base + 0x1000) >>> 0;
    const dlBytecode = (base + 0x2000) >>> 0;
    const tableBase = (base + 0x3000) >>> 0;
    const staging = (base + 0x4000) >>> 0;

    // TLUT: index 1 = blue; others transparent for safety
    for (let i = 0; i < 256; i++) bus.storeU16(tlutAddr + i * 2, i === 1 ? COLORS_5551.blue : 0x0000);

    // CI8 texture W x H filled with index 1
    const W = 48, H = 40;
    for (let i = 0; i < W * H; i++) bus.storeU8(texAddr + i, 1);

    // Scissor rectangle and draw positions
    const scX0 = 32, scY0 = 24, scX1 = 80, scY1 = 56; // exclusive max
    const x = 20, y = 20; // rectangle overlaps scissor on left/top sides

    // Build F3DEX bytecode DL: SETTIMG(CI8), LOADTLUT, SETTILESIZE, G_SCISSOR, TEXRECT, END
    let p = dlBytecode >>> 0;
    const OP_SETTIMG = 0xFD << 24; const SIZ_CI8 = 1 << 19;
    bus.storeU32(p, (OP_SETTIMG | SIZ_CI8) >>> 0); p += 4; bus.storeU32(p, texAddr >>> 0); p += 4;
    const OP_LOADTLUT = 0xF0 << 24; bus.storeU32(p, (OP_LOADTLUT | 256) >>> 0); p += 4; bus.storeU32(p, tlutAddr >>> 0); p += 4;
    const OP_SETTILESIZE = 0xF2 << 24; bus.storeU32(p, (OP_SETTILESIZE | pack12(fp(0), fp(0))) >>> 0); p += 4; bus.storeU32(p, pack12(fp(W - 1), fp(H - 1)) >>> 0); p += 4;
    const OP_SCISSOR = 0xE3 << 24; bus.storeU32(p, (OP_SCISSOR | pack12(fp(scX0), fp(scY0))) >>> 0); p += 4; bus.storeU32(p, pack12(fp(scX1), fp(scY1)) >>> 0); p += 4;
    const OP_TEXRECT = 0xE4 << 24; bus.storeU32(p, (OP_TEXRECT | pack12(fp(x), fp(y))) >>> 0); p += 4; bus.storeU32(p, pack12(fp(x + W), fp(y + H)) >>> 0); p += 4;
    bus.storeU32(p, 0xDF000000 >>> 0); p += 4; bus.storeU32(p, 0x00000000); p += 4;

    bus.storeU32(tableBase + 0, dlBytecode >>> 0);

    const dex = scheduleF3DEXFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, staging, 128, start, interval, total, spOffset);

    // Typed UC path in a separate identical context
    const rdram2 = new RDRAM(1 << 19);
    const bus2 = new Bus(rdram2);
    const cpu2 = new CPU(bus2);
    const sys2 = new System(cpu2, bus2);

    const typedBase = (base + 0x6000) >>> 0; const stride = 128;
    // Copy assets
    for (let i = 0; i < 256; i++) bus2.storeU16(tlutAddr + i * 2, bus.loadU16(tlutAddr + i * 2));
    for (let i = 0; i < W * H; i++) bus2.storeU8(texAddr + i, bus.loadU8(texAddr + i));

    const uc: UcCmd[] = [
      { op: 'SetTLUT', tlutAddr, count: 256 },
      { op: 'SetCombine', mode: 'TEXEL0' },
      { op: 'SetScissor', x0: scX0, y0: scY0, x1: scX1, y1: scY1 },
      { op: 'DrawCI8', w: W, h: H, addr: texAddr, x, y },
      { op: 'End' },
    ];
    writeUcAsRspdl(bus2, typedBase, uc, stride);

    const typed = scheduleRSPDLFramesAndRun(cpu2, bus2, sys2, origin, width, height, typedBase, frames, start, interval, total, spOffset, stride);

    expect(dex.frames.map(crc32)).toEqual(typed.frames.map(crc32));
  });
});


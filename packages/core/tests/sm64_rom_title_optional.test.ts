import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hlePiLoadSegments } from '../src/boot/loader.ts';
import { scheduleF3DEXFromTableAndRun } from '../src/boot/rsp_dl_hle.ts';
import { decompressMIO0 } from '../src/utils/mio0.ts';

// Optional ROM-backed title slice smoke test.
// Set env SM64_ROM_JSON to the absolute path of a JSON config following the samples/ schema.
// If the env is not set, the test is skipped.

describe('sm64_rom_title_optional', () => {
  it('runs if SM64_ROM_JSON is provided (skips otherwise)', async () => {
    const cfgPath = process.env.SM64_ROM_JSON;
    if (!cfgPath) {
      console.warn('[sm64_rom_title_optional] SM64_ROM_JSON not set; skipping');
      expect(true).toBe(true);
      return;
    }
    const fs = await import('node:fs');
    const path = await import('node:path');
    const text = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(text);
    const num = (v: any, d=0) => (typeof v === 'number' ? v>>>0 : (typeof v === 'string' ? (v.startsWith('0x')||v.startsWith('0X')?parseInt(v,16):Number(v))>>>0 : d))>>>0;

    const width = num(cfg.video?.width, 192);
    const height = num(cfg.video?.height, 120);
    const origin = num(cfg.video?.origin, 0xF000);
    const start = num(cfg.timing?.start, 2);
    const interval = num(cfg.timing?.interval, 3);
    const frames = Math.max(1, num(cfg.timing?.frames, 1));
    const spOffset = num(cfg.timing?.spOffset, 1);

    const romPath = String(cfg.rom || cfg.romPath || '');
    const romAbs = path.isAbsolute(romPath) ? romPath : path.resolve(path.dirname(cfgPath), romPath);
    const romBytes = fs.readFileSync(romAbs);

    const rdram = new RDRAM(1 << 22);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);
    bus.setROM(new Uint8Array(romBytes));

    const piLoads: { cartAddr: number; dramAddr: number; length: number }[] = [];
    if (Array.isArray(cfg.assets?.loads)) {
      for (const L of cfg.assets.loads) {
        const kind = String(L.kind || L.type || 'rom');
        if (kind === 'rom') {
          piLoads.push({ cartAddr: num(L.srcRom), dramAddr: num(L.dest), length: num(L.length) });
        } else if (kind === 'mio0') {
          const srcOff = num(L.srcRom); const dest = num(L.dest);
          const out = decompressMIO0(new Uint8Array(romBytes), srcOff);
          for (let i = 0; i < out.length; i++) bus.storeU8(dest + i, out[i]!);
        }
      }
    }
    if (piLoads.length) hlePiLoadSegments(bus, piLoads, true);

    const fbBytes = width * height * 2;
    const base = num(cfg.allocBase, (origin + fbBytes + 0x9000) >>> 0);
    const tableBase = base >>> 0;
    const dl0 = (base + 0x400) >>> 0;
    const stagingBase = num(cfg.stagingBase, (base + 0x8000) >>> 0);
    const strideWords = num(cfg.strideWords, 1024 >>> 2);

    function fp(x: number) { return (x << 2) >>> 0; }
    function pack12(hi: number, lo: number) { return (((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0; }

    const tiles: any[] = Array.isArray(cfg.assets?.tiles) ? cfg.assets.tiles : [];
    for (let f=0; f<frames; f++){
      let p = (dl0 + f*strideWords*4) >>> 0;
      if (cfg.bg){ bus.storeU32(p, 0x00000001); p+=4; bus.storeU32(p, num(cfg.bg.start5551)); p+=4; bus.storeU32(p, num(cfg.bg.end5551)); p+=4; }
      const dx = num(cfg.layout?.offsetPerFrameX, 1) * f;
      for (const t of tiles) {
        const fmt = String(t.format || 'CI8');
        const OP_SETTIMG = 0xFD << 24; const siz = fmt==='CI8'?(1<<19):(0<<19);
        bus.storeU32(p, (OP_SETTIMG|siz)>>>0); p+=4; bus.storeU32(p, num(t.pixAddr)); p+=4;
        const OP_LOADTLUT = 0xF0 << 24; const count = t.tlutCount!==undefined?num(t.tlutCount): (fmt==='CI8'?256:32);
        bus.storeU32(p, (OP_LOADTLUT|count)>>>0); p+=4; bus.storeU32(p, num(t.tlutAddr)); p+=4;
        const OP_SETTILESIZE = 0xF2 << 24; const w=num(t.w), h=num(t.h);
        bus.storeU32(p, (OP_SETTILESIZE|pack12(fp(0),fp(0)))>>>0); p+=4; bus.storeU32(p, pack12(fp(w-1),fp(h-1))>>>0); p+=4;
        if (fmt==='CI4' && t.ci4Palette!==undefined){ const OP_SETTILE=0xF5<<24; const w1=((num(t.ci4Palette)&0xF)<<20)>>>0; bus.storeU32(p, OP_SETTILE>>>0); p+=4; bus.storeU32(p, w1>>>0); p+=4; }
        const OP_TEXRECT = 0xE4 << 24; const x=(num(t.x)+dx)|0, y=num(t.y);
        bus.storeU32(p, (OP_TEXRECT|pack12(fp(x),fp(y)))>>>0); p+=4; bus.storeU32(p, pack12(fp(x+w), fp(y+h))>>>0); p+=4;
      }
      bus.storeU32(p, 0xDF000000>>>0); p+=4; bus.storeU32(p, 0);
      bus.storeU32(tableBase + f*4, (dl0 + f*strideWords*4)>>>0);
    }

    const total = start + interval * frames + 2;
    const { frames: imgs } = scheduleF3DEXFromTableAndRun(cpu, bus, sys, origin, width, height, tableBase, frames, stagingBase, strideWords, start, interval, total, spOffset);
    expect(imgs.length).toBe(frames);
  });
});


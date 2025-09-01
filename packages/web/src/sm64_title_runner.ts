import { Bus, RDRAM, CPU, System, hlePiLoadSegments, decompressMIO0, scheduleF3DEXFromTableAndRun } from '@n64/core';
import type { Sm64TitleConfig, RunnerResult, TileItem } from './types';
import { crc32Hex } from './crc32.js';

const parseNum = (v: number | string | undefined, d: number): number => {
  if (v === undefined) return d >>> 0;
  if (typeof v === 'number') return (v >>> 0);
  const s = String(v).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
  const n = Number(s);
  return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
};

// Minimal F3DEX DL writer for a tile draw (mirrors headless logic)
interface TileCfg {
  format: 'CI8' | 'CI4';
  tlutAddr: number;
  tlutCount?: number;
  pixAddr: number;
  w: number; h: number; x: number; y: number;
  ci4Palette?: number;
}

const writeF3dexTileDL = (bus: Bus, pStart: number, tile: TileCfg): number => {
  let p = pStart >>> 0;
  const storeU32 = (v: number): void => { bus.storeU32(p >>> 0, v >>> 0); p = (p + 4) >>> 0; };
  const fp = (x: number): number => ((x << 2) >>> 0);
  const pack12 = (hi: number, lo: number): number => ((((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0);
  const OP_SETTIMG = 0xFD << 24;
  const SIZ = tile.format === 'CI8' ? (1 << 19) : (0 << 19);
  storeU32((OP_SETTIMG | SIZ) >>> 0); storeU32(tile.pixAddr >>> 0);
  const OP_LOADTLUT = 0xF0 << 24; storeU32((OP_LOADTLUT | (tile.tlutCount ?? (tile.format === 'CI8' ? 256 : 32))) >>> 0); storeU32(tile.tlutAddr >>> 0);
  const OP_SETTILESIZE = 0xF2 << 24; storeU32((OP_SETTILESIZE | pack12(fp(0), fp(0))) >>> 0); storeU32(pack12(fp(tile.w - 1), fp(tile.h - 1)) >>> 0);
  if (tile.format === 'CI4' && tile.ci4Palette !== undefined) {
    const OP_SETTILE = 0xF5 << 24; const pal = (tile.ci4Palette & 0xF) >>> 0; const w1 = (pal << 20) >>> 0; storeU32(OP_SETTILE >>> 0); storeU32(w1 >>> 0);
  }
  const OP_TEXRECT = 0xE4 << 24; storeU32((OP_TEXRECT | pack12(fp(tile.x), fp(tile.y))) >>> 0); storeU32(pack12(fp(tile.x + tile.w), fp(tile.y + tile.h)) >>> 0);
  return p >>> 0;
};

export interface CoreRunResult { width: number; height: number; frames: Uint8Array[]; crc32Hex: string[] }

export const runSm64TitleFramesCore = async (romBytes: Uint8Array, cfg: Sm64TitleConfig, overrideFrames?: number): Promise<CoreRunResult> => {
  const width = cfg.video?.width ?? 192;
  const height = cfg.video?.height ?? 120;
  const origin = cfg.video?.origin ?? 0xF000;
  const start = cfg.timing?.start ?? 2;
  const interval = cfg.timing?.interval ?? 3;
  const frames = overrideFrames ?? (cfg.timing?.frames ?? 2);
  const spOffset = cfg.timing?.spOffset ?? 1;

  // Allocate enough RDRAM for ROM-backed asset loads
  const rdram = new RDRAM(1 << 22);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  bus.setROM(romBytes);

  // PI loads and MIO0 decompression (tolerant): if an MIO0 entry is invalid, fall back to procedural assets
  const loads = cfg.assets?.loads ?? [];
  const piSegs: { cartAddr: number; dramAddr: number; length: number }[] = [];
  let fallbackProcedural = false;
  for (const L of loads) {
    if (L.kind === 'rom') {
      const len = (L.length ?? 0) >>> 0;
      if (len > 0) piSegs.push({ cartAddr: L.srcRom >>> 0, dramAddr: L.dest >>> 0, length: len });
    } else if (L.kind === 'mio0') {
      const srcOff = L.srcRom >>> 0; const dest = L.dest >>> 0;
      const ok = (romBytes[srcOff] === 0x4D /*M*/ && romBytes[srcOff+1] === 0x49 /*I*/ && romBytes[srcOff+2] === 0x4F /*O*/ && romBytes[srcOff+3] === 0x30 /*0*/);
      if (!ok) { fallbackProcedural = true; continue; }
      try {
        const decompressed = decompressMIO0(romBytes, srcOff);
        for (let i = 0; i < decompressed.length; i++) bus.storeU8((dest + i) >>> 0, decompressed[i]!);
      } catch {
        fallbackProcedural = true;
      }
    }
  }
  if (piSegs.length) hlePiLoadSegments(bus, piSegs, true);

  // Build per-frame F3DEX DL table for tiles
  const fbBytes = (width * height * 2) >>> 0;
  const base = (cfg.allocBase ?? ((origin + fbBytes + 0x9000) >>> 0)) >>> 0;
  const tableBase = base >>> 0;
  const dl0 = (base + 0x400) >>> 0;
  const stagingBase = (cfg.stagingBase ?? ((base + 0x8000) >>> 0)) >>> 0;
  const strideWords = (cfg.strideWords ?? (1024 >>> 2)) >>> 0;

  const tilesIn: TileItem[] = Array.isArray(cfg.assets?.tiles) ? cfg.assets!.tiles! : [];

  // Procedural fallback: green CI8 ring if no tiles provided or asset loads were invalid
  const tilesUse: TileCfg[] = [];
  if (tilesIn.length === 0 || fallbackProcedural) {
    const tlutAddr = base >>> 0;
    const pixAddr = (base + 0x1000) >>> 0;
    // TLUT: index 1 = green5551
    const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    for (let i = 0; i < 256; i++) bus.storeU16((tlutAddr + i * 2) >>> 0, i === 1 ? GREEN : 0);
    // CI8 ring 32x32 at pixAddr
    const W = 32, H = 32, cx = 16, cy = 16, rO = 14, rI = 10;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x + 0.5) - cx, dy = (y + 0.5) - cy; const d2 = dx*dx + dy*dy;
      const v = (d2 <= rO*rO && d2 >= rI*rI) ? 1 : 0;
      bus.storeU8((pixAddr + (y*W + x)) >>> 0, v);
    }
    tilesUse.push({ format: 'CI8', tlutAddr, tlutCount: 256, pixAddr, w: 32, h: 32, x: 40, y: 30 });
  } else {
    for (const t of tilesIn) tilesUse.push({
      format: t.format, tlutAddr: t.tlutAddr, tlutCount: t.tlutCount, pixAddr: t.pixAddr, w: t.w, h: t.h, x: t.x, y: t.y, ci4Palette: t.ci4Palette,
    });
  }

  for (let f = 0; f < frames; f++) {
    const dlAddr = (dl0 + f * strideWords * 4) >>> 0;
    let p = dlAddr >>> 0;
    // optional background gradient
    if (cfg.bg) { bus.storeU32(p, 0x00000001 >>> 0); p += 4; bus.storeU32(p, cfg.bg.start5551 >>> 0); p += 4; bus.storeU32(p, cfg.bg.end5551 >>> 0); p += 4; }
    const dx = (cfg.layout?.offsetPerFrameX ?? 1) * f;
    for (const t of tilesUse) {
      const t2: TileCfg = { ...t, x: (t.x + dx) | 0 };
      p = writeF3dexTileDL(bus, p, t2);
    }
    // G_ENDDL (0xDF)
    bus.storeU32(p, 0xDF000000 >>> 0); p += 4; bus.storeU32(p, 0);
    // table[i] = dlAddr
    bus.storeU32((tableBase + f * 4) >>> 0, dlAddr >>> 0);
  }

  const total = (start + interval * frames + 2) >>> 0;
  const bgStart = cfg.bg?.start5551;
  const bgEnd = cfg.bg?.end5551;
  const { frames: imgs } = scheduleF3DEXFromTableAndRun(
    cpu, bus, sys, origin >>> 0, width >>> 0, height >>> 0,
    tableBase >>> 0, frames >>> 0, stagingBase >>> 0, strideWords >>> 0,
    start >>> 0, interval >>> 0, total >>> 0, spOffset >>> 0,
    bgStart, bgEnd,
  );

  const crc32s: string[] = [];
  for (let i = 0; i < imgs.length; i++) crc32s.push(crc32Hex(imgs[i]!));
  return { width, height, frames: imgs, crc32Hex: crc32s };
};

export const runSm64TitleFrames = async (romBytes: Uint8Array, cfg: Sm64TitleConfig, overrideFrames?: number): Promise<RunnerResult> => {
  const core = await runSm64TitleFramesCore(romBytes, cfg, overrideFrames);
  const frameImages: ImageData[] = core.frames.map((data) => new ImageData(new Uint8ClampedArray(data), core.width, core.height));
  return { frameImages, crc32Hex: core.crc32Hex };
};

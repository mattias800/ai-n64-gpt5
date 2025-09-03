import { Bus, RDRAM, CPU, System, scheduleF3DEXFromTableAndRun } from '@n64/core';

const toU32 = (v: unknown, d: number = 0): number => {
  if (typeof v === 'number') return (v >>> 0);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
    const n = Number(s); return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
  }
  return (d >>> 0);
};

export const runF3dexFromTableCore = (cfgRaw: unknown): { width: number; height: number; frames: Uint8Array[] } => {
  const cfgIn = (cfgRaw && typeof cfgRaw === 'object') ? (cfgRaw as any) : {};
  const video = { width: toU32(cfgIn.video?.width, 192), height: toU32(cfgIn.video?.height, 120), origin: toU32(cfgIn.video?.origin, 0xF000) };
  const timing = { start: toU32(cfgIn.timing?.start, 2), interval: toU32(cfgIn.timing?.interval, 3), frames: toU32(cfgIn.timing?.frames, 2), spOffset: toU32(cfgIn.timing?.spOffset, 1) };
  const f3dex = {
    tableBase: cfgIn.f3dex?.tableBase !== undefined ? toU32(cfgIn.f3dex.tableBase) : undefined,
    stagingBase: cfgIn.f3dex?.stagingBase !== undefined ? toU32(cfgIn.f3dex.stagingBase) : undefined,
    strideWords: cfgIn.f3dex?.strideWords !== undefined ? toU32(cfgIn.f3dex.strideWords) : undefined,
    bgStart: cfgIn.f3dex?.bgStart !== undefined ? toU32(cfgIn.f3dex.bgStart) : undefined,
    bgEnd: cfgIn.f3dex?.bgEnd !== undefined ? toU32(cfgIn.f3dex.bgEnd) : undefined,
  };
  const framesIn: any[] = Array.isArray(cfgIn.frames) ? cfgIn.frames : [];

  const rdram = new RDRAM(1 << 22);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  const fbBytes = (video.width * video.height * 2) >>> 0;
  const base = (f3dex.tableBase ?? ((video.origin + fbBytes + 0x9000) >>> 0)) >>> 0;
  const tableBase = base >>> 0;
  const dl0 = (base + 0x100) >>> 0;
  const stagingBase = (f3dex.stagingBase ?? ((base + 0x8000) >>> 0)) >>> 0;
  const strideWords = (f3dex.strideWords ?? (0x400 >>> 2)) >>> 0;

  for (let i = 0; i < timing.frames; i++) {
    const dlAddr = (dl0 + i * strideWords * 4) >>> 0;
    bus.storeU32((tableBase + i * 4) >>> 0, dlAddr >>> 0);
    const words = Array.isArray(framesIn[i]?.dlWords) ? framesIn[i]!.dlWords! : [];
    if (words.length === 0) {
      bus.storeU32(dlAddr >>> 0, 0xDF000000 >>> 0);
      bus.storeU32((dlAddr + 4) >>> 0, 0);
      continue;
    }
    for (let w = 0, p = dlAddr; w < words.length; w++, p = (p + 4) >>> 0) {
      const v = words[w]!;
      const num = (typeof v === 'number') ? (v >>> 0) : toU32(v, 0);
      bus.storeU32(p >>> 0, num >>> 0);
    }
  }

  const total = (timing.start + timing.interval * timing.frames + 2) >>> 0;
  const { frames } = scheduleF3DEXFromTableAndRun(
    cpu, bus, sys, video.origin >>> 0, video.width >>> 0, video.height >>> 0,
    tableBase >>> 0, timing.frames >>> 0, stagingBase >>> 0, strideWords >>> 0,
    timing.start >>> 0, timing.interval >>> 0, total >>> 0, timing.spOffset >>> 0,
    f3dex.bgStart, f3dex.bgEnd,
  );
  return { width: video.width, height: video.height, frames };
};

import { Bus, RDRAM, CPU, System, f3dToUc, writeUcAsRspdl, scheduleRSPDLFromTableAndRun } from '@n64/core';

export interface VideoCfg { width: number; height: number; origin: number; }
export interface TimingCfg { start: number; interval: number; frames: number; spOffset: number; }
export interface F3dFrameCmd { op: string; [k: string]: number | string }
export interface F3dTableConfig { video: VideoCfg; timing: TimingCfg; frames: F3dFrameCmd[] }

const toU32 = (v: unknown, d: number = 0): number => {
  if (typeof v === 'number') return (v >>> 0);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) return (parseInt(s, 16) >>> 0);
    const n = Number(s); return Number.isFinite(n) ? (n >>> 0) : (d >>> 0);
  }
  return (d >>> 0);
};

export interface F3dRunResult { width: number; height: number; frames: Uint8Array[]; }

export const runF3dTableFramesCore = (cfgRaw: unknown): F3dRunResult => {
  const cfgIn = (cfgRaw && typeof cfgRaw === 'object') ? (cfgRaw as any) : {};
  const video: VideoCfg = { width: toU32(cfgIn.video?.width, 192), height: toU32(cfgIn.video?.height, 120), origin: toU32(cfgIn.video?.origin, 0xF000) };
  const timing: TimingCfg = { start: toU32(cfgIn.timing?.start, 2), interval: toU32(cfgIn.timing?.interval, 3), frames: toU32(cfgIn.timing?.frames, 2), spOffset: toU32(cfgIn.timing?.spOffset, 1) };
  const framesIn: F3dFrameCmd[] = Array.isArray(cfgIn.frames) ? cfgIn.frames as F3dFrameCmd[] : [];

  const rdram = new RDRAM(1 << 20);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);

  const strideWords = 512 >>> 0;
  const tableBase = 0x20000 >>> 0;
  const dl0 = (tableBase + 0x100) >>> 0;

  for (let i = 0; i < timing.frames; i++) {
    const frame = framesIn[i] || framesIn[0] || { op: 'G_GRADIENT', bgStart: 0x001F, bgEnd: 0x07FF };
    // Normalize known fields to numbers
    const op = String(frame.op);
    const n = (v: unknown) => toU32(v, 0);
    let cmds: any[];
    if (op) {
      const cmd = (() => {
        switch (op) {
          case 'G_GRADIENT': return { op, bgStart: n((frame as any).bgStart), bgEnd: n((frame as any).bgEnd) };
          default: return frame;
        }
      })();
      cmds = [cmd];
    } else {
      cmds = [];
    }
    const uc = f3dToUc(cmds as any);
    const dlAddr = (dl0 + i * strideWords * 4) >>> 0;
    writeUcAsRspdl(bus as any, dlAddr, uc, strideWords);
    bus.storeU32((tableBase + i * 4) >>> 0, dlAddr >>> 0);
  }

  const total = (timing.start + timing.interval * timing.frames + 2) >>> 0;
  const { frames } = scheduleRSPDLFromTableAndRun(
    cpu, bus, sys, video.origin >>> 0, video.width >>> 0, video.height >>> 0,
    tableBase >>> 0, timing.frames >>> 0,
    timing.start >>> 0, timing.interval >>> 0, total >>> 0, timing.spOffset >>> 0,
    strideWords >>> 0,
  );
  return { width: video.width, height: video.height, frames };
};

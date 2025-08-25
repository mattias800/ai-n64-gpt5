import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { runSM64TitleDemoDP, runSM64TitleDemoSPDP, TitleSM64Config } from '../src/boot/title_sm64_demo.ts';
import { writeSM64TitleTasksToRDRAM, scheduleSPTitleTasksFromRDRAMAndRun } from '../src/boot/sp_task_hle.ts';
import { writeRSPTitleDLsToRDRAM, scheduleRSPDLFramesAndRun } from '../src/boot/rsp_dl_hle.ts';
import { crc32 } from './helpers/test_utils.ts';

function crcArray(images: Uint8Array[]): string[] { return images.map(crc32); }

function makeCtx() {
  const rdram = new RDRAM(1 << 19);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  return { rdram, bus, cpu, sys };
}

function parityOnce(frames: number) {
  const cfg: TitleSM64Config = {
    width: 192,
    height: 120,
    origin: 0xF000,
    spacing: 10,
    startCycle: 2,
    interval: 3,
    frames,
    bgStart5551: ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0, // blue
    bgEnd5551:   ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0, // cyan
    spOffset: 1,
  } as const;

  // DP-only context
  const dpCtx = makeCtx();
  const dp = runSM64TitleDemoDP(dpCtx.cpu, dpCtx.bus, dpCtx.sys, cfg);

  // SP->DP timing context
  const spdpCtx = makeCtx();
  const spdp = runSM64TitleDemoSPDP(spdpCtx.cpu, spdpCtx.bus, spdpCtx.sys, cfg);

  // SP tasks in RDRAM context
  const sptCtx = makeCtx();
  const fbBytes = cfg.width * cfg.height * 2;
  const taskBase = (cfg.origin + fbBytes + 0x1000) >>> 0;
  writeSM64TitleTasksToRDRAM(sptCtx.bus, taskBase, frames, cfg.spacing!, cfg.bgStart5551, cfg.bgEnd5551);
  const totalCycles = cfg.startCycle + cfg.interval * frames + 2;
  const sptask = scheduleSPTitleTasksFromRDRAMAndRun(
    sptCtx.cpu, sptCtx.bus, sptCtx.sys,
    cfg.origin, cfg.width, cfg.height,
    taskBase, frames, cfg.startCycle, cfg.interval, totalCycles, cfg.spOffset!,
  );

  // RSP DL in RDRAM context
  const rspCtx = makeCtx();
  const rspBase = (cfg.origin + fbBytes + 0x2000) >>> 0;
  const strideWords = 16;
  writeRSPTitleDLsToRDRAM(rspCtx.bus, rspBase, frames, cfg.spacing!, cfg.bgStart5551, cfg.bgEnd5551, strideWords);
  const rspdl = scheduleRSPDLFramesAndRun(
    rspCtx.cpu, rspCtx.bus, rspCtx.sys,
    cfg.origin, cfg.width, cfg.height,
    rspBase, frames, cfg.startCycle, cfg.interval, totalCycles, cfg.spOffset!, strideWords,
  );

  return { dp, spdp, sptask, rspdl };
}

describe('sm64_title_pipeline_parity', () => {
  it('1 frame: dp == spdp == sptask == rspdl per-frame CRCs; correct acks', () => {
    const { dp, spdp, sptask, rspdl } = parityOnce(1);
    expect(dp.res.dpAcks).toBe(1); expect(dp.res.viAcks).toBe(1); expect(dp.res.spAcks).toBe(0);
    expect(spdp.res.dpAcks).toBe(1); expect(spdp.res.viAcks).toBe(1); expect(spdp.res.spAcks).toBe(1);
    expect(sptask.res.dpAcks).toBe(1); expect(sptask.res.viAcks).toBe(1); expect(sptask.res.spAcks).toBe(1);

    const dpCRCs = crcArray(dp.frames);
    const spdpCRCs = crcArray(spdp.frames);
    const sptaskCRCs = crcArray(sptask.frames);
    const rspdlCRCs = crcArray(rspdl.frames);

    expect(dpCRCs).toEqual(spdpCRCs);
    expect(dpCRCs).toEqual(sptaskCRCs);
    expect(dpCRCs).toEqual(rspdlCRCs);

    // Also final image CRCs must match
    expect(crc32(dp.image)).toBe(crc32(spdp.image));
    expect(crc32(dp.image)).toBe(crc32(sptask.image));
    expect(crc32(dp.image)).toBe(crc32(rspdl.image));
  });

  it('2 frames: dp == spdp == sptask == rspdl per-frame CRCs; correct acks', () => {
    const { dp, spdp, sptask, rspdl } = parityOnce(2);
    expect(dp.res.dpAcks).toBe(2); expect(dp.res.viAcks).toBe(2); expect(dp.res.spAcks).toBe(0);
    expect(spdp.res.dpAcks).toBe(2); expect(spdp.res.viAcks).toBe(2); expect(spdp.res.spAcks).toBe(2);
    expect(sptask.res.dpAcks).toBe(2); expect(sptask.res.viAcks).toBe(2); expect(sptask.res.spAcks).toBe(2);

    const dpCRCs = crcArray(dp.frames);
    const spdpCRCs = crcArray(spdp.frames);
    const sptaskCRCs = crcArray(sptask.frames);
    const rspdlCRCs = crcArray(rspdl.frames);

    expect(dpCRCs).toEqual([ '6ca0bc0e', 'db86e0b3' ]);
    expect(spdpCRCs).toEqual(dpCRCs);
    expect(sptaskCRCs).toEqual(dpCRCs);
    expect(rspdlCRCs).toEqual(dpCRCs);

    // Also final image CRCs must match
    expect(crc32(dp.image)).toBe(crc32(spdp.image));
    expect(crc32(dp.image)).toBe(crc32(sptask.image));
    expect(crc32(dp.image)).toBe(crc32(rspdl.image));
  });
});


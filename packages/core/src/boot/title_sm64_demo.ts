import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { scheduleDPDrivenTitleFramesAndRun, scheduleSPDPDrivenTitleFramesAndRun, DPDrivenFrame } from './title_dp_driven.js';
import { buildSM64TilesSlice } from './title_logo_sm64_tiles.js';

export type TitleSM64Config = {
  width: number;
  height: number;
  origin: number;
  spacing?: number;
  startCycle: number;
  interval: number;
  frames: number; // number of frames to compose
  bgStart5551: number;
  bgEnd5551: number;
  spOffset?: number; // optional SP lead time (cycles) before DP; used by SP→DP variant
};

export function runSM64TitleDemoDP(
  cpu: CPU,
  bus: Bus,
  sys: System,
  cfg: TitleSM64Config,
) {
  const frames: DPDrivenFrame[] = [];
  for (let i = 0; i < cfg.frames; i++) {
    const tiles = buildSM64TilesSlice(cfg.width, cfg.height, { spacing: cfg.spacing ?? 10, offsetX: i });
    frames.push({
      at: cfg.startCycle + i * cfg.interval,
      bgStart5551: cfg.bgStart5551 >>> 0,
      bgEnd5551: cfg.bgEnd5551 >>> 0,
      tiles,
    });
  }
  const totalCycles = cfg.startCycle + cfg.interval * cfg.frames + 2;
  return scheduleDPDrivenTitleFramesAndRun(
    cpu, bus, sys,
    cfg.origin, cfg.width, cfg.height,
    frames,
    totalCycles,
  );
}

export function runSM64TitleDemoSPDP(
  cpu: CPU,
  bus: Bus,
  sys: System,
  cfg: TitleSM64Config,
) {
  const frames: DPDrivenFrame[] = [];
  for (let i = 0; i < cfg.frames; i++) {
    const tiles = buildSM64TilesSlice(cfg.width, cfg.height, { spacing: cfg.spacing ?? 10, offsetX: i });
    frames.push({
      at: cfg.startCycle + i * cfg.interval,
      bgStart5551: cfg.bgStart5551 >>> 0,
      bgEnd5551: cfg.bgEnd5551 >>> 0,
      tiles,
    });
  }
  const totalCycles = cfg.startCycle + cfg.interval * cfg.frames + 2;
  return scheduleSPDPDrivenTitleFramesAndRun(
    cpu, bus, sys,
    cfg.origin, cfg.width, cfg.height,
    frames,
    totalCycles,
    cfg.spOffset ?? 1,
  );
}


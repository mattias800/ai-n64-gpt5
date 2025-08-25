import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { hleBoot } from './hle.js';
import { hlePiLoadSegments, SegmentCopy } from './loader.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT, SP_BASE } from '../devices/mmio.js';
import { runFrameLoop } from '../system/frame_loop.js';

export type TitleDemoConfig = {
  vblank: { start: number; interval: number; times: number };
  spTasks: { start: number; interval: number; times: number };
  totalCycles: number;
};

export function hleTitleDemo(cpu: CPU, bus: Bus, sys: System, rom: Uint8Array, segments: SegmentCopy[], cfg: TitleDemoConfig) {
  // Boot and map ROM
  hleBoot(cpu, bus, rom);
  // Load required segments via PI
  hlePiLoadSegments(bus, segments, true);
  // Enable IE+IM2 and MI masks for DP+VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));
  // Schedule VI vblank and SP tasks
  sys.scheduleEvery(cfg.vblank.start, cfg.vblank.interval, cfg.vblank.times, () => bus.vi.vblank());
  sys.scheduleEvery(cfg.spTasks.start, cfg.spTasks.interval, cfg.spTasks.times, () => bus.storeU32(SP_BASE + 0x00, 1));
  // Run loop
  const res = runFrameLoop(cpu, bus, sys, cfg.totalCycles);
  return res;
}


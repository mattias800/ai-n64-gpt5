import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';
import { viDrawHorizontalGradient, Tile5551, viComposeTiles } from '../system/video_hle.js';
import { viScanout } from '../system/video.js';
import { runFrameLoop, FrameLoopResult } from '../system/frame_loop.js';

export type DPDrivenFrame = {
  at: number;
  bgStart5551: number;
  bgEnd5551: number;
  tiles: Tile5551[];
};

export type TitleLoopResult = { image: Uint8Array; frames: Uint8Array[]; res: FrameLoopResult };

// Schedules DP "task done" events that immediately compose the frame and raise VI vblank.
// This simulates a simple pipeline where composition occurs when DP completes its work.
export function scheduleDPDrivenTitleFramesAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  frames: DPDrivenFrame[],
  totalCycles: number,
): TitleLoopResult {
  // Program VI registers
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);

  // Enable CPU IE/IM2 and MI masks for DP+VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

  const perFrameImages: Uint8Array[] = [];
  for (const f of frames) {
    const when = f.at >>> 0;
    sys.scheduleAt(when, () => {
      // DP task completes now
      bus.dp.raiseInterrupt();
      // Compose frame at DP completion time
      viDrawHorizontalGradient(bus, width, height, f.bgStart5551 >>> 0, f.bgEnd5551 >>> 0);
      viComposeTiles(bus, width, height, f.tiles);
      // Immediately signal vblank for scanout
      bus.vi.vblank();
      // Snapshot framebuffer right after vblank for per-frame verification
      const snap = viScanout(bus, width, height);
      perFrameImages.push(snap);
    });
  }

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, frames: perFrameImages, res };
}

// Variant that also schedules an SP interrupt before each DP completion, simulating an SP→DP pipeline.
export function scheduleSPDPDrivenTitleFramesAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  frames: DPDrivenFrame[],
  totalCycles: number,
  spOffset: number = 1,
): TitleLoopResult {
  // Program VI registers
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);

  // Enable CPU IE/IM2 and MI masks for SP+DP+VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

  const perFrameImages: Uint8Array[] = [];
  for (const f of frames) {
    const whenDP = f.at >>> 0;
    const whenSP = whenDP > (spOffset|0) ? (whenDP - (spOffset|0)) >>> 0 : 0;
    // SP start
    sys.scheduleAt(whenSP, () => {
      bus.sp.raiseInterrupt();
    });
    // DP complete + compose + VI vblank + snapshot
    sys.scheduleAt(whenDP, () => {
      bus.dp.raiseInterrupt();
      viDrawHorizontalGradient(bus, width, height, f.bgStart5551 >>> 0, f.bgEnd5551 >>> 0);
      viComposeTiles(bus, width, height, f.tiles);
      bus.vi.vblank();
      const snap = viScanout(bus, width, height);
      perFrameImages.push(snap);
    });
  }

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, frames: perFrameImages, res };
}


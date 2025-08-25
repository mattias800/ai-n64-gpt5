import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';
import { viDrawHorizontalGradient, Tile5551, viComposeTiles } from '../system/video_hle.js';
import { viScanout } from '../system/video.js';
import { runFrameLoop, FrameLoopResult } from '../system/frame_loop.js';

export type TitleLoopFrame = {
  at: number; // cycle when the frame composition + vblank should occur
  bgStart5551: number;
  bgEnd5551: number;
  tiles: Tile5551[];
};

export type TitleLoopResult = { image: Uint8Array; res: FrameLoopResult };

export function scheduleTitleFramesAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  frames: TitleLoopFrame[],
  totalCycles: number,
): TitleLoopResult {
  // Program VI registers once
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);

  // Enable CPU IE/IM2 and MI mask for VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

  // For each frame spec, schedule a composition and vblank in that cycle
  for (const f of frames) {
    const when = f.at >>> 0;
    sys.scheduleAt(when, () => {
      viDrawHorizontalGradient(bus, width, height, f.bgStart5551 >>> 0, f.bgEnd5551 >>> 0);
      viComposeTiles(bus, width, height, f.tiles);
      bus.vi.vblank();
    });
  }

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, res };
}


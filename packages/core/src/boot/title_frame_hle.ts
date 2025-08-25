import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';
import { viDrawHorizontalGradient } from '../system/video_hle.js';
import { viScanout } from '../system/video.js';
import { runFrameLoop, FrameLoopResult } from '../system/frame_loop.js';

export type TitleFrameResult = { image: Uint8Array; res: FrameLoopResult };

export function hleTitleRenderFrameGradient(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  startColor5551: number,
  endColor5551: number,
): TitleFrameResult {
  // Program VI registers
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);

  // Draw gradient into framebuffer
  viDrawHorizontalGradient(bus, width, height, startColor5551 >>> 0, endColor5551 >>> 0);

  // Enable CPU IE/IM2 and MI mask for VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

  // Schedule one vblank
  sys.scheduleAt(1, () => bus.vi.vblank());

  const res = runFrameLoop(cpu, bus, sys, 3);
  const image = viScanout(bus, width, height);
  return { image, res };
}


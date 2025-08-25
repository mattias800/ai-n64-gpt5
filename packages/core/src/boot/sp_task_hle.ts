import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../devices/mmio.js';
import { viDrawHorizontalGradient, viComposeTiles } from '../system/video_hle.js';
import { viScanout } from '../system/video.js';
import { runFrameLoop } from '../system/frame_loop.js';
import { buildSM64TilesSlice } from './title_logo_sm64_tiles.js';
import type { TitleLoopResult } from './title_dp_driven.js';

// Simple SP task descriptor for the title demo, stored in RDRAM at base + i*16.
// Layout (bytes):
//   0x00: u32 spacing
//   0x04: s32 offsetX
//   0x08: u32 bgStart5551
//   0x0C: u32 bgEnd5551
export function writeSM64TitleTasksToRDRAM(
  bus: Bus,
  baseAddr: number,
  frames: number,
  spacing: number,
  bgStart5551: number,
  bgEnd5551: number,
): number {
  let addr = baseAddr >>> 0;
  for (let i = 0; i < frames; i++) {
    bus.storeU32(addr + 0x00, spacing >>> 0);
    bus.storeU32(addr + 0x04, i | 0); // offsetX
    bus.storeU32(addr + 0x08, bgStart5551 >>> 0);
    bus.storeU32(addr + 0x0C, bgEnd5551 >>> 0);
    addr = (addr + 0x10) >>> 0;
  }
  return baseAddr >>> 0;
}

function readTask(bus: Bus, addr: number) {
  const spacing = bus.loadU32(addr + 0x00) >>> 0;
  const offsetX = (bus.loadU32(addr + 0x04) | 0);
  const bgStart5551 = bus.loadU32(addr + 0x08) >>> 0;
  const bgEnd5551 = bus.loadU32(addr + 0x0C) >>> 0;
  return { spacing, offsetX, bgStart5551, bgEnd5551 } as const;
}

// Schedule SP→DP events and, on DP completion, read task descriptors from RDRAM to compose frames.
export function scheduleSPTitleTasksFromRDRAMAndRun(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  taskBase: number,
  frames: number,
  startCycle: number,
  interval: number,
  totalCycles: number,
  spOffset: number = 1,
): TitleLoopResult {
  // Program VI
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, width >>> 0);

  // Enable CPU IE/IM2 and MI masks for SP+DP+VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

  const perFrameImages: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const dpAt = (startCycle + i * interval) >>> 0;
    const spAt = dpAt > (spOffset|0) ? (dpAt - (spOffset|0)) >>> 0 : 0;
    const taskAddr = (taskBase + i * 0x10) >>> 0;

    sys.scheduleAt(spAt, () => {
      bus.sp.raiseInterrupt();
    });

    sys.scheduleAt(dpAt, () => {
      const t = readTask(bus, taskAddr);
      if (process?.env?.DBG_SPTASK_LOG) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ kind: 'sptask', i, spAt, dpAt, taskAddr, t }, null, 2));
      }
      // DP completion
      bus.dp.raiseInterrupt();
      // Compose exactly like the DP-driven path
      viDrawHorizontalGradient(bus, width, height, t.bgStart5551, t.bgEnd5551);
      const tiles = buildSM64TilesSlice(width, height, { spacing: t.spacing, offsetX: t.offsetX });
      if (process?.env?.DBG_SPTASK_LOG) {
        const positions = tiles.map((q) => ({ x: q.dstX, y: q.dstY, w: q.width, h: q.height }));
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ kind: 'sptask-tiles', i, positions }, null, 2));
      }
      viComposeTiles(bus, width, height, tiles);
      // VI vblank + snapshot
      bus.vi.vblank();
      const snap = viScanout(bus, width, height);
      perFrameImages.push(snap);
    });
  }

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, frames: perFrameImages, res };
}


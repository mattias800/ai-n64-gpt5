import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from '../system/system.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF, SP_BASE, SP_CMD_OFF } from '../devices/mmio.js';
import { viDrawHorizontalGradient, viComposeTiles, Tile5551, viBlitRGBA5551, viBlitPatternRGBA5551, viDrawSeamOverlay } from '../system/video_hle.js';
import { viScanout } from '../system/video.js';
import { runFrameLoop, FrameLoopResult } from '../system/frame_loop.js';
import { decodeCI8ToRGBA5551, decodeCI4ToRGBA5551, decodeI4ToRGBA5551, decodeI8ToRGBA5551, decodeIA8ToRGBA5551, decodeIA16ToRGBA5551 } from '../gfx/n64_textures.js';

export type TileAtlasEntry = { width: number; height: number; pixels: Uint16Array };
export type TileAtlas = Record<string, TileAtlasEntry>;

type AddressMode = 'clamp' | 'wrap' | 'mirror';
export type TextureFormat = 'CI4' | 'CI8' | 'I4' | 'I8' | 'IA8' | 'IA16' | 'RGBA16';

export type DLCommand =
  | { op: 'gradient'; start5551: number; end5551: number }
  | { op: 'draw_tile'; id: string; x: number; y: number }
  | { op: 'set_tlut'; tlut: Uint16Array }
  | { op: 'draw_ci8'; data: Uint8Array; width: number; height: number; x: number; y: number }
  | { op: 'draw_ci4'; data: Uint8Array; width: number; height: number; x: number; y: number }
  | { op: 'set_texture'; format: TextureFormat; width: number; height: number; data: Uint8Array | Uint16Array; addrX?: AddressMode; addrY?: AddressMode }
  | { op: 'draw_tex'; x: number; y: number; width?: number; height?: number }
  | { op: 'nop' };

export type DLResult = { image: Uint8Array; res: FrameLoopResult };

function execDL(bus: Bus, width: number, height: number, commands: DLCommand[], atlas: TileAtlas): void {
  const compose: Tile5551[] = [];
  let currentTLUT: Uint16Array | null = null;
  let currentTex: { format: TextureFormat; width: number; height: number; data: Uint8Array | Uint16Array; addrX: AddressMode; addrY: AddressMode } | null = null;
  for (const cmd of commands) {
    switch (cmd.op) {
      case 'gradient':
        viDrawHorizontalGradient(bus, width, height, cmd.start5551 >>> 0, cmd.end5551 >>> 0);
        break;
      case 'draw_tile': {
        const t = atlas[cmd.id];
        if (t) compose.push({ dstX: cmd.x|0, dstY: cmd.y|0, width: t.width|0, height: t.height|0, pixels: t.pixels });
        break;
      }
      case 'set_tlut': {
        currentTLUT = cmd.tlut;
        break;
      }
      case 'draw_ci8': {
        const tlut = currentTLUT;
        if (!tlut) break; // ignore draw if TLUT not set
        const rgba = decodeCI8ToRGBA5551(cmd.data, tlut, cmd.width|0, cmd.height|0);
        viBlitRGBA5551(bus, width, height, cmd.x|0, cmd.y|0, rgba, cmd.width|0, cmd.height|0);
        break;
      }
      case 'draw_ci4': {
        const tlut = currentTLUT;
        if (!tlut) break;
        const rgba = decodeCI4ToRGBA5551(cmd.data, tlut, cmd.width|0, cmd.height|0);
        viBlitRGBA5551(bus, width, height, cmd.x|0, cmd.y|0, rgba, cmd.width|0, cmd.height|0);
        break;
      }
      case 'set_texture': {
        currentTex = { format: cmd.format, width: cmd.width|0, height: cmd.height|0, data: cmd.data, addrX: cmd.addrX ?? 'clamp', addrY: cmd.addrY ?? 'clamp' };
        break;
      }
      case 'draw_tex': {
        const tex = currentTex; if (!tex) break;
        const drawW = (cmd.width ?? tex.width) | 0;
        const drawH = (cmd.height ?? tex.height) | 0;
        let pattern: Uint16Array = new Uint16Array(tex.width * tex.height);
        switch (tex.format) {
          case 'CI8': {
            const tlut = currentTLUT; if (!tlut) break;
            pattern = decodeCI8ToRGBA5551(tex.data as Uint8Array, tlut, tex.width, tex.height);
            break;
          }
          case 'CI4': {
            const tlut = currentTLUT; if (!tlut) break;
            pattern = decodeCI4ToRGBA5551(tex.data as Uint8Array, tlut, tex.width, tex.height);
            break;
          }
          case 'I4': pattern = decodeI4ToRGBA5551(tex.data as Uint8Array, tex.width, tex.height); break;
          case 'I8': pattern = decodeI8ToRGBA5551(tex.data as Uint8Array, tex.width, tex.height); break;
          case 'IA8': pattern = decodeIA8ToRGBA5551(tex.data as Uint8Array, tex.width, tex.height); break;
          case 'IA16': pattern = decodeIA16ToRGBA5551(tex.data as Uint8Array, tex.width, tex.height); break;
          case 'RGBA16': pattern = tex.data as Uint16Array; break;
          default: pattern = new Uint16Array(tex.width * tex.height); break;
        }
        viBlitPatternRGBA5551(bus, width, height, cmd.x|0, cmd.y|0, drawW, drawH, pattern, tex.width, tex.height, tex.addrX, tex.addrY);
        break;
      }
      case 'nop':
        break;
    }
  }
  if (compose.length) viComposeTiles(bus, width, height, compose);

  // Optional seam overlay for debugging: if DL_HLE_SEAM_OVERLAY is set, draw seam lines at 16px tile boundaries
  const overlayEnv = process.env?.DL_HLE_SEAM_OVERLAY;
  if (overlayEnv && overlayEnv !== '0' && overlayEnv.toLowerCase() !== 'false') {
    const verticalXs: number[] = [];
    for (let x = 16; x < width; x += 16) verticalXs.push(x);
    const horizontalYs: number[] = [];
    for (let y = 16; y < height; y += 16) horizontalYs.push(y);
    viDrawSeamOverlay(bus, width, height, verticalXs, horizontalYs);
  }
}

// Schedules a DP completion at `atCycle`, executes DL commands: draws gradient and tiles from a small atlas,
// raises VI vblank, runs the frame loop, and returns scanout and ack counts.
export function scheduleAndRunTitleDL(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  commands: DLCommand[],
  atlas: TileAtlas,
  atCycle: number,
  totalCycles: number,
  stride?: number,
): DLResult {
  // Program VI
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, (stride ?? width) >>> 0);

  // Enable CPU IE/IM2 and MI masks for DP+VI
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

  sys.scheduleAt(atCycle >>> 0, () => {
    // DP completion
    bus.dp.raiseInterrupt();
    // Execute DL
    execDL(bus, width, height, commands, atlas);
    // VI vblank immediately after composition
    bus.vi.vblank();
  });

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, res };
}

// Schedule an SP interrupt (task start HLE) at spAtCycle, then at dpAtCycle execute the DL and vblank.
// This models an SP->DP pipeline in a simplified way while keeping deterministic timing.
export function scheduleSPTaskAndRunDL(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  commands: DLCommand[],
  atlas: TileAtlas,
  spAtCycle: number,
  dpAtCycle: number,
  totalCycles: number,
  stride?: number,
): DLResult {
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, (stride ?? width) >>> 0);
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  // Enable SP, DP, VI
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 0) | (1 << 5) | (1 << 3));

  // SP interrupt to indicate task start (use direct raise to avoid unintended DP timing)
  sys.scheduleAt(spAtCycle >>> 0, () => {
    bus.sp.raiseInterrupt();
    // Also write to SP_CMD to reflect a command write in RDRAM even if not used
    bus.storeU32(SP_BASE + SP_CMD_OFF, 0);
  });

  // DP complete + execute DL + VI vblank
  sys.scheduleAt(dpAtCycle >>> 0, () => {
    bus.dp.raiseInterrupt();
    execDL(bus, width, height, commands, atlas);
    bus.vi.vblank();
  });

  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, res };
}

// Sequence version: multiple DP completion times, each with its own DL
export function scheduleAndRunTitleDLSequence(
  cpu: CPU,
  bus: Bus,
  sys: System,
  origin: number,
  width: number,
  height: number,
  frames: { at: number; commands: DLCommand[] }[],
  atlas: TileAtlas,
  totalCycles: number,
  stride?: number,
): DLResult {
  bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
  bus.storeU32(VI_BASE + VI_WIDTH_OFF, (stride ?? width) >>> 0);
  const IE = 1 << 0; const IM2 = 1 << (8 + 2);
  cpu.cop0.write(12, IE | IM2);
  bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, (1 << 5) | (1 << 3));

  for (const f of frames) {
    sys.scheduleAt(f.at >>> 0, () => {
      bus.dp.raiseInterrupt();
      execDL(bus, width, height, f.commands, atlas);
      bus.vi.vblank();
    });
  }
  const res = runFrameLoop(cpu, bus, sys, totalCycles);
  const image = viScanout(bus, width, height);
  return { image, res };
}


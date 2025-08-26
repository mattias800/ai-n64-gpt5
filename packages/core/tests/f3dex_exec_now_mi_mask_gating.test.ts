import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { translateF3DEXAndExecNow } from '../src/boot/rsp_dl_hle.js';
import { viScanout } from '../src/system/video.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, MI_INTR_DP, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }
function pack12(hi: number, lo: number) { return ((((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0); }
const fp = (v: number) => ((v * 4) >>> 0);

describe('translateF3DEXAndExecNow MI mask gating for DP pending/cpu line', () => {
  it('sets DP pending without mask; enabling mask asserts cpu line; ack clears pending', () => {
    const width = 32, height = 24;
    const rdram = new RDRAM(1 << 20);
    const bus = new Bus(rdram);

    // Program VI
    const origin = 0xF000 >>> 0;
    w32(bus, VI_BASE + VI_ORIGIN_OFF, origin);
    w32(bus, VI_BASE + VI_WIDTH_OFF, width >>> 0);

    // Build tiny DL: TLUT(256), SETTIMG(CI8), SETTILESIZE(8x8), TEXRECT at (2,2), END
    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x1000) >>> 0;
    const tlutAddr = base >>> 0;
    const pixAddr = (base + 0x1000) >>> 0;
    const dlAddr = (base + 0x2000) >>> 0;
    const stagingAddr = (base + 0x3000) >>> 0;
    const strideWords = 0x200 >>> 2;

    const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    for (let i = 0; i < 256; i++) bus.storeU16((tlutAddr + i*2) >>> 0, i === 1 ? GREEN : 0);
    const TW = 8, TH = 8;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) bus.storeU8((pixAddr + (y*TW + x)) >>> 0, 1);

    let p = dlAddr >>> 0;
    w32(bus, p, (0xF0 << 24) | (256 & 0xFFFF)); p+=4; w32(bus, p, tlutAddr >>> 0); p+=4;
    w32(bus, p, ((0xFD << 24) | (1 << 19)) >>> 0); p+=4; w32(bus, p, pixAddr >>> 0); p+=4;
    w32(bus, p, ((0xF2 << 24) | pack12(fp(0), fp(0))) >>> 0); p+=4; w32(bus, p, pack12(fp(TW-1), fp(TH-1)) >>> 0); p+=4;
    w32(bus, p, ((0xE4 << 24) | pack12(fp(2), fp(2))) >>> 0); p+=4; w32(bus, p, pack12(fp(2+TW), fp(2+TH)) >>> 0); p+=4;
    w32(bus, p, (0xDF << 24) >>> 0); p+=4; w32(bus, p, 0); p+=4;

    // No MI mask initially
    expect(bus.mi.cpuIntAsserted()).toBe(false);

    // Execute now
    translateF3DEXAndExecNow(bus as any, width, height, dlAddr >>> 0, stagingAddr >>> 0, strideWords >>> 0);

    // DP pending should be set, but cpu line stays false since mask is disabled
    const pending = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(((pending >>> 0) & MI_INTR_DP) !== 0).toBe(true);
    expect(bus.mi.cpuIntAsserted()).toBe(false);

    // Enable DP mask -> cpu line now asserted
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_DP >>> 0);
    expect(bus.mi.cpuIntAsserted()).toBe(true);

    // Ack DP -> pending cleared and cpu line false
    w32(bus, DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR >>> 0);
    const pending2 = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(((pending2 >>> 0) & MI_INTR_DP) !== 0).toBe(false);
    expect(bus.mi.cpuIntAsserted()).toBe(false);

    // Optional: ensure scanout has some non-zero pixel
    const img = viScanout(bus as any, width, height);
    let anyAlpha = false; for (let i = 3; i < img.length; i += 4) { if (img[i] !== 0) { anyAlpha = true; break; } }
    expect(anyAlpha).toBe(true);
  });
});


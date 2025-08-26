import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { translateF3DEXAndExecNow } from '../src/boot/rsp_dl_hle.js';
import { viScanout } from '../src/system/video.js';
import { MI_BASE, MI_INTR_MASK_OFF, MI_INTR_OFF, MI_INTR_DP, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';

function w32(bus: Bus, addr: number, val: number) { bus.storeU32(addr >>> 0, val >>> 0); }
function r32(bus: Bus, addr: number) { return bus.loadU32(addr >>> 0) >>> 0; }

// Helper to pack 12-bit fields for F3DEX words
function pack12(hi: number, lo: number) { return ((((hi & 0xFFF) << 12) | (lo & 0xFFF)) >>> 0); }
const fp = (v: number) => ((v * 4) >>> 0); // 10.2 fixed

describe('translateF3DEXAndExecNow DP interrupt + basic render smoke', () => {
  it('raises MI DP pending and can be acknowledged via DP_STATUS; also draws to VI framebuffer', () => {
    const width = 64, height = 48;
    const rdram = new RDRAM(1 << 20);
    const bus = new Bus(rdram);

    // Program VI framebuffer
    const origin = 0xF000 >>> 0;
    w32(bus, VI_BASE + VI_ORIGIN_OFF, origin);
    w32(bus, VI_BASE + VI_WIDTH_OFF, width >>> 0);

    // Enable MI DP mask so cpu line logic would assert (though we won't step CPU here)
    w32(bus, MI_BASE + MI_INTR_MASK_OFF, MI_INTR_DP >>> 0);

    // Stage a tiny F3DEX DL: TLUT(256), SETTIMG(CI8), SETTILESIZE(8x8), TEXRECT(8x8 at 4,4), END
    const fbBytes = width * height * 2;
    const base = (origin + fbBytes + 0x1000) >>> 0;
    const tlutAddr = base >>> 0;
    const pixAddr = (base + 0x1000) >>> 0;
    const dlAddr = (base + 0x2000) >>> 0;
    const stagingAddr = (base + 0x4000) >>> 0;
    const strideWords = 0x400 >>> 2;

    // TLUT with entry 1 = solid green 5551
    const GREEN = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;
    for (let i = 0; i < 256; i++) bus.storeU16((tlutAddr + i*2) >>> 0, i === 1 ? GREEN : 0);

    // CI8 8x8 texture filled with index 1
    const TW = 8, TH = 8;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) bus.storeU8((pixAddr + (y*TW + x)) >>> 0, 1);

    // Build DL
    let p = dlAddr >>> 0;
    // G_LOADTLUT (0xF0)
    w32(bus, p, (0xF0 << 24) | (256 & 0xFFFF)); p = (p + 4) >>> 0; w32(bus, p, tlutAddr >>> 0); p = (p + 4) >>> 0;
    // G_SETTIMG (0xFD) siz=1 (CI8)
    w32(bus, p, ((0xFD << 24) | (1 << 19)) >>> 0); p = (p + 4) >>> 0; w32(bus, p, pixAddr >>> 0); p = (p + 4) >>> 0;
    // G_SETTILESIZE (0xF2) 8x8
    w32(bus, p, ((0xF2 << 24) | pack12(fp(0), fp(0))) >>> 0); p = (p + 4) >>> 0; w32(bus, p, pack12(fp(TW-1), fp(TH-1)) >>> 0); p = (p + 4) >>> 0;
    // G_TEXRECT (0xE4) at (4,4)
    w32(bus, p, ((0xE4 << 24) | pack12(fp(4), fp(4))) >>> 0); p = (p + 4) >>> 0; w32(bus, p, pack12(fp(4+TW), fp(4+TH)) >>> 0); p = (p + 4) >>> 0;
    // G_ENDDL (0xDF)
    w32(bus, p, (0xDF << 24) >>> 0); p = (p + 4) >>> 0; w32(bus, p, 0); p = (p + 4) >>> 0;

    // Call translate-and-execute-now
    translateF3DEXAndExecNow(bus as any, width, height, dlAddr >>> 0, stagingAddr >>> 0, strideWords >>> 0);

    // DP pending should be set
    const pending = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(((pending >>> 0) & MI_INTR_DP) !== 0).toBe(true);

    // Ack DP interrupt
    w32(bus, DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR >>> 0);
    const pending2 = r32(bus, MI_BASE + MI_INTR_OFF);
    expect(((pending2 >>> 0) & MI_INTR_DP) !== 0).toBe(false);

    // Scanout should produce some non-zero pixels; CRC is optional, but verify non-uniform buffer
    const img = viScanout(bus as any, width, height);
    // Count non-zero alpha pixels
    let alphaCount = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] !== 0) { alphaCount++; break; }
    expect(alphaCount > 0).toBe(true);
  });
});


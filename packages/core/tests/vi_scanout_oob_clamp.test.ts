import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { VI_BASE, VI_ORIGIN_OFF, VI_WIDTH_OFF } from '../src/devices/mmio.js';
import { viDrawHorizontalGradient } from '../src/system/video_hle.js';
import { viScanout } from '../src/system/video.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('VI scanout OOB clamp and safety', () => {
  it('draws near end of RDRAM without OOB writes; scanout beyond memory returns alpha=0', () => {
    const rdram = new RDRAM(0x1000); // 4KB
    const bus = new Bus(rdram);

    const w = 64, h = 32;
    const origin = 0x0F00; // near end so bottom rows go OOB

    bus.storeU32(VI_BASE + VI_ORIGIN_OFF, origin >>> 0);
    bus.storeU32(VI_BASE + VI_WIDTH_OFF, w >>> 0);

    const blue  = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const green = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

    viDrawHorizontalGradient(bus, w, h, blue, green);
    const out = viScanout(bus, w, h);

    // Top-left pixel should be blue and opaque
    expect(px(out, 0, 0, w)).toEqual([0,0,255,255]);

    // Bottom-right pixel likely OOB -> should be zeros with alpha 0
    const [r,g,b,a] = px(out, w-1, h-1, w);
    expect(a).toBe(0);
    expect(r).toBe(0); expect(g).toBe(0); expect(b).toBe(0);
  });
});


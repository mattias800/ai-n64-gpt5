import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleTitleFramesAndRun, TitleLoopFrame } from '../src/boot/title_loop_hle.js';
import { Tile5551 } from '../src/system/video_hle.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('Title loop HLE multi-frame scheduling', () => {
  it('composes two frames with differing gradients and tile positions; processes two VI acks', () => {
    const rdram = new RDRAM(1 << 16);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 32, h = 24, origin = 0x3000;
    const blue = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const cyan = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;
    const red = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
    const green = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

    const tileA: Tile5551 = { dstX: 4, dstY: 5, width: 6, height: 4, pixels: new Uint16Array(6 * 4).fill(red) };
    const tileB: Tile5551 = { dstX: 10, dstY: 12, width: 5, height: 3, pixels: new Uint16Array(5 * 3).fill(green) };

    const frames: TitleLoopFrame[] = [
      { at: 2, bgStart5551: blue, bgEnd5551: cyan, tiles: [tileA] },
      { at: 5, bgStart5551: cyan, bgEnd5551: blue, tiles: [tileB] },
    ];

    const { image, res } = scheduleTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 8);

    // Exactly two VI acknowledgments expected from the frame loop
    expect(res.viAcks).toBe(2);

    // Final frame should reflect the second composition (cyan->blue with green tile at (10,12))
    // Check a pixel inside tileB
    expect(px(image, 12, 13, w)).toEqual([0,255,0,255]);
    // Check left edge still close to cyan/blue depending on interpolation; at x=0 should be near start color of frame 2 (cyan)
    const [r,g,b,a] = px(image, 0, Math.floor(h/2), w);
    expect(r).toBe(0);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    expect(a).toBe(255);
    // Check a pixel where tileA was on first frame should now be background (not red)
    const [r2,g2,b2,a2] = px(image, 6, 6, w);
    expect(!(r2 > 200 && g2 === 0 && b2 === 0)).toBe(true);
  });
});


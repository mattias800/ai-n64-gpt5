import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleTitleFramesAndRun, TitleLoopFrame } from '../src/boot/title_loop_hle.js';
import { Tile5551 } from '../src/system/video_hle.js';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('Title loop same-cycle coalescing and last-writer-wins', () => {
  it('scheduling two compositions in the same cycle results in one VI ack; last composition visible', () => {
    const rdram = new RDRAM(1 << 16);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 32, h = 24, origin = 0x5000;
    const blue = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const cyan = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0;
    const red = ((31 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;
    const green = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

    const tileRed: Tile5551 = { dstX: 4, dstY: 4, width: 6, height: 4, pixels: new Uint16Array(6*4).fill(red) };
    const tileGreen: Tile5551 = { dstX: 8, dstY: 6, width: 6, height: 4, pixels: new Uint16Array(6*4).fill(green) };

    const frames: TitleLoopFrame[] = [
      { at: 3, bgStart5551: blue, bgEnd5551: cyan, tiles: [tileRed] },
      { at: 3, bgStart5551: cyan, bgEnd5551: blue, tiles: [tileGreen] },
    ];

    const { image, res } = scheduleTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 6);

    // Two vblank raises in same cycle should coalesce to one CPU interrupt acknowledgment
    expect(res.viAcks).toBe(1);
    // The last scheduled composition (green tile) should be visible where it draws
    expect(px(image, 9, 7, w)).toEqual([0,255,0,255]);
    // And a spot where only the first tile would have drawn should not be red (it was overwritten by second composition)
    const [r,g,b,a] = px(image, 5, 5, w);
    expect(!(r > 200 && g === 0 && b === 0)).toBe(true);
  });
});


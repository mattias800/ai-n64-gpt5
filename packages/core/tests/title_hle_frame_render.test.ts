import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { CPU } from '../src/cpu/cpu.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderFrameGradient } from '../src/boot/title_frame_hle.js';

function pxAt(out: Uint8Array, x: number, y: number, w: number): number[] {
  const i = (y * w + x) * 4;
  return [out[i], out[i+1], out[i+2], out[i+3]];
}

describe('Title frame HLE gradient render + vblank', () => {
  it('renders a gradient and acknowledges one VI interrupt', () => {
    const bus = new Bus(new RDRAM(1 << 16));
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const origin = 0x1000;
    const w = 8, h = 4;
    const blue = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const green = ((0 << 11) | (31 << 6) | (0 << 1) | 1) >>> 0;

    const { image, res } = hleTitleRenderFrameGradient(cpu, bus, sys, origin, w, h, blue, green);

    // Exactly one VI ack expected
    expect(res.viAcks).toBe(1);

    // Endpoints check on top row
    expect(pxAt(image, 0, 0, w)).toEqual([0, 0, 255, 255]);
    expect(pxAt(image, w-1, 0, w)).toEqual([0, 255, 0, 255]);
  });
});


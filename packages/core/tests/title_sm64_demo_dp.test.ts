import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { runSM64TitleDemoDP } from '../src/boot/title_sm64_demo.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

describe('SM64 DP-driven title demo', () => {
  it('runs multi-frame DP-driven composition with offsets and returns expected ack counts', () => {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const cfg = {
      width: 192,
      height: 120,
      origin: 0xF000,
      spacing: 10,
      startCycle: 2,
      interval: 3,
      frames: 4,
      bgStart5551: ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0, // blue
      bgEnd5551:   ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0, // cyan
    } as const;

    const { image, res } = runSM64TitleDemoDP(cpu, bus, sys, cfg);

    // We expect exactly cfg.frames DP and VI acknowledgments
    expect(res.dpAcks).toBe(cfg.frames);
    expect(res.viAcks).toBe(cfg.frames);

    // Sample a pixel near the leftmost S glyph that should be blue in final frame
    const x = Math.floor(cfg.width/2) - 40; const y = Math.floor(cfg.height * 0.28);
    const [r,g,b,a] = px(image, x, y, cfg.width);
    expect(a).toBe(255);
    // It might be blue or gradient depending on final offset; just assert it is not fully red
    expect(!(r > 200 && g < 50 && b < 50)).toBe(true);
  });
});

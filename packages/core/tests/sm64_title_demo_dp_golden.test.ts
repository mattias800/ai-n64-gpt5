import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { runSM64TitleDemoDP } from '../src/boot/title_sm64_demo.ts';
import { crc32, maybeWritePPM } from './helpers/test_utils.ts';

// Golden framebuffer hash for SM64 DP-driven title demo

describe('sm64_title_demo_dp_golden', () => {
  it('produces stable DP/VI acks and framebuffer CRC32', () => {
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

    // Golden on a behavior basis: acks must equal frame count
    expect(res.dpAcks).toBe(cfg.frames);
    expect(res.viAcks).toBe(cfg.frames);

    // Snapshot optionally
    maybeWritePPM(image, cfg.width, cfg.height, 'tmp/snapshots/sm64_title_demo_final.ppm');

    // Golden framebuffer hash. If this fails after intentional visual change, update expected.
    const hash = crc32(image);
    expect(hash).toBe('ca5a3813');
  });
});


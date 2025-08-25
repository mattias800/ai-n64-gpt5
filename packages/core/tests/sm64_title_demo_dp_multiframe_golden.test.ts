import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { runSM64TitleDemoDP, TitleSM64Config } from '../src/boot/title_sm64_demo.ts';
import { crc32, maybeWritePPM } from './helpers/test_utils.ts';

// Multi-frame golden for SM64 DP-driven title demo: verify CRC for 1 frame and 2 frames

describe('sm64_title_demo_dp_multiframe_golden', () => {
  function runOnce(frameCount: number) {
    const rdram = new RDRAM(1 << 19);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const cfg: TitleSM64Config = {
      width: 192,
      height: 120,
      origin: 0xF000,
      spacing: 10,
      startCycle: 2,
      interval: 3,
      frames: frameCount,
      bgStart5551: ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0, // blue
      bgEnd5551:   ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0, // cyan
    } as const;

    const { image, frames: perFrames, res } = runSM64TitleDemoDP(cpu, bus, sys, cfg);
    return { image, perFrames, res, cfg };
  }

  it('1 frame: correct acks and CRC', () => {
    const { image, perFrames, res, cfg } = runOnce(1);
    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);
    maybeWritePPM(image, cfg.width, cfg.height, 'tmp/snapshots/sm64_demo_1f.ppm');
    const hash = crc32(image);
    expect(hash).toBe('6ca0bc0e');
    // Per-frame CRCs
    expect(perFrames.length).toBe(1);
    expect(crc32(perFrames[0]!)).toBe('6ca0bc0e');
  });

  it('2 frames: correct acks and CRC', () => {
    const { image, perFrames, res, cfg } = runOnce(2);
    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);
    maybeWritePPM(image, cfg.width, cfg.height, 'tmp/snapshots/sm64_demo_2f.ppm');
    const hash = crc32(image);
    expect(hash).toBe('db86e0b3');
    // Per-frame CRCs
    expect(perFrames.length).toBe(2);
    expect(crc32(perFrames[0]!)).toBe('6ca0bc0e');
    expect(crc32(perFrames[1]!)).toBe('db86e0b3');
  });
});


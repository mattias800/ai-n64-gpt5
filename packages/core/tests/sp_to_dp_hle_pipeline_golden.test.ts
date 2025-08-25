import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleSPTaskAndRunDL } from '../src/boot/title_dl_hle.ts';
import { dlSolid, COLORS_5551, crc32, maybeWritePPM } from './helpers/test_utils.ts';

// Golden: SP->DP HLE pipeline schedules SP interrupt followed by DP completion and DL execution

describe('sp_to_dp_hle_pipeline_golden', () => {
  it('raises SP then DP, composes DL, vblank, and yields stable acks and framebuffer CRC', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=160,h=120, origin=0xD400;
    const dl = [
      dlSolid(COLORS_5551.cyan),
    ];

    const spAt=2, dpAt=5, total=10;
    const { image, res } = scheduleSPTaskAndRunDL(cpu, bus, sys, origin, w, h, dl, {}, spAt, dpAt, total);

    // Expect one SP ack, one DP ack, one VI ack, and no others
    expect(res.spAcks).toBe(1);
    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);
    expect(res.aiAcks).toBe(0);
    expect(res.siAcks).toBe(0);

    maybeWritePPM(image, w, h, 'tmp/snapshots/sp_dp_pipeline.ppm');

    const hash = crc32(image);
    expect(hash).toBe('9bf06dc7');
  });
});


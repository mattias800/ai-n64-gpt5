import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { buildRing32Atlas16 } from '../src/boot/title_logo_real_atlas.ts';
import { crc32, dlSolid, COLORS_5551, maybeWritePPM } from './helpers/test_utils.ts';

// Golden CRC for the ring atlas DL HLE frame to guard seams/placement and palette handling

describe('title_dl_hle_real_atlas_golden', () => {
  it('composes 2x2 ring tiles with DP/VI acks and stable framebuffer CRC32', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=200,h=140, origin=0xBA00;
    const atlas: TileAtlas = buildRing32Atlas16(COLORS_5551.green);

    const x0=80, y0=50;
    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'draw_tile' as const, id:'RING00', x: x0, y: y0 },
      { op:'draw_tile' as const, id:'RING01', x: x0+16, y: y0 },
      { op:'draw_tile' as const, id:'RING10', x: x0, y: y0+16 },
      { op:'draw_tile' as const, id:'RING11', x: x0+16, y: y0+16 },
    ];

    const { image, res } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, atlas, 3, 8);

    expect(res.dpAcks).toBe(1);
    expect(res.viAcks).toBe(1);

    maybeWritePPM(image, w, h, 'tmp/snapshots/title_dl_ring_atlas.ppm');

    const hash = crc32(image);
    expect(hash).toBe('f6295cbf');
  });
});


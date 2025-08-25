import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDLSequence, TileAtlas } from '../src/boot/title_dl_hle.ts';
import { crc32, dlSolid, COLORS_5551, maybeWritePPM } from './helpers/test_utils.ts';

// Golden: CI8/TLUT rendering across two frames with different palettes and positions

describe('title_dl_hle_ci8_tlut_golden', () => {
  it('renders CI8 with two TLUTs across frames and yields stable framebuffer CRC32', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=128,h=96, origin=0xC800;

    // Build a small 8x8 CI8 checker using indices 0..3
    const imgW=8, imgH=8;
    const data = new Uint8Array(imgW * imgH);
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const idx = ((x>>1) + (y>>1)) % 4; // 2x2 block pattern
        data[y*imgW + x] = idx;
      }
    }

    // Palette A: 0..3 = blue, green, red, yellow
    const tlutA = new Uint16Array(256);
    tlutA[0] = COLORS_5551.blue;
    tlutA[1] = COLORS_5551.green;
    tlutA[2] = COLORS_5551.red;
    tlutA[3] = ((31<<11)|(31<<6)|(0<<1)|1)>>>0; // yellow

    // Palette B: 0..3 = magenta, cyan, white, black(transparent off)
    const tlutB = new Uint16Array(256);
    tlutB[0] = COLORS_5551.magenta;
    tlutB[1] = COLORS_5551.cyan;
    tlutB[2] = COLORS_5551.white;
    tlutB[3] = COLORS_5551.black; // A=1 in black constant; ok for our model

    const frames = [
      { at: 2, commands: [
          dlSolid(COLORS_5551.blue),
          { op:'set_tlut' as const, tlut: tlutA },
          { op:'set_texture' as const, format:'CI8', width: imgW, height: imgH, data },
          { op:'draw_tex' as const, x: 10, y: 12 },
        ] },
      { at: 6, commands: [
          dlSolid(COLORS_5551.red),
          { op:'set_tlut' as const, tlut: tlutB },
          { op:'set_texture' as const, format:'CI8', width: imgW, height: imgH, data },
          { op:'draw_tex' as const, x: 40, y: 30 },
        ] },
    ];

    const { image, res } = scheduleAndRunTitleDLSequence(cpu, bus, sys, origin, w, h, frames, {} as TileAtlas, 12);

    expect(res.dpAcks).toBe(2);
    expect(res.viAcks).toBe(2);

    maybeWritePPM(image, w, h, 'tmp/snapshots/ci8_tlut_sequence.ppm');

    const hash = crc32(image);
    expect(hash).toBe('cfbc3fb3');
  });
});


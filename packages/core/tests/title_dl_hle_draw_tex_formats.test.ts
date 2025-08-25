import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleAndRunTitleDL } from '../src/boot/title_dl_hle.ts';
import { px, dlSolid, COLORS_5551, maybeWritePPM } from './helpers/test_utils.ts';

// Validate draw_tex with I4 and IA8 formats: decoding, alpha handling, and placement.

describe('DL HLE draw_tex I4, IA8, I8, IA16, RGBA16 formats', () => {
  it('renders I4 grayscale with alpha derived from intensity', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=36,h=24, origin=0xD000;

    // 2x2 I4 texels packed into 1 byte: hi=0xF (opaque white), lo=0x0 (transparent black)
    const data = new Uint8Array([0xF0]);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_texture' as const, format:'I4', width:2, height:2, data },
      { op:'draw_tex' as const, x: 10, y: 6, width: 2, height: 2 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // Top-left should be white (scaled to 5-bit max), top-right transparent → background blue
    const white = [255,255,255,255];
    expect(px(image, 10, 6, w)).toEqual(white);
    expect(px(image, 11, 6, w)).toEqual([0,0,255,255]);
  });

  it('renders I8 grayscale with alpha derived from intensity (>0 => opaque)', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=36,h=24, origin=0xD020;

    // 2x1 I8 texels: [0x40, 0x00] => mid-gray opaque, transparent black
    const data = new Uint8Array([0x40, 0x00]);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_texture' as const, format:'I8', width:2, height:1, data },
      { op:'draw_tex' as const, x: 10, y: 8, width: 2, height: 1 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // First pixel opaque gray, second should be background due to zero intensity
    const p0 = px(image, 10, 8, w); expect(p0[3]).toBe(255);
    expect(px(image, 11, 8, w)).toEqual([0,0,255,255]);
  });

  it('renders IA8 grayscale with alpha threshold at 8/16 (>=8 => opaque)', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=36,h=24, origin=0xD040;

    // 2x1 IA8 texels in two bytes: [I=0x8, A=0x8] (opaque mid-gray), [I=0x7, A=0x7] (transparent)
    const data = new Uint8Array([0x88, 0x77]);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_texture' as const, format:'IA8', width:2, height:1, data },
      { op:'draw_tex' as const, x: 10, y: 10, width: 2, height: 1 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // First pixel opaque gray, second should be background due to alpha < 8
    const gray = px(image, 10, 10, w); // Just verify opaque and not blue
    expect(gray[3]).toBe(255); // alpha 255
    expect(px(image, 11, 10, w)).toEqual([0,0,255,255]);
  });

  it('renders IA16 grayscale with alpha threshold at 128/255 (>=128 => opaque)', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=40,h=28, origin=0xD060;

    // 2x1 IA16 texels: [I=200,A=200] opaque mid, [I=60,A=60] transparent
    const data = new Uint8Array([200,200, 60,60]);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_texture' as const, format:'IA16', width:2, height:1, data },
      { op:'draw_tex' as const, x: 12, y: 9, width: 2, height: 1 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // First pixel opaque, second falls through to background
    const a0 = px(image, 12, 9, w)[3]; expect(a0).toBe(255);
    expect(px(image, 13, 9, w)).toEqual([0,0,255,255]);
  });

  it('renders RGBA16 directly without TLUT', () => {
    const rdram = new RDRAM(1<<18);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w=40,h=28, origin=0xD080;

    // 2x1 RGBA16 pixels: magenta and green (both opaque)
    const p0 = ((31<<11)|(0<<6)|(31<<1)|1)>>>0; // magenta 5551
    const p1 = ((0<<11)|(31<<6)|(0<<1)|1)>>>0;  // green
    const data = new Uint16Array([p0, p1]);

    const dl = [
      dlSolid(COLORS_5551.blue),
      { op:'set_texture' as const, format:'RGBA16', width:2, height:1, data },
      { op:'draw_tex' as const, x: 6, y: 6, width: 2, height: 1 },
    ];

    const { image } = scheduleAndRunTitleDL(cpu, bus, sys, origin, w, h, dl, {}, 3, 10);

    // Optional snapshot for manual inspection
    maybeWritePPM(image, w, h, 'tmp/snapshots/title_dl_draw_tex_rgba16.ppm');

    expect(px(image, 6, 6, w)).toEqual([255,0,255,255]);
    expect(px(image, 7, 6, w)).toEqual([0,255,0,255]);
  });
});


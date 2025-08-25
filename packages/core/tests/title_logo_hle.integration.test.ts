import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { hleTitleRenderLogo, TitleFrameResult } from '../src/boot/title_logo_hle.js';
import { Tile5551 } from '../src/system/video_hle.js';

describe('Title Logo HLE Render (integration)', () => {
  it('renders gradient background and tiles correctly', () => {
    const rdram = new RDRAM();
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width = 64;
    const height = 48;
    const origin = 0x200000;

    const bgStart = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0; // blue RGBA5551
    const bgEnd = ((0 << 11) | (31 << 6) | (31 << 1) | 1) >>> 0; // cyan RGBA5551

    const red = 0xF801;
    const green = 0x07C1;

    const tiles: Tile5551[] = [
      { dstX: 10, dstY: 10, width: 8, height: 8, pixels: new Uint16Array(8 * 8).fill(red) },
      { dstX: 20, dstY: 20, width: 6, height: 6, pixels: new Uint16Array(6 * 6).fill(green) },
    ];

    const result: TitleFrameResult = hleTitleRenderLogo(cpu, bus, sys, origin, width, height, bgStart, bgEnd, tiles);

    expect(result.res.viAcks).toBe(1);
    expect(result.image.length).toBe(width * height * 4);

    const getPixel = (x: number, y: number) => {
      const o = (y * width + x) * 4;
      return [result.image[o], result.image[o + 1], result.image[o + 2], result.image[o + 3]] as const;
    };

    const [r0,g0,b0,a0] = getPixel(0, Math.floor(height/2));
    expect(r0).toBe(0); expect(g0).toBe(0); expect(b0).toBeGreaterThan(200); expect(a0).toBe(255);

    const [r1,g1,b1,a1] = getPixel(width-1, Math.floor(height/2));
    expect(r1).toBe(0); expect(g1).toBeGreaterThan(200); expect(b1).toBeGreaterThan(200); expect(a1).toBe(255);

    const [tr,tg,tb,ta] = getPixel(12, 12);
    expect(tr).toBeGreaterThan(200); expect(tg).toBe(0); expect(tb).toBe(0); expect(ta).toBe(255);

    const [gr,gg,gb,ga] = getPixel(22, 22);
    expect(gr).toBe(0); expect(gg).toBeGreaterThan(200); expect(gb).toBe(0); expect(ga).toBe(255);
  });
});


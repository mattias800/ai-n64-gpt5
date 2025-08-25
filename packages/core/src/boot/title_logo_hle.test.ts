import { describe, it, expect } from 'vitest';
import { CPU } from '../cpu/cpu.js';
import { Bus, RDRAM } from '../mem/bus.js';
import { System } from '../system/system.js';
import { hleTitleRenderLogo, TitleFrameResult } from './title_logo_hle.js';
import { Tile5551 } from '../system/video_hle.js';

describe('Title Logo HLE Render', () => {
  it('should render gradient background with composed tiles', () => {
    const rdram = new RDRAM();
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width = 320;
    const height = 240;
    const origin = 0x200000;

    // Blue to cyan gradient
    const bgStart = 0x001F; // Blue: R=0, G=0, B=31, A=1
    const bgEnd = 0x03FF;   // Cyan: R=0, G=31, B=31, A=1

    // Create test tiles: red and green squares (with alpha=1)
    const red = 0xF801;   // R=31,G=0,B=0,A=1
    const green = 0x07E1; // R=0,G=31,B=0,A=1

    const tiles: Tile5551[] = [
      {
        dstX: 50,
        dstY: 50,
        width: 40,
        height: 40,
        pixels: new Uint16Array(40 * 40).fill(red),
      },
      {
        dstX: 100,
        dstY: 100,
        width: 30,
        height: 30,
        pixels: new Uint16Array(30 * 30).fill(green),
      },
    ];

    const result: TitleFrameResult = hleTitleRenderLogo(
      cpu,
      bus,
      sys,
      origin,
      width,
      height,
      bgStart,
      bgEnd,
      tiles,
    );

    // Should have processed one VI interrupt
    expect(result.res.viAcks).toBe(1);
    expect(result.res.steps).toBeGreaterThan(0);

    // Verify image dimensions
    expect(result.image.length).toBe(width * height * 4);

    // Sample key pixels
    const getPixel = (x: number, y: number) => {
      const offset = (y * width + x) * 4;
      return {
        r: result.image[offset],
        g: result.image[offset + 1],
        b: result.image[offset + 2],
        a: result.image[offset + 3],
      };
    };

    // Check gradient background at left edge (should be blue)
    const leftBg = getPixel(0, 120);
    expect(leftBg.r).toBe(0);
    expect(leftBg.g).toBe(0);
    expect(leftBg.b).toBeGreaterThan(200); // Near full blue
    expect(leftBg.a).toBe(255);

    // Check gradient background at right edge (should be cyan)
    const rightBg = getPixel(319, 120);
    expect(rightBg.r).toBe(0);
    expect(rightBg.g).toBeGreaterThan(200); // Near full green
    expect(rightBg.b).toBeGreaterThan(200); // Near full blue
    expect(rightBg.a).toBe(255);

    // Check red tile at (70, 70)
    const redTile = getPixel(70, 70);
    expect(redTile.r).toBeGreaterThan(200); // Near full red
    expect(redTile.g).toBe(0);
    expect(redTile.b).toBe(0);
    expect(redTile.a).toBe(255);

    // Check green tile at (115, 115)
    const greenTile = getPixel(115, 115);
    expect(greenTile.r).toBe(0);
    expect(greenTile.g).toBeGreaterThan(200); // Near full green
    expect(greenTile.b).toBe(0);
    expect(greenTile.a).toBe(255);

    // Check gradient shows through outside tiles at (200, 150)
    const bgMiddle = getPixel(200, 150);
    expect(bgMiddle.r).toBe(0);
    expect(bgMiddle.g).toBeGreaterThan(50); // Some green from gradient
    expect(bgMiddle.b).toBeGreaterThan(200); // Full blue component
    expect(bgMiddle.a).toBe(255);
  });

  it('should handle empty tile list with gradient only', () => {
    const rdram = new RDRAM();
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const width = 160;
    const height = 120;
    const origin = 0x200000;

    // Yellow to magenta gradient
    const bgStart = 0xFFE1; // Yellow with A=1: R=31, G=31, B=0
    const bgEnd = 0xF81F;   // Magenta already has A=1: R=31, G=0, B=31

    const result: TitleFrameResult = hleTitleRenderLogo(
      cpu,
      bus,
      sys,
      origin,
      width,
      height,
      bgStart,
      bgEnd,
      [], // No tiles
    );

    expect(result.res.viAcks).toBe(1);
    expect(result.image.length).toBe(width * height * 4);

    // Verify gradient colors
    const getPixel = (x: number, y: number) => {
      const offset = (y * width + x) * 4;
      return {
        r: result.image[offset],
        g: result.image[offset + 1],
        b: result.image[offset + 2],
        a: result.image[offset + 3],
      };
    };

    // Left edge should be yellow
    const left = getPixel(0, 60);
    expect(left.r).toBeGreaterThan(200);
    expect(left.g).toBeGreaterThan(200);
    expect(left.b).toBe(0);

    // Right edge should be magenta
    const right = getPixel(159, 60);
    expect(right.r).toBeGreaterThan(200);
    expect(right.g).toBe(0);
    expect(right.b).toBeGreaterThan(200);
  });
});

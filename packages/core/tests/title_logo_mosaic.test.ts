import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { System } from '../src/system/system.js';
import { scheduleTitleFramesAndRun } from '../src/boot/title_loop_hle.js';
import { buildMosaicMTiles } from '../src/boot/title_logo_mosaic.ts';

function px(out: Uint8Array, x: number, y: number, w: number) {
  const i = (y * w + x) * 4; return [out[i], out[i+1], out[i+2], out[i+3]] as const;
}

// Verifies seam continuity across a 2x2 mosaic of tiles forming an 'M', and a one-pixel animation shift.
describe('Title mosaic: seam continuity and animation shift', () => {
  it('draws a continuous M across seams and shifts by 1px next frame', () => {
    const rdram = new RDRAM(1 << 16);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);
    const sys = new System(cpu, bus);

    const w = 64, h = 48, origin = 0x8000;
    const blue = ((0 << 11) | (0 << 6) | (31 << 1) | 1) >>> 0;
    const black = ((0 << 11) | (0 << 6) | (0 << 1) | 1) >>> 0;

    const tilesFrame0 = buildMosaicMTiles(w, h, { tileSize: 8 });
    const tilesFrame1 = buildMosaicMTiles(w, h, { tileSize: 8, offsetX: 1 });

    const frames = [
      { at: 2, bgStart5551: blue, bgEnd5551: blue, tiles: tilesFrame0 },
      { at: 4, bgStart5551: black, bgEnd5551: black, tiles: tilesFrame1 },
    ];

    const { image, res } = scheduleTitleFramesAndRun(cpu, bus, sys, origin, w, h, frames, 6);

    // Expect two VI acks (two vblanks)
    expect(res.viAcks).toBe(2);

    // Validate continuity on the final frame (shifted by +1): sample along left stroke across tile seam
    const seamX0 = Math.floor((w - 16) / 2) + 0; // originX for frame 0
    const seamX1 = seamX0 + 1; // originX after +1 shift in frame 1 (final)
    const seamYTop = Math.floor(h * 0.25);
    const red = [255,0,0,255] as const;
    // sample vertical run across tile seam at y=seamYTop..seamYTop+15 for final frame's left stroke
    for (let dy = 0; dy < 16; dy++) {
      expect(px(image, seamX1, seamYTop + dy, w)).toEqual(red);
    }

    // Validate the 1px shift: previous stroke position should now be background; shifted position is red
    const [r0,g0,b0,a0] = px(image, seamX0, seamYTop + 1, w);
    const [r1,g1,b1,a1] = px(image, seamX1, seamYTop + 1, w);
    // Final frame has black background; verify old position is black and shifted position is red
    expect([r0,g0,b0,a0]).toEqual([0,0,0,255]);
    expect([r1,g1,b1,a1]).toEqual(red);
  });
});


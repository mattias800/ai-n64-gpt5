import { describe, it, expect } from 'vitest';
import { runF3dexFromTableCore } from '../src/f3dex_runner';
import { crc32Hex } from '../src/crc32';

describe('web f3dex table core (gradient via bgStart/bgEnd)', () => {
  it('produces deterministic CRCs for 2 frames', () => {
    const cfg = {
      video: { width: 192, height: 120, origin: 0xF000 },
      timing: { start: 2, interval: 3, frames: 2, spOffset: 1 },
      f3dex: { strideWords: 256, bgStart: 0x001F, bgEnd: 0x07FF },
      frames: [ { dlWords: [0xDF000000, 0x00000000] }, { dlWords: [0xDF000000, 0x00000000] } ],
    };
    const res = runF3dexFromTableCore(cfg);
    expect(res.width).toBe(192);
    expect(res.height).toBe(120);
    expect(res.frames.length).toBe(2);
    const crcs = res.frames.map(f => crc32Hex(f));
    expect(crcs).toEqual(['139f1b8f', '139f1b8f']);
  });
});

import { describe, it, expect } from 'vitest';
import { runSm64TitleFramesCore } from '../src/sm64_title_runner';
import type { Sm64TitleConfig } from '../src/types';

const makeCfg = (frames: number): Sm64TitleConfig => ({
  video: { width: 192, height: 120, origin: 0xF000 },
  timing: { start: 2, interval: 3, frames, spOffset: 1 },
  bg: { start5551: 0x001F, end5551: 0x07FF },
  assets: {},
});

describe('web sm64 title core (fallback ring)', () => {
  it('produces stable CRCs for 2 frames', async () => {
    const rom = new Uint8Array(8 * 1024 * 1024);
    const cfg = makeCfg(2);
    const r1 = await runSm64TitleFramesCore(rom, cfg, 2);
    const r2 = await runSm64TitleFramesCore(rom, cfg, 2);
    expect(r1.width).toBe(192);
    expect(r1.height).toBe(120);
    expect(r1.crc32Hex.length).toBe(2);
    // Deterministic: CRCs should match across runs
    expect(r1.crc32Hex).toEqual(r2.crc32Hex);
    // Exact golden values for fallback ring + gradient
    expect(r1.crc32Hex).toEqual(["139f1b8f", "139f1b8f"]);
  });
});

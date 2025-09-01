import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { runSm64TitleFramesCore } from '../src/sm64_title_runner';
import { normalizeConfig } from '../src/ui';
import type { Sm64TitleConfig } from '../src/types';

const env = process.env;
const cfgPath = env.SM64_WEB_CFG;
const romPath = env.SM64_WEB_ROM;
const framesOverride = env.SM64_WEB_FRAMES ? Number(env.SM64_WEB_FRAMES) | 0 : undefined;

const enabled = !!cfgPath && !!romPath;

(enabled ? describe : describe.skip)('SM64 web ROM parity (optional)', () => {
  it('matches expectedCrc32 when provided in config, else validates CRC shape', async () => {
    const toAbs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
    const rom = new Uint8Array(readFileSync(toAbs(romPath!)));
    const raw = JSON.parse(readFileSync(toAbs(cfgPath!), 'utf8')) as unknown;
    const cfg: Sm64TitleConfig = normalizeConfig(raw);
    const frames = framesOverride ?? cfg.timing.frames ?? 2;

    const res = await runSm64TitleFramesCore(rom, cfg, frames);
    expect(res.width).toBe(cfg.video.width);
    expect(res.height).toBe(cfg.video.height);
    expect(res.crc32Hex.length).toBe(frames);

    if (Array.isArray(cfg.expectedCrc32) && cfg.expectedCrc32.length === frames) {
      const norm = (s: string) => s.toLowerCase().replace(/^0x/, '');
      const expected = cfg.expectedCrc32.map(s => norm(String(s)));
      expect(res.crc32Hex.map(norm)).toEqual(expected);
    } else {
      // Fallback shape validation
      for (const c of res.crc32Hex) expect(c).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

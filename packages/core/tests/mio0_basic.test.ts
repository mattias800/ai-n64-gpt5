import { describe, it, expect } from 'vitest';
import { decompressMIO0 } from '../src/utils/mio0.ts';

// Build a tiny MIO0 block that contains only literal bytes (no backrefs):
// Uncompressed payload: 'HELLO' (0x48 45 4C 4C 4F)
// Control word: first 5 bits are 1 (literal), remaining 27 are 0 -> 0xF8000000
// compOffset = 0x14, rawOffset = 0x14 (comp unused; raw begins right after control)

describe('mio0_basic', () => {
  it('decompresses a minimal literal-only MIO0 block', () => {
    const buf = new Uint8Array(0x14 + 5);
    // Magic 'MIO0'
    buf[0] = 0x4D; buf[1] = 0x49; buf[2] = 0x4F; buf[3] = 0x30;
    // Out size = 5
    buf[4] = 0x00; buf[5] = 0x00; buf[6] = 0x00; buf[7] = 0x05;
    // compOffset = 0x14
    buf[8] = 0x00; buf[9] = 0x00; buf[10] = 0x00; buf[11] = 0x14;
    // rawOffset = 0x14
    buf[12] = 0x00; buf[13] = 0x00; buf[14] = 0x00; buf[15] = 0x14;
    // Control word: 0xF8000000
    buf[16] = 0xF8; buf[17] = 0x00; buf[18] = 0x00; buf[19] = 0x00;
    // Raw bytes: 'HELLO'
    buf[20] = 0x48; buf[21] = 0x45; buf[22] = 0x4C; buf[23] = 0x4C; buf[24] = 0x4F;

    const out = decompressMIO0(buf, 0);
    expect(Array.from(out)).toEqual([0x48, 0x45, 0x4C, 0x4C, 0x4F]);
  });
});

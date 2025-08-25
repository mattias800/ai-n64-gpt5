import { describe, it, expect } from 'vitest';
import { decodeCI8ToRGBA5551, decodeI4ToRGBA5551, decodeIA8ToRGBA5551, decodeIA16ToRGBA5551, decodeI8ToRGBA5551, decodeCI4ToRGBA5551 } from '../src/gfx/n64_textures.ts';

function rgb5To8(v: number) { return (v * 255 / 31) | 0; }
function unpack5551(p: number) {
  const r5=(p>>>11)&0x1f, g5=(p>>>6)&0x1f, b5=(p>>>1)&0x1f, a=(p&1)?255:0;
  return [rgb5To8(r5), rgb5To8(g5), rgb5To8(b5), a] as const;
}

describe('N64 texture decoders', () => {
  it('decodes CI8 with TLUT to RGBA5551', () => {
    // TLUT: 0->black, 1->green, 2->red, others 0
    const tlut = new Uint16Array(256);
    const RED5551 = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    const GREEN5551 = ((0<<11)|(31<<6)|(0<<1)|1)>>>0;
    tlut[1] = GREEN5551; tlut[2] = RED5551;
    const idx = new Uint8Array([0,1,2,1]);
    const out = decodeCI8ToRGBA5551(idx, tlut, 2, 2);
    expect(Array.from(out)).toEqual([0, GREEN5551, RED5551, GREEN5551]);
    // spot check unpack
    expect(unpack5551(out[1]!)).toEqual([0,255,0,255]);
  });

  it('decodes I4 to grayscale with alpha from intensity > 0', () => {
    // Pack two pixels per byte: [0xF,0x0] and [0x8,0x7]
    const data = new Uint8Array([0xF0, 0x87]);
    const out = decodeI4ToRGBA5551(data, 2, 2);
    // Expect: bright gray opaque, black transparent, mid gray opaque, slightly dimmer opaque
    const px = Array.from(out);
    expect(px.length).toBe(4);
    const a = unpack5551(px[0]!); const b = unpack5551(px[1]!); const c = unpack5551(px[2]!); const d = unpack5551(px[3]!);
    expect(a[3]).toBe(255); expect(b[3]).toBe(0); expect(c[3]).toBe(255); expect(d[3]).toBe(255);
    expect(a[0]).toBeGreaterThan(c[0]); // 0xF > 0x8 intensity
  });

  it('decodes IA8 to grayscale with thresholded alpha', () => {
    // bytes: 0xF0 (I=15,A=0) -> opaque? a4=0 => a1=0; 0x8F (I=8,A=15) -> a1=1
    const data = new Uint8Array([0xF0, 0x8F]);
    const out = decodeIA8ToRGBA5551(data, 2, 1);
    const a = unpack5551(out[0]!); const b = unpack5551(out[1]!);
    expect(a[3]).toBe(0); expect(b[3]).toBe(255);
    expect(b[0]).toBeGreaterThan(0); // non-zero intensity
  });
  it('decodes IA16 (I,A) to RGBA5551', () => {
    // Two pixels: (I=255,A=255) and (I=64,A=0)
    const data = new Uint8Array([255,255, 64,0]);
    const out = decodeIA16ToRGBA5551(data, 2, 1);
    const a = unpack5551(out[0]!); const b = unpack5551(out[1]!);
    expect(a[3]).toBe(255); expect(b[3]).toBe(0);
    expect(a[0]).toBeGreaterThan(b[0]);
  });

  it('decodes I8 to grayscale with alpha from intensity > 0', () => {
    const data = new Uint8Array([0, 128, 255, 1]);
    const out = decodeI8ToRGBA5551(data, 4, 1);
    const a = unpack5551(out[0]!); const b = unpack5551(out[1]!); const c = unpack5551(out[2]!); const d = unpack5551(out[3]!);
    expect(a[3]).toBe(0); expect(b[3]).toBe(255); expect(c[3]).toBe(255); expect(d[3]).toBe(255);
    expect(c[0]).toBeGreaterThan(b[0]);
  });

  it('decodes CI4 with 16-entry TLUT', () => {
    const tlut16 = new Uint16Array(16);
    const RED5551 = ((31<<11)|(0<<6)|(0<<1)|1)>>>0;
    const GREEN5551 = ((0<<11)|(31<<6)|(0<<1)|1)>>>0;
    tlut16[0xA] = RED5551; tlut16[0x1] = GREEN5551;
    // Pack pixels: [0xA,0x1], [0x1,0xA]
    const data = new Uint8Array([0xA1, 0x1A]);
    const out = decodeCI4ToRGBA5551(data, tlut16, 4, 1);
    expect(Array.from(out)).toEqual([RED5551, GREEN5551, GREEN5551, RED5551]);
  });
});


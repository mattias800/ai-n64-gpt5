import { describe, it, expect } from 'vitest';
import { normalizeRomToBigEndian, detectByteOrder } from '../src/rom/byteorder.js';
import { parseHeader } from '../src/rom/header.js';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { hleBoot } from '../src/boot/hle.js';

function makeRom(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function makeZ64(initialPC: number): Uint8Array {
  const rom = new Uint8Array(0x1000);
  // magic 0x80371240
  rom[0] = 0x80; rom[1] = 0x37; rom[2] = 0x12; rom[3] = 0x40;
  // initial PC at 0x8..0xB
  rom[8] = (initialPC >>> 24) & 0xff;
  rom[9] = (initialPC >>> 16) & 0xff;
  rom[10] = (initialPC >>> 8) & 0xff;
  rom[11] = (initialPC >>> 0) & 0xff;
  // title at 0x20..
  const title = 'TEST-EMU';
  for (let i = 0; i < title.length; i++) rom[0x20 + i] = title.charCodeAt(i);
  return rom;
}

function le32(x: number): [number, number, number, number] {
  return [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff];
}

function be32(x: number): [number, number, number, number] {
  return [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];
}

describe('ROM byte order detection and normalization', () => {
  it('detects z64/n64/v64 and normalizes to big-endian', () => {
    const initialPC = 0x80400000 >>> 0;
    const z64 = makeZ64(initialPC);

    // Create n64 (LE) by reversing each 32-bit word
    const n64 = new Uint8Array(z64.length);
    for (let i = 0; i + 3 < z64.length; i += 4) {
      n64[i + 0] = z64[i + 3];
      n64[i + 1] = z64[i + 2];
      n64[i + 2] = z64[i + 1];
      n64[i + 3] = z64[i + 0];
    }

    // Create v64 (byteswapped 16-bit) by swapping each pair
    const v64 = new Uint8Array(z64.length);
    for (let i = 0; i + 1 < z64.length; i += 2) {
      v64[i + 0] = z64[i + 1];
      v64[i + 1] = z64[i + 0];
    }

    expect(detectByteOrder(z64)).toBe('z64');
    expect(detectByteOrder(n64)).toBe('n64');
    expect(detectByteOrder(v64)).toBe('v64');

    const normZ = normalizeRomToBigEndian(z64);
    const normN = normalizeRomToBigEndian(n64);
    const normV = normalizeRomToBigEndian(v64);

    // After normalization, headers should match
    expect(Array.from(normZ.data.slice(0, 0x40))).toStrictEqual(Array.from(normN.data.slice(0, 0x40)));
    expect(Array.from(normZ.data.slice(0, 0x40))).toStrictEqual(Array.from(normV.data.slice(0, 0x40)));

    // Parsing header yields same initial PC
    const hZ = parseHeader(normZ.data);
    const hN = parseHeader(normN.data);
    const hV = parseHeader(normV.data);
    expect(hZ.initialPC >>> 0).toBe(initialPC >>> 0);
    expect(hN.initialPC >>> 0).toBe(initialPC >>> 0);
    expect(hV.initialPC >>> 0).toBe(initialPC >>> 0);
  });
});

describe('HLE boot copies ROM and sets PC from header', () => {
  it('loads ROM to RDRAM and sets CPU PC deterministically', () => {
    const initialPC = 0x80200000 >>> 0;
    const rom = makeZ64(initialPC);
    const rdram = new RDRAM(2 * 1024 * 1024);
    const bus = new Bus(rdram);
    const cpu = new CPU(bus);

    const ret = hleBoot(cpu, bus, rom);
    expect(ret.initialPC >>> 0).toBe(initialPC >>> 0);
    expect(cpu.pc >>> 0).toBe(initialPC >>> 0);
    // Magic should be present in RDRAM at 0
    expect(rdram.bytes[0]).toBe(0x80);
    expect(rdram.bytes[1]).toBe(0x37);
  });
});


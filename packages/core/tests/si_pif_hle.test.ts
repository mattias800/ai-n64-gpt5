import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { hlePifControllerStatus, hlePifReadControllerState } from '../src/boot/pif_hle.js';

describe('PIF HLE helpers', () => {
  it('controller status returns present/no-pak', () => {
    const bus = new Bus(new RDRAM(4096));
    const s = hlePifControllerStatus(bus, 0x100);
    expect(s.present).toBe(true);
    expect(s.pak).toBe(0x00);
  });

  it('read controller state returns fixed mask and stick', () => {
    const bus = new Bus(new RDRAM(4096));
    const st = hlePifReadControllerState(bus, 0x200);
    expect(st.status).toBe(0x00);
    expect(st.buttons >>> 0).toBe(0x1234 >>> 0);
    expect(st.stickX).toBe(5);
    expect(st.stickY).toBe(-5);
  });
});

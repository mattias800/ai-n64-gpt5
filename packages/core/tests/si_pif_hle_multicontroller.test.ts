import { describe, it, expect } from 'vitest';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { hlePifControllerStatusPort, hlePifReadControllerStatePort } from '../src/boot/pif_hle.js';

describe('PIF HLE multi-controller (port) support', () => {
  it('port 0 returns present and valid state; other ports return not present / error status', () => {
    const bus = new Bus(new RDRAM(4096));

    // Port 0
    const s0 = hlePifControllerStatusPort(bus, 0x100, 0);
    expect(s0.present).toBe(true);
    const st0 = hlePifReadControllerStatePort(bus, 0x140, 0);
    expect(st0.status).toBe(0x00);
    expect(st0.buttons >>> 0).toBe(0x1234 >>> 0);
    expect(st0.stickX).toBe(5);
    expect(st0.stickY).toBe(-5);

    // Port 1
    const s1 = hlePifControllerStatusPort(bus, 0x180, 1);
    expect(s1.present).toBe(false);
    const st1 = hlePifReadControllerStatePort(bus, 0x1C0, 1);
    expect(st1.status).toBe(0xFF);
    expect(st1.buttons >>> 0).toBe(0);
    expect(st1.stickX).toBe(0);
    expect(st1.stickY).toBe(0);

    // Port 3
    const s3 = hlePifControllerStatusPort(bus, 0x200, 3);
    expect(s3.present).toBe(false);
    const st3 = hlePifReadControllerStatePort(bus, 0x240, 3);
    expect(st3.status).toBe(0xFF);
    expect(st3.buttons >>> 0).toBe(0);
    expect(st3.stickX).toBe(0);
    expect(st3.stickY).toBe(0);
  });
});


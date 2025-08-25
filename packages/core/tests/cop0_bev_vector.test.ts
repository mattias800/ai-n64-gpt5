import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';

function NOP() { return 0; }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('CP0 BEV vector selection', () => {
  it('vectors to 0xBFC00180 when BEV=1 and to 0x80000180 when BEV=0', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    loadProgram(bus.rdram, [NOP()], 0);

    // Set BEV=1 and trigger an interrupt via MI (mask+pending)
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const BEV = 1 << 22;
    cpu.cop0.write(12, IE | IM2 | BEV);

    // Raise SI pending and enable mask
    const MI_BASE = 0x04300000 >>> 0;
    const MI_INTR_MASK_OFF = 0x0C;
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 1);
    bus.mi.raise(1 << 1);

    // Step -> should take interrupt to BFC00180
    cpu.step();
    expect(cpu.pc >>> 0).toBe(0xBFC00180 >>> 0);

    // Clear EXL and BEV; ack SI
    const SI_BASE = 0x04800000 >>> 0;
    const SI_STATUS_OFF = 0x18; const SI_STATUS_DMA_BUSY = 1 << 0;
    bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);

    // Clear EXL and set BEV=0
    const st = cpu.cop0.read(12);
    cpu.cop0.write(12, (st & ~(1 << 1)) & ~(1 << 22));

    // Raise SI pending again
    bus.mi.raise(1 << 1);
    const expectedEPC = cpu.pc >>> 0;
    cpu.step();
    expect(cpu.pc >>> 0).toBe(0x80000180 >>> 0);
    expect(cpu.cop0.read(14) >>> 0).toBe(expectedEPC >>> 0);
  });
});


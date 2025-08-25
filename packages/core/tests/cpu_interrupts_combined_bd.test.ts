import { describe, it, expect } from 'vitest';
import { CPU } from '../src/cpu/cpu.js';
import { Bus, RDRAM } from '../src/mem/bus.js';
import { MI_BASE, MI_INTR_MASK_OFF, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT } from '../src/devices/mmio.js';

function BEQ(rs: number, rt: number, off: number) { return (0x04 << 26) | (rs << 21) | (rt << 16) | (off & 0xffff); }

function loadProgram(rdram: RDRAM, words: number[], base = 0) {
  for (let i = 0; i < words.length; i++) {
    rdram.bytes[base + i * 4 + 0] = (words[i] >>> 24) & 0xff;
    rdram.bytes[base + i * 4 + 1] = (words[i] >>> 16) & 0xff;
    rdram.bytes[base + i * 4 + 2] = (words[i] >>> 8) & 0xff;
    rdram.bytes[base + i * 4 + 3] = (words[i] >>> 0) & 0xff;
  }
}

describe('Combined CP0 timer (IP7) + MI (IP2) in branch delay; Compare clearing semantics', () => {
  it('BD case: both IP7 and IP2 set during branch window -> BD=1, EPC=branch PC, Cause has both bits', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // Enable IE, IM7, IM2; enable MI mask for VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM2 | IM7);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

    // Program: taken branch with delay slot at 4
    loadProgram(bus.rdram, [ BEQ(0, 0, 1), 0, 0 ], 0);

    // Prepare: VI pending will be raised during delay slot; timer: Count=0, Compare=2 (fires after delay slot executes)
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 2);

    // Step branch (schedules delay slot window)
    cpu.step();

    // During delay slot: raise VI pending, then execute delay slot
    bus.vi.vblank();
    cpu.step(); // executes delay slot; sets up branchCommitPending; interrupt will be taken on the next boundary before branch commit

    // Next step: take the interrupt with BD set and both IP2/IP7 latched
    cpu.step();

    const cause = cpu.cop0.read(13) >>> 0;
    const epc = cpu.cop0.read(14) >>> 0;
    expect((cause >>> 31) !== 0).toBe(true); // BD
    expect(((cause >>> 10) & 1)).toBe(1); // IP2
    expect(((cause >>> 15) & 1)).toBe(1); // IP7
    expect(epc >>> 0).toBe(0 >>> 0);

    // Cleanup ack VI and clear EXL; IP7 remains until Compare write or next event re-arm
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cpu.cop0.write(12, cpu.cop0.read(12) & ~(1 << 1));
  });

  it('writing Compare clears only IP7; MI pending (VI) remains until device ack', () => {
    const bus = new Bus(new RDRAM(4096));
    const cpu = new CPU(bus);

    // IE+IM2+IM7 and MI mask for VI
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7);
    cpu.cop0.write(12, IE | IM2 | IM7);
    bus.storeU32(MI_BASE + MI_INTR_MASK_OFF, 1 << 3);

    // Arrange: make IP7 pending by Count==Compare; also raise VI pending
    cpu.cop0.write(9, 0);
    cpu.cop0.write(11, 1);
    bus.vi.vblank();

    // Step once to advance Count to 1 so IP7 sets
    cpu.step();

    let cause = cpu.cop0.read(13) >>> 0;
    expect(((cause >>> 15) & 1)).toBe(1); // IP7
    expect(((cause >>> 10) & 1)).toBe(1); // IP2

    // Write Compare to clear IP7; verify IP2 still set
    cpu.cop0.write(11, 100);
    cause = cpu.cop0.read(13) >>> 0;
    expect(((cause >>> 15) & 1)).toBe(0); // IP7 cleared
    expect(((cause >>> 10) & 1)).toBe(1); // IP2 remains

    // Ack VI then IP2 clears
    bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
    cause = cpu.cop0.read(13) >>> 0;
    // IP2 line reflects MI.cpuIntAsserted() in CPU boundary, but Cause.IP2 will update next interrupts check.
    // Step once to update Cause from MI line state
    const pc0 = cpu.pc >>> 0;
    cpu.step();
    cause = cpu.cop0.read(13) >>> 0;
    expect(((cause >>> 10) & 1)).toBe(0);
    // No exception should have been taken here (we did not require EXL to clear/interrupt)
    expect(cpu.pc >>> 0).toBe(((pc0 + 4) >>> 0));
  });
});


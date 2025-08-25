import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { System } from './system.js';
import { MI_BASE, MI_INTR_OFF, DP_BASE, DP_STATUS_OFF, DP_STATUS_INTR, VI_BASE, VI_STATUS_OFF, VI_STATUS_VINT, SP_BASE, SP_STATUS_OFF, SP_STATUS_INTR, SI_BASE, SI_STATUS_OFF, SI_STATUS_DMA_BUSY, AI_BASE, AI_STATUS_OFF, AI_STATUS_DMA_BUSY } from '../devices/mmio.js';

export type FrameLoopResult = {
  steps: number;
  dpAcks: number;
  viAcks: number;
  spAcks: number;
  aiAcks: number;
  siAcks: number;
  timerAcks: number;
};

// Runs a simple frame loop for `totalCycles` cycles.
// Any time an interrupt is taken at the exception vector, this routine:
// - Reads MI pending
// - Acks DP via DP_STATUS write if pending
// - Acks VI via VI_STATUS write if pending
// - If CP0 timer (IP7) is pending, re-arms it by writing Compare beyond current Count
// - Clears EXL and restores the saved PC so the loop can continue deterministically
export function runFrameLoop(cpu: CPU, bus: Bus, sys: System, totalCycles: number): FrameLoopResult {
  let dpAcks = 0, viAcks = 0, spAcks = 0, aiAcks = 0, siAcks = 0, timerAcks = 0;
  let steps = 0;
  for (let i = 0; i < totalCycles; i++) {
    const savedPC = cpu.pc >>> 0;
    sys.stepCycles(1);
    steps++;
    const status = cpu.cop0.read(12);
    if ((status & (1 << 1)) !== 0 && (cpu.pc >>> 0) === (0x80000180 >>> 0)) {
      // Inspect MI pending
      const miPending = bus.loadU32(MI_BASE + MI_INTR_OFF) >>> 0;
      if ((miPending & (1 << 5)) !== 0) { // DP
        bus.storeU32(DP_BASE + DP_STATUS_OFF, DP_STATUS_INTR);
        dpAcks++;
      }
      if ((miPending & (1 << 3)) !== 0) { // VI
        bus.storeU32(VI_BASE + VI_STATUS_OFF, VI_STATUS_VINT);
        viAcks++;
      }
      if ((miPending & (1 << 0)) !== 0) { // SP
        bus.storeU32(SP_BASE + SP_STATUS_OFF, SP_STATUS_INTR);
        spAcks++;
      }
      if ((miPending & (1 << 2)) !== 0) { // AI
        bus.storeU32(AI_BASE + AI_STATUS_OFF, AI_STATUS_DMA_BUSY);
        aiAcks++;
      }
      if ((miPending & (1 << 1)) !== 0) { // SI
        bus.storeU32(SI_BASE + SI_STATUS_OFF, SI_STATUS_DMA_BUSY);
        siAcks++;
      }
      // If CP0 timer IP7 is pending in Cause, re-arm Compare so we don't retrigger immediately
      const cause = cpu.cop0.read(13) >>> 0;
      if (((cause >>> 15) & 1) !== 0) {
        timerAcks++;
        const count = cpu.cop0.read(9) >>> 0;
        // Move Compare comfortably ahead to avoid immediate re-trigger during this loop
        cpu.cop0.write(11, (count + 0x100) >>> 0);
      }
      // Clear EXL and restore PC
      cpu.cop0.write(12, status & ~(1 << 1));
      cpu.pc = savedPC >>> 0;
    }
  }
  return { steps, dpAcks, viAcks, spAcks, aiAcks, siAcks, timerAcks };
}


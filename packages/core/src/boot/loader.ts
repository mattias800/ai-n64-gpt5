import { Bus } from '../mem/bus.js';
import { PI_BASE, PI_DRAM_ADDR_OFF, PI_CART_ADDR_OFF, PI_RD_LEN_OFF, PI_STATUS_OFF, PI_STATUS_DMA_BUSY } from '../devices/mmio.js';

export type SegmentCopy = {
  cartAddr: number; // ROM source address
  dramAddr: number; // RDRAM destination address
  length: number;   // number of bytes to copy
};

// Perform a sequence of PI DMA copies from ROM to RDRAM.
// For each segment, this routine:
// - programs PI DRAM and CART addresses
// - starts DMA by writing RD_LEN (length-1 semantics)
// - completes the DMA (clears busy and raises MI PI pending)
// - optionally acknowledges PI pending by writing STATUS busy bit (ackMI = true)
// This provides a deterministic, testable loader used by HLE flows.
export function hlePiLoadSegments(bus: Bus, segments: SegmentCopy[], ackMI = true): void {
  for (const seg of segments) {
    const len = seg.length >>> 0;
    const rdLen = (len - 1) >>> 0; // PI uses length-1 semantics
    bus.storeU32(PI_BASE + PI_DRAM_ADDR_OFF, seg.dramAddr >>> 0);
    bus.storeU32(PI_BASE + PI_CART_ADDR_OFF, seg.cartAddr >>> 0);
    bus.storeU32(PI_BASE + PI_RD_LEN_OFF, rdLen);
    // Complete DMA now (clears busy and raises MI PI pending)
    bus.pi.completeDMA();
    // Optionally ack MI PI pending via STATUS busy bit write
    if (ackMI) {
      bus.storeU32(PI_BASE + PI_STATUS_OFF, PI_STATUS_DMA_BUSY);
    }
  }
}


import { Bus, RDRAM, CPU, System, hlePifBoot, viScanout, normalizeRomToBigEndian, parseHeader, translateF3DEXAndExecNow } from '@n64/core';
import { crc32Hex } from './crc32.js';

export interface RomBootOptions { cycles?: number; viInterval?: number; vectorAutoReturn?: boolean; fastboot?: boolean; skipAt?: number[]; jumpHeader?: boolean; viInit?: boolean }

export const runRomBootFrames = async (romBytes: Uint8Array, opts?: RomBootOptions): Promise<{ frameImages: ImageData[]; crc32Hex: string[] }> => {
  const cycles = Math.max(1, Math.floor(opts?.cycles ?? 10_000_000));
  const viInterval = Math.max(1000, Math.floor(opts?.viInterval ?? 10_000));

  const rdram = new RDRAM(8 * 1024 * 1024);
  const bus = new Bus(rdram);
  const cpu = new CPU(bus);
  const sys = new System(cpu, bus);
  bus.setROM(romBytes);

  // HLE PIF boot (sets entry PC and basic state)
  hlePifBoot(cpu, bus, romBytes);

  // Optionally jump to header initial PC
  if (opts?.jumpHeader) {
    try {
      const { data: beRom } = normalizeRomToBigEndian(new Uint8Array(romBytes));
      const headerInitialPC = parseHeader(beRom).initialPC >>> 0;
      cpu.pc = headerInitialPC >>> 0;
    } catch {}
  }

  // Optional VI init fallback
  if (opts?.viInit) {
    try {
      (bus.vi as any).writeU32(0x14, 0xF000 >>> 0); // ORIGIN
      (bus.vi as any).writeU32(0x18, 320 >>> 0);    // WIDTH
    } catch {}
  }

  // Minimal fastboot aids: enable IE|IM2|IM7|CU1 and MI mask for SP/SI/VI/PI/DP
  try {
    const IE = 1 << 0; const IM2 = 1 << (8 + 2); const IM7 = 1 << (8 + 7); const CU1 = 1 << 29;
    cpu.cop0.write(12, (IE | IM2 | IM7 | CU1) >>> 0);
    const MI_INTR_MASK_OFF = 0x0c >>> 0;
    const mask = ((1<<0)|(1<<1)|(1<<3)|(1<<4)|(1<<5)) >>> 0;
    (bus.mi as any).writeU32(MI_INTR_MASK_OFF, mask);
    // Install minimal ERET at general exception vector (phys 0x00000180)
    bus.storeU32(0x00000180 >>> 0, 0x42000018 >>> 0); // ERET
    bus.storeU32(0x00000184 >>> 0, 0x00000000 >>> 0);
  } catch {}

  // Vector auto-return and fastboot toggles + targeted skip
  try {
    (cpu as any).vectorAutoReturn = (opts?.vectorAutoReturn !== undefined) ? !!opts.vectorAutoReturn : true;
    if (opts?.fastboot) (cpu as any).fastbootSkipReserved = true;
    if (Array.isArray(opts?.skipAt)) {
      for (const pc of opts!.skipAt!) {
        if (Number.isFinite(pc)) (cpu as any).addReservedSkipPC?.((pc as number) >>> 0);
      }
    }
  } catch {}

  // Basic controller handshake once to satisfy early input code
  try {
    const { hlePifControllerStatus, hlePifReadControllerState } = await import('@n64/core');
    const ctrlBase = 0x2000 >>> 0;
    hlePifControllerStatus(bus as any, ctrlBase);
    hlePifReadControllerState(bus as any, (ctrlBase + 0x40) >>> 0);
  } catch {}

  // Periodic CP0 Compare updates to keep timer flow
  try {
    const period = 50_000 >>> 0;
    const cnt0 = (cpu.cop0.read(9) >>> 0);
    cpu.cop0.write(11, (cnt0 + period) >>> 0);
    const repeats = Math.max(1, Math.floor(cycles / Math.max(1, period)));
    sys.scheduleEvery(period >>> 0, period >>> 0, repeats, () => {
      const cNow = cpu.cop0.read(9) >>> 0;
      cpu.cop0.write(11, (cNow + period) >>> 0);
    });
  } catch {}

  // Schedule periodic VI vblank and collect snapshots when possible
  const frames: ImageData[] = [];
  const width = 320, height = 240;
  let viOrigin = (bus.vi as any).origin >>> 0;
  let viWidth = (bus.vi as any).width >>> 0;

  // Attach SP bridge to render frames when a gfx task starts (game-driven content)
  try {
    const be32 = (arr: Uint8Array, off: number) => (((arr[off]! << 24) | (arr[off+1]! << 16) | (arr[off+2]! << 8) | (arr[off+3]!)) >>> 0);
    let bridgeCount = 0;
    (bus.sp as any).onStart = () => {
      try {
        const dmem = (bus.sp as any).dmem as Uint8Array;
        const type = be32(dmem, 0x00) >>> 0; // task type
        const data_ptr = be32(dmem, 0x30) >>> 0; // OSTask.data_ptr
        // Only handle gfx tasks (type == 1); allow any if the title uses variant
        if (type !== 1 && type !== 0x00000001) return;
        if (!data_ptr) return;
        // Ensure VI has a framebuffer
        let originNow = (bus.vi as any).origin >>> 0;
        let widthNow = (bus.vi as any).width >>> 0;
        if (originNow === 0 || widthNow === 0) {
          (bus.vi as any).writeU32(0x14, 0xF000 >>> 0);
          (bus.vi as any).writeU32(0x18, 320 >>> 0);
          originNow = 0xF000 >>> 0; widthNow = 320 >>> 0;
        }
        const fbBytes = (width * height * 2) >>> 0;
        const defaultBase = ((originNow + fbBytes + 0x30000) >>> 0);
        const strideWords = 0x400 >>> 2;
        const stagingBase = (defaultBase + ((bridgeCount & 0xff) * Math.max(0x2000, (strideWords*4)>>>0))) >>> 0;
        translateF3DEXAndExecNow(bus as any, width >>> 0, height >>> 0, data_ptr >>> 0, stagingBase >>> 0, strideWords >>> 0);
        const img = viScanout(bus as any, width, height);
        frames.push(new ImageData(new Uint8ClampedArray(img), width, height));
        bridgeCount++;
      } catch {}
    };
  } catch {}

  sys.scheduleEvery(viInterval >>> 0, viInterval >>> 0, Math.max(1, Math.floor(cycles / Math.max(1, viInterval))), () => {
    (bus.vi as any).vblank();
    // If VI is not set up yet, skip snapshot
    viOrigin = (bus.vi as any).origin >>> 0;
    viWidth = (bus.vi as any).width >>> 0;
    if (viOrigin && viWidth) {
      const img = viScanout(bus as any, width, height);
      frames.push(new ImageData(new Uint8ClampedArray(img), width, height));
    }
  });

  // Helper: run cycles and collect any frames produced so far
  const runAndCollect = (n: number) => { try { sys.stepCycles(Math.max(1, n|0) >>> 0); } catch {} };

  // First attempt
  runAndCollect(cycles);

  // If no frames yet, try a large pre-stage of ROM into KSEG0 at header PC phys (discover-style)
  if (frames.length === 0) {
    try {
      const { data: beRom } = normalizeRomToBigEndian(new Uint8Array(romBytes));
      const headerInitialPC = parseHeader(beRom).initialPC >>> 0;
      const basePhys = (headerInitialPC - 0x80000000) >>> 0;
      const romU8 = new Uint8Array(romBytes);
      const maxLen = Math.min(romU8.length >>> 0, 2 * 1024 * 1024);
      for (let i = 0; i < maxLen; i++) {
        const v = romU8[i] ?? 0;
        (bus.rdram.bytes as Uint8Array)[(basePhys + i) >>> 0] = v;
      }
      // Run again
      runAndCollect(cycles);
    } catch {}
  }

  const crcs = frames.map((im) => crc32Hex(new Uint8Array(im.data)));
  return { frameImages: frames, crc32Hex: crcs };
};

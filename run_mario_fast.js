#!/usr/bin/env node

// Fast SM64 boot with pre-cleared memory
const { CPU, Bus, System, RDRAM } = require('./packages/core/dist/index.js');
const { hlePifBoot, hlePiLoadSegments } = require('./packages/core/dist/index.js');
const fs = require('fs');

console.log('Loading Super Mario 64 ROM...');
const rom = fs.readFileSync('./mario64.z64');

// Create system
const rdram = new RDRAM(8 * 1024 * 1024);
const bus = new Bus(rdram);
const cpu = new CPU(bus);
const sys = new System(cpu, bus);

// Set up devices
bus.setROM(rom);

// HLE boot
console.log('Performing HLE boot...');
hlePifBoot(cpu, bus, rom);

// Load initial ROM segment (IPL-HLE)
const headerPC = 0x80246000;
const basePhys = headerPC - 0x80000000;
console.log(`Loading ROM segment at 0x${basePhys.toString(16)}...`);
hlePiLoadSegments(bus, [{ 
  cartAddr: 0x1000, 
  dramAddr: basePhys, 
  length: 6 * 1024 * 1024 
}], true);

// Pre-clear the memory region that SM64 clears on boot
// This skips the long initialization loop
console.log('Pre-clearing memory to skip initialization...');
const clearStart = 0x34a580; // Physical address
const clearSize = 0x2cee0; // 188KB
for (let i = 0; i < clearSize; i += 4) {
  bus.storeU32(clearStart + i, 0);
}

// Jump to entry point
cpu.pc = headerPC;

// Set up CPU features
cpu.fastbootSkipReserved = true;
cpu.addReservedSkipPC(0x8005c800);

// Enable CP0 Status bits for FPU
cpu.cop0.write(12, 0x34000000);

// Initialize VI
bus.vi.writeU32(0x14, 0xF000); // VI_ORIGIN
bus.vi.writeU32(0x18, 320);    // VI_WIDTH

// Run for a while
console.log('Running CPU...');
let cycles = 0;
const maxCycles = 1000000000; // 1 billion cycles
const checkInterval = 10000000; // Check every 10M cycles

try {
  while (cycles < maxCycles) {
    // Run a batch of cycles
    sys.stepCycles(checkInterval);
    cycles += checkInterval;
    
    // Check for PI DMA activity
    const piStatus = bus.pi.readU32(0x10);
    if (piStatus & 0x01) {
      console.log(`PI DMA active at ${cycles} cycles`);
    }
    
    // Check for SP activity
    const spStatus = bus.sp.readU32(0x10);
    if (spStatus & 0x01) {
      console.log(`SP active at ${cycles} cycles`);
    }
    
    // Progress indicator every 100M cycles
    if (cycles % 100000000 === 0) {
      console.log(`${cycles / 1000000}M cycles completed, PC=0x${cpu.pc.toString(16)}`);
    }
  }
} catch (e) {
  console.log(`Error at ${cycles} cycles: ${e.message}`);
  console.log(`PC=0x${cpu.pc.toString(16)}`);
}

console.log(`\nCompleted ${cycles} cycles`);
console.log(`Final PC: 0x${cpu.pc.toString(16)}`);

// Check VI for framebuffer
const viOrigin = bus.vi.readU32(0x14);
const viWidth = bus.vi.readU32(0x18);
console.log(`VI Origin: 0x${viOrigin.toString(16)}, Width: ${viWidth}`);

// Save memory dump for analysis
const dumpSize = 0x100;
const dumpStart = cpu.pc - 0x80000000;
console.log(`\nMemory at PC (0x${cpu.pc.toString(16)}):`);
for (let i = 0; i < dumpSize && i < 32; i += 4) {
  const val = bus.loadU32(dumpStart + i);
  console.log(`  +${i.toString(16).padStart(2, '0')}: 0x${val.toString(16).padStart(8, '0')}`);
}

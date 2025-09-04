#!/usr/bin/env node

const { CPU, Bus, System, RDRAM } = require('./packages/core/dist/index.js');
const { hlePifBoot, hlePiLoadSegments } = require('./packages/core/dist/index.js');
const fs = require('fs');

console.log('Debugging SM64 memory clear loop...\n');

const rom = fs.readFileSync('./mario64.z64');
const rdram = new RDRAM(8 * 1024 * 1024);
const bus = new Bus(rdram);
const cpu = new CPU(bus);
const sys = new System(cpu, bus);

bus.setROM(rom);
hlePifBoot(cpu, bus, rom);

// Load ROM
const headerPC = 0x80246000;
const basePhys = headerPC - 0x80000000;
hlePiLoadSegments(bus, [{ 
  cartAddr: 0x1000, 
  dramAddr: basePhys, 
  length: 6 * 1024 * 1024 
}], true);

// Jump to entry
cpu.pc = headerPC;
cpu.fastbootSkipReserved = true;
cpu.addReservedSkipPC(0x8005c800);
cpu.cop0.write(12, 0x34000000);

// Initialize VI
bus.vi.writeU32(0x14, 0xF000);
bus.vi.writeU32(0x18, 320);

// Track loop
let loopCount = 0;
let lastT0 = 0;
let lastT1 = 0;
let samples = [];

// Run and monitor
for (let i = 0; i < 10000000; i++) {
  const pc = cpu.pc;
  
  // Check if we're in the loop
  if (pc === 0x80246010) {
    loopCount++;
    
    // Read registers (t0=$8, t1=$9)
    const t0 = cpu.regs[8];
    const t1 = cpu.regs[9];
    
    // Sample every 1000 iterations
    if (loopCount % 1000 === 0) {
      samples.push({
        iter: loopCount,
        t0: '0x' + t0.toString(16),
        t1: '0x' + t1.toString(16),
        t0_delta: t0 - lastT0,
        t1_delta: t1 - lastT1
      });
      lastT0 = t0;
      lastT1 = t1;
    }
    
    // Check if loop should be done
    if (t1 === 0 || t1 < 0) {
      console.log(`Loop should exit! t1=${t1.toString(16)}`);
      break;
    }
  }
  
  // Check if we've exited the loop
  if (pc === 0x80246024) {
    console.log(`Loop completed after ${loopCount} iterations!`);
    break;
  }
  
  cpu.step();
  
  if (i % 1000000 === 0) {
    console.log(`${i/1000000}M cycles, loop iterations: ${loopCount}`);
  }
}

console.log('\nLoop analysis:');
console.log(`Total iterations seen: ${loopCount}`);
console.log(`Expected iterations: ~23000 (0x2cee0 / 8)`);

console.log('\nRegister samples:');
console.table(samples.slice(0, 5));

if (samples.length > 5) {
  console.log('...');
  console.table(samples.slice(-5));
}

// Check actual memory to see if it's being cleared
const clearStart = 0x34a580;
const sample = [];
for (let i = 0; i < 32; i += 4) {
  sample.push(bus.loadU32(clearStart + i).toString(16));
}
console.log('\nMemory at 0x8034a580 (first 32 bytes):');
console.log(sample.join(' '));

console.log(`\nFinal PC: 0x${cpu.pc.toString(16)}`);

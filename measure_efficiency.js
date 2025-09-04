#!/usr/bin/env node

const { CPU, Bus, System, RDRAM } = require('./packages/core/dist/index.js');
const { hlePifBoot, hlePiLoadSegments } = require('./packages/core/dist/index.js');
const fs = require('fs');

console.log('Measuring emulator efficiency...\n');

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

cpu.pc = headerPC;
cpu.fastbootSkipReserved = true;
cpu.addReservedSkipPC(0x8005c800);
cpu.cop0.write(12, 0x34000000);

// Count instructions
let instructionCount = 0;
let uniquePCs = new Set();
let loopIterations = 0;
let lastPC = 0;

// Hook into CPU to count actual instructions executed
const originalStep = cpu.step.bind(cpu);
cpu.step = function() {
  const pc = this.pc;
  uniquePCs.add(pc);
  instructionCount++;
  
  // Count loop iterations
  if (pc === 0x80246010) {
    loopIterations++;
  }
  
  // Check if we've exited the memory clear loop
  if (pc === 0x80246024 && lastPC === 0x80246020) {
    console.log(`Memory clear loop completed!`);
    console.log(`  Loop iterations: ${loopIterations}`);
    console.log(`  Instructions so far: ${instructionCount}`);
    console.log(`  Cycles consumed: ${sys.cycle}`);
    console.log(`  Efficiency: ${instructionCount / sys.cycle} instructions/cycle`);
  }
  
  lastPC = pc;
  return originalStep.call(this);
};

// Run for a fixed number of cycles
const TARGET_CYCLES = 1000000;
console.log(`Running for ${TARGET_CYCLES} cycles...\n`);

try {
  sys.stepCycles(TARGET_CYCLES);
} catch (e) {
  console.log(`Error: ${e.message}`);
}

console.log('\n=== RESULTS ===');
console.log(`Total cycles: ${sys.cycle}`);
console.log(`Total instructions executed: ${instructionCount}`);
console.log(`Unique PCs visited: ${uniquePCs.size}`);
console.log(`Loop iterations: ${loopIterations}`);
console.log(`\nEfficiency: ${(instructionCount / sys.cycle).toFixed(4)} instructions per cycle`);
console.log(`Overhead: ${(sys.cycle / instructionCount).toFixed(1)}x`);

// Check where we ended up
console.log(`\nFinal PC: 0x${cpu.pc.toString(16)}`);

// Calculate how long the memory clear would take
const LOOP_INSTRUCTIONS = 5; // 5 instructions per loop iteration
const EXPECTED_ITERATIONS = 23004; // 0x2cee0 / 8
const EXPECTED_INSTRUCTIONS = EXPECTED_ITERATIONS * LOOP_INSTRUCTIONS;
const CYCLES_AT_THIS_RATE = Math.floor(EXPECTED_INSTRUCTIONS / (instructionCount / sys.cycle));

console.log('\n=== MEMORY CLEAR PROJECTION ===');
console.log(`Expected iterations: ${EXPECTED_ITERATIONS}`);
console.log(`Expected instructions: ${EXPECTED_INSTRUCTIONS}`);
console.log(`At current efficiency: ${CYCLES_AT_THIS_RATE.toLocaleString()} cycles needed`);
console.log(`That's ${(CYCLES_AT_THIS_RATE / 93750000).toFixed(2)} N64 seconds!`);

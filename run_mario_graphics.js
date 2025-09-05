#!/usr/bin/env node

const { CPU, Bus, System, RDRAM } = require('./packages/core/dist/index.js');
const { hlePifBoot, hlePiLoadSegments } = require('./packages/core/dist/index.js');
const { bridgeRspSync } = require('./packages/bridge-f3dex/dist/index.js');
const fs = require('fs');

console.log('🎮 Super Mario 64 - Full Graphics Pipeline');
console.log('==========================================\n');

// Load ROM
const rom = fs.readFileSync('./mario64.z64');
const rdram = new RDRAM(8 * 1024 * 1024);
const bus = new Bus(rdram);
const cpu = new CPU(bus);
const sys = new System(cpu, bus);

// Initialize
bus.setROM(rom);
hlePifBoot(cpu, bus, rom);

// Load game code
const headerPC = 0x80246000;
const basePhys = headerPC - 0x80000000;
hlePiLoadSegments(bus, [{ 
  cartAddr: 0x1000, 
  dramAddr: basePhys, 
  length: 6 * 1024 * 1024 
}], true);

// Configure CPU
cpu.pc = headerPC;
cpu.fastbootSkipReserved = true;
cpu.addReservedSkipPC(0x8005c800);
cpu.cop0.write(12, 0x34000000); // Enable interrupts with FPU

// Initialize VI with proper settings
bus.vi.writeU32(0x00, 0x00003140); // VI_CONTROL
bus.vi.writeU32(0x08, 320);        // VI_WIDTH  
bus.vi.writeU32(0x0C, 0x00000002); // VI_INTR (interrupt on line 2)
bus.vi.writeU32(0x10, 0x00000000); // VI_CURRENT
bus.vi.writeU32(0x14, 0x03E52239); // VI_BURST
bus.vi.writeU32(0x18, 0x0000020D); // VI_V_SYNC
bus.vi.writeU32(0x1C, 0x00000C15); // VI_H_SYNC
bus.vi.writeU32(0x20, 0x0C150C15); // VI_LEAP
bus.vi.writeU32(0x24, 0x006C02EC); // VI_H_START
bus.vi.writeU32(0x28, 0x00000200); // VI_V_START
bus.vi.writeU32(0x2C, 0x00000400); // VI_V_BURST
bus.vi.writeU32(0x30, 0x005F0239); // VI_X_SCALE
bus.vi.writeU32(0x34, 0x00000400); // VI_Y_SCALE

console.log('Configuration:');
console.log('  - CPU fastboot with reserved skip at 0x8005c800');
console.log('  - VI configured for 320x240 output');
console.log('  - RSP bridge enabled for F3DEX graphics\n');

let frameCount = 0;
let rspTaskCount = 0;
let lastViOrigin = 0;
let startTime = Date.now();

// Track RSP tasks
const origSpWrite = bus.sp.writeU32.bind(bus.sp);
bus.sp.writeU32 = function(offset, value) {
  if (offset === 0x10 && (value & 1)) { // SP_STATUS write starting task
    rspTaskCount++;
    const taskAddr = bus.sp.readU32(0x00); // SP_MEM_ADDR_REG
    console.log(`  [RSP Task ${rspTaskCount}] Starting at 0x${taskAddr.toString(16)}`);
    
    // Try to process graphics task with bridge
    try {
      const result = bridgeRspSync(bus, true);
      if (result && result.framebuffer) {
        console.log(`    -> Graphics task processed!`);
      }
    } catch (e) {
      // RSP task failed, that's ok during boot
    }
  }
  return origSpWrite(offset, value);
};

// Monitor VI for actual frame output
function checkForFrames() {
  const origin = bus.vi.readU32(0x04);
  if (origin !== lastViOrigin && origin !== 0) {
    frameCount++;
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`  [Frame ${frameCount}] VI Origin: 0x${origin.toString(16)} at ${elapsed.toFixed(1)}s`);
    lastViOrigin = origin;
    
    // Save snapshot every 10 frames
    if (frameCount % 10 === 0) {
      saveSnapshot(frameCount);
    }
    
    // Stop after seeing substantial frames (title screen is around frame 60-120)
    if (frameCount >= 120) {
      return true;
    }
  }
  return false;
}

function saveSnapshot(frameNum) {
  const width = bus.vi.readU32(0x08) || 320;
  const origin = bus.vi.readU32(0x04) & 0x00ffffff;
  
  if (origin > 0 && origin < rdram.bytes.length - (320 * 240 * 2)) {
    const fbSize = 320 * 240 * 2;
    const framebuffer = Buffer.from(rdram.bytes.slice(origin, origin + fbSize));
    const outputPath = `frame_${frameNum}.bin`;
    fs.writeFileSync(outputPath, framebuffer);
    console.log(`    Saved frame ${frameNum} to ${outputPath}`);
  }
}

// Main emulation loop
console.log('Starting emulation...\n');
const checkInterval = 1000000; // Check every 1M cycles for more responsiveness
const maxCycles = 10000000000; // 10 billion cycles max (about 2 minutes on real N64)

for (let cycles = 0; cycles < maxCycles; cycles += checkInterval) {
  sys.stepCycles(checkInterval);
  
  // Progress update every 50M cycles
  if (cycles % 50000000 === 0 && cycles > 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = cycles / elapsed / 1000000;
    console.log(`  Progress: ${(cycles/1000000)}M cycles, ${elapsed.toFixed(0)}s elapsed (${rate.toFixed(1)}M cycles/sec)`);
  }
  
  // Check for rendered frames
  if (checkForFrames()) {
    console.log('\n🎯 Reached title screen!');
    break;
  }
  
  // Emergency exit after 5 minutes
  if ((Date.now() - startTime) > 300000) {
    console.log('\nTimeout after 5 minutes');
    break;
  }
}

const totalElapsed = (Date.now() - startTime) / 1000;
console.log('\n✅ Emulation complete!');
console.log(`  Total time: ${totalElapsed.toFixed(1)} seconds`);
console.log(`  Frames rendered: ${frameCount}`);
console.log(`  RSP tasks: ${rspTaskCount}`);
console.log(`  Final PC: 0x${cpu.pc.toString(16)}`);

// Save final frame
if (frameCount > 0) {
  saveSnapshot(frameCount);
  console.log('\nTo convert frames to PNG:');
  console.log('  ffmpeg -f rawvideo -pixel_format rgb565be -video_size 320x240 -i frame_*.bin frame_%d.png');
}

console.log('\n🎮 Done!');

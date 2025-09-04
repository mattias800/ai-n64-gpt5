#!/usr/bin/env node

const { CPU, Bus, System, RDRAM } = require('./packages/core/dist/index.js');
const { hlePifBoot, hlePiLoadSegments } = require('./packages/core/dist/index.js');
const fs = require('fs');
const path = require('path');

console.log('🎮 Super Mario 64 Title Screen Runner');
console.log('=====================================\n');

// Load ROM
const rom = fs.readFileSync('./mario64.z64');
const rdram = new RDRAM(8 * 1024 * 1024);
const bus = new Bus(rdram);
const cpu = new CPU(bus);
const sys = new System(cpu, bus);

// Initialize
bus.setROM(rom);
hlePifBoot(cpu, bus, rom);

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
cpu.cop0.write(12, 0x34000000); // Enable interrupts with FPU

// Setup VI for frame detection
bus.vi.writeU32(0x00, 0x00003140); // VI_CONTROL - enable output
bus.vi.writeU32(0x04, 0x00000000); // VI_ORIGIN
bus.vi.writeU32(0x08, 320);        // VI_WIDTH
bus.vi.writeU32(0x24, 0x00000200); // VI_V_SYNC
bus.vi.writeU32(0x30, 0x00000000); // VI_V_CURRENT

console.log('Starting emulation...');
console.log('Target: ~1 billion cycles (about 10-11 seconds on real N64)');
console.log('Expected time on this machine: ~2-3 minutes\n');

let lastProgress = 0;
let frameCount = 0;
let lastOrigin = 0;
let startTime = Date.now();
let checkInterval = 5000000; // Check every 5M cycles
let totalCycles = 1000000000; // 1 billion cycles should be enough

// Monitor for actual frame changes
function checkFrame() {
  const origin = bus.vi.readU32(0x04); // VI_ORIGIN
  if (origin !== lastOrigin && origin !== 0) {
    frameCount++;
    lastOrigin = origin;
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`  [Frame ${frameCount}] VI Origin: 0x${origin.toString(16)} at ${elapsed.toFixed(1)}s`);
    
    // Check if we're likely at the title screen (usually frame 60-120)
    if (frameCount > 60) {
      console.log('\n🎯 Likely reached title screen area!');
      return true;
    }
  }
  return false;
}

// Main emulation loop with progress updates
console.log('Progress:');
for (let cycles = 0; cycles < totalCycles; cycles += checkInterval) {
  sys.stepCycles(checkInterval);
  
  // Progress bar
  const progress = Math.floor((cycles / totalCycles) * 100);
  if (progress > lastProgress && progress % 5 === 0) {
    lastProgress = progress;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = cycles / elapsed;
    const eta = (totalCycles - cycles) / rate;
    console.log(`  ${progress}% - ${(cycles/1000000).toFixed(0)}M cycles - ${elapsed.toFixed(0)}s elapsed - ETA: ${eta.toFixed(0)}s`);
  }
  
  // Check for frame changes
  if (checkFrame()) {
    console.log(`\nReached potential title screen after ${cycles} cycles`);
    break;
  }
}

const totalElapsed = (Date.now() - startTime) / 1000;
console.log(`\n✅ Emulation complete!`);
console.log(`  Total time: ${totalElapsed.toFixed(1)} seconds`);
console.log(`  Frames rendered: ${frameCount}`);
console.log(`  Final PC: 0x${cpu.pc.toString(16)}`);

// Now capture a snapshot if we have frames
if (frameCount > 0) {
  console.log('\nCapturing framebuffer...');
  const width = bus.vi.readU32(0x08) || 320;
  const origin = bus.vi.readU32(0x04) & 0x00ffffff;
  
  if (origin > 0 && origin < rdram.bytes.length - (width * 240 * 2)) {
    // Save raw framebuffer for inspection
    const fbSize = width * 240 * 2; // 16-bit color
    const framebuffer = Buffer.from(rdram.bytes.slice(origin, origin + fbSize));
    const outputPath = 'title_screen_raw.bin';
    fs.writeFileSync(outputPath, framebuffer);
    console.log(`  Saved raw framebuffer to ${outputPath} (${fbSize} bytes)`);
    console.log(`  Convert with: ffmpeg -f rawvideo -pixel_format rgb565be -video_size ${width}x240 -i ${outputPath} title.png`);
  }
}

console.log('\n🎮 Done! If Mario\'s head appeared, the framebuffer has been saved.');

#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Bus, RDRAM } = require('./packages/core/dist/mem/bus.js');
const { CPU } = require('./packages/core/dist/cpu/cpu.js');
const { System } = require('./packages/core/dist/system/system.js');
const { hleBoot } = require('./packages/core/dist/boot/hle_boot.js');
const { hlePiLoadSegments } = require('./packages/core/dist/boot/hle_pi_loader.js');
const { writePNG } = require('./packages/headless/dist/image.js');

// Load ROM
const romPath = path.resolve('./mario64.z64');
console.log('Loading ROM from:', romPath);
const romBytes = fs.readFileSync(romPath);
console.log('ROM size:', romBytes.length, 'bytes');

// Create system
const rdram = new RDRAM(8 * 1024 * 1024); // 8MB
const bus = new Bus(rdram);
const cpu = new CPU(bus, { identityMapKuseg: true, countDivisor: 1 });
const system = new System(cpu);

// Set ROM
bus.setROM(romBytes);

// Boot the system
console.log('Booting system...');
hleBoot(bus, cpu, romBytes, {
  enableFPU: true,
  skipReserved: true,
  vectorAutoReturn: true
});

// Load initial segments  
console.log('Loading game segments...');
const segmentInfo = hlePiLoadSegments(bus, cpu, system, romBytes, { 
  bridgeCodeAtBoot: true 
});

// Set up video interface
bus.vi.writeU32(0x00, 0x3202); // VI_CONTROL - enable display
bus.vi.writeU32(0x04, (320 << 2)); // VI_WIDTH 
bus.vi.writeU32(0x24, 0x100000); // VI_ORIGIN - framebuffer at 1MB

// Run for approximately 3 seconds (93.75M cycles at 31.25MHz)
const targetCycles = 93_750_000;
const startTime = Date.now();
let cycles = 0;
let lastFrameTime = Date.now();
let frameCount = 0;

console.log(`Running for ${targetCycles} cycles (approximately 3 seconds)...`);

while (cycles < targetCycles) {
  // Step CPU
  system.step();
  cycles++;
  
  // Check for frame completion every ~1.5M cycles (roughly 1/60th second)
  if (cycles % 1_562_500 === 0) {
    frameCount++;
    const now = Date.now();
    const fps = 1000 / (now - lastFrameTime);
    lastFrameTime = now;
    
    if (frameCount % 10 === 0) {
      const elapsed = (now - startTime) / 1000;
      const progress = (cycles / targetCycles * 100).toFixed(1);
      console.log(`Frame ${frameCount}: ${progress}% complete, ${elapsed.toFixed(1)}s elapsed, ${fps.toFixed(1)} fps`);
    }
  }
}

const totalTime = (Date.now() - startTime) / 1000;
console.log(`\nCompleted ${cycles} cycles in ${totalTime.toFixed(2)} seconds`);
console.log(`Rendered ${frameCount} frames`);

// Capture final framebuffer
const fbOrigin = bus.vi.readU32(0x24) & 0xffffff;
const fbWidth = (bus.vi.readU32(0x04) >>> 2) & 0xfff;
const fbHeight = 240; // Standard height

console.log(`\nCapturing framebuffer at 0x${fbOrigin.toString(16)}, ${fbWidth}x${fbHeight}`);

// Read framebuffer pixels (RGBA5551 format)
const pixels = new Uint16Array(fbWidth * fbHeight);
for (let y = 0; y < fbHeight; y++) {
  for (let x = 0; x < fbWidth; x++) {
    const addr = fbOrigin + (y * fbWidth + x) * 2;
    const lo = bus.loadU8Phys(addr);
    const hi = bus.loadU8Phys(addr + 1); 
    pixels[y * fbWidth + x] = (hi << 8) | lo;
  }
}

// Convert to RGBA8888
const rgba = new Uint8Array(fbWidth * fbHeight * 4);
for (let i = 0; i < pixels.length; i++) {
  const pixel = pixels[i];
  const r = ((pixel >>> 11) & 0x1f) * 255 / 31;
  const g = ((pixel >>> 6) & 0x1f) * 255 / 31;
  const b = ((pixel >>> 1) & 0x1f) * 255 / 31;
  const a = (pixel & 1) * 255;
  
  rgba[i * 4 + 0] = Math.round(r);
  rgba[i * 4 + 1] = Math.round(g);
  rgba[i * 4 + 2] = Math.round(b);
  rgba[i * 4 + 3] = a;
}

// Save PNG
const outputPath = 'tmp/sm64_3sec_screen.png';
writePNG(outputPath, rgba, fbWidth, fbHeight);
console.log(`\nScreenshot saved to: ${outputPath}`);

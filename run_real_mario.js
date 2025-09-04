#!/usr/bin/env node

console.log('🎮 Super Mario 64 - Real Title Screen Runner');
console.log('============================================');
console.log('This will take 2-5 minutes to reach the title screen.\n');

const { execSync } = require('child_process');
const fs = require('fs');

// Run parameters optimized for reaching title screen
const params = [
  'node packages/headless/dist/cli.js rom-boot-run ./mario64.z64',
  '--cycles 10000000000',  // 10 billion cycles (about 2 minutes on real N64)
  '--fastboot-hle',         // Speed up boot
  '--skip-reserved-at 0x8005c800', // Skip known problematic instruction
  '--vector-auto-return',   // Auto-return from exception vectors
  '--jump-header',          // Jump directly to game code
  '--vi-vblank',           // Enable vblank interrupts
  '--snapshot tmp/real_mario', // Save snapshots
  '--snapshot-interval 500000000', // Snapshot every 500M cycles
  '--discover',            // Discover display lists
  '--bridge',              // Enable graphics bridge
  '--bridge-any',          // Process any task type, not just graphics
  '--quiet'                // Reduce output noise
].join(' ');

console.log('Starting emulation with these settings:');
console.log('  - 10 billion cycles target (~2 min N64 time)');
console.log('  - Fastboot HLE for quicker initialization');
console.log('  - Graphics bridge for rendering');
console.log('  - Snapshots every 500M cycles\n');

console.log('Running... (this will take 2-5 minutes real time)');
console.log('Look for files: tmp/real_mario*.png\n');

// Start the process
const startTime = Date.now();
let checkInterval;

// Function to check for generated images
function checkForMario() {
  try {
    const files = fs.readdirSync('tmp').filter(f => f.startsWith('real_mario') && f.endsWith('.png'));
    if (files.length > 0) {
      const sizes = files.map(f => {
        const stats = fs.statSync(`tmp/${f}`);
        return { name: f, size: stats.size };
      });
      
      // Check if we have a large enough file (likely contains actual graphics)
      const largeFiles = sizes.filter(f => f.size > 5000); // 5KB+ likely has Mario
      if (largeFiles.length > 0) {
        console.log('\n🎯 Found potential Mario frames!');
        largeFiles.forEach(f => {
          console.log(`  ${f.name}: ${(f.size/1024).toFixed(1)}KB`);
        });
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// Monitor progress
checkInterval = setInterval(() => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  process.stdout.write(`\rElapsed: ${elapsed}s`);
  
  if (checkForMario()) {
    clearInterval(checkInterval);
    console.log('\n\n✨ Mario might be visible now!');
    console.log('Check the largest PNG files in tmp/');
    process.exit(0);
  }
  
  if (elapsed > 300) { // 5 minute timeout
    clearInterval(checkInterval);
    console.log('\n\nTimeout after 5 minutes.');
    console.log('Check tmp/ for any generated frames.');
    process.exit(0);
  }
}, 5000);

try {
  // Run the emulator
  execSync(params, { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 });
} catch (e) {
  // Process might be killed by timeout, that's ok
}

clearInterval(checkInterval);
const totalTime = Math.round((Date.now() - startTime) / 1000);
console.log(`\n\nCompleted in ${totalTime} seconds.`);
console.log('Check tmp/real_mario*.png for results.');

// List generated files
try {
  const files = fs.readdirSync('tmp').filter(f => f.startsWith('real_mario') && f.endsWith('.png'));
  if (files.length > 0) {
    console.log('\nGenerated frames:');
    files.forEach(f => {
      const stats = fs.statSync(`tmp/${f}`);
      console.log(`  ${f}: ${(stats.size/1024).toFixed(1)}KB`);
    });
    
    const largest = files.sort((a,b) => fs.statSync(`tmp/${b}`).size - fs.statSync(`tmp/${a}`).size)[0];
    console.log(`\nLargest frame (most likely to have Mario): tmp/${largest}`);
    console.log(`Open with: open tmp/${largest}`);
  }
} catch (e) {}

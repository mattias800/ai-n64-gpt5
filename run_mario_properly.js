#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🎮 Super Mario 64 - Full Title Screen Renderer');
console.log('==============================================');
console.log('This will run the actual game until Mario\'s head appears.\n');

const startTime = Date.now();
let frameCount = 0;
let lastFrameSize = 0;

// Clean up old frames
const tmpDir = path.join(__dirname, 'tmp');
try {
  const oldFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('mario_real_') && f.endsWith('.png'));
  oldFiles.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
} catch (e) {}

// Build command with optimal settings
const args = [
  'packages/headless/dist/cli.js',
  'rom-boot-run',
  './mario64.z64',
  '--cycles', '5000000000',           // 5 billion cycles (~53 seconds of N64 time)
  '--fastboot-hle',                    // Fast boot with HLE
  '--skip-reserved-at', '0x8005c800',  // Skip problematic instruction
  '--vector-auto-return',              // Auto-return from exception vectors
  '--jump-header',                      // Jump to game header
  '--vi-init',                         // Initialize VI
  '--vi-vblank',                       // Enable vblank interrupts
  '--vi-interval', '1562500',          // ~60 fps (93.75M / 60)
  '--bridge',                          // Enable graphics bridge
  '--bridge-any',                      // Process any SP task
  '--bridge-log',                      // Log bridge activity
  '--snapshot', 'tmp/mario_real',     // Output path
  '--snapshot-interval', '100000000',  // Snapshot every 100M cycles
  '--timing-profile', 'fast',          // Use fast timing
  '--width', '320',
  '--height', '240'
];

console.log('Configuration:');
console.log('  • Target: 5 billion cycles (~53 seconds N64 time)');
console.log('  • Snapshots: Every 100M cycles');
console.log('  • Graphics bridge: Enabled for real rendering');
console.log('  • Expected run time: 3-10 minutes\n');

const proc = spawn('node', args, { cwd: __dirname });

let output = '';
let bridgeFrames = 0;

proc.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  
  // Monitor for bridge activity
  if (text.includes('[bridge]')) {
    bridgeFrames++;
    const match = text.match(/crc=([a-f0-9]+)/);
    if (match) {
      console.log(`  [Bridge frame ${bridgeFrames}] CRC: ${match[1]}`);
    }
  }
  
  // Monitor for snapshot saves
  if (text.includes('[snapshot] wrote')) {
    const match = text.match(/wrote (.+\.png)/);
    if (match) {
      frameCount++;
      const filePath = match[1];
      try {
        const stats = fs.statSync(filePath);
        lastFrameSize = stats.size;
        console.log(`  [Frame ${frameCount}] ${path.basename(filePath)} (${(stats.size/1024).toFixed(1)}KB)`);
        
        // Check if this looks like it has real graphics (>5KB usually means actual rendering)
        if (stats.size > 5000) {
          console.log('    🎯 Large frame detected - likely contains Mario!');
        }
      } catch (e) {}
    }
  }
});

proc.stderr.on('data', (data) => {
  const text = data.toString();
  if (text.includes('bridge') || text.includes('snapshot')) {
    console.log(`  [Info] ${text.trim()}`);
  }
});

proc.on('close', (code) => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  
  console.log('\n================================================');
  console.log(`✅ Emulation complete in ${elapsed} seconds`);
  console.log(`  • Frames captured: ${frameCount}`);
  console.log(`  • Bridge renders: ${bridgeFrames}`);
  
  // Find all generated frames
  try {
    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('mario_real') && f.endsWith('.png'))
      .map(f => ({
        name: f,
        path: path.join(tmpDir, f),
        size: fs.statSync(path.join(tmpDir, f)).size
      }))
      .sort((a, b) => b.size - a.size);
    
    if (frames.length > 0) {
      console.log('\n🖼️  Generated frames (sorted by size):');
      frames.slice(0, 10).forEach(f => {
        const kb = (f.size / 1024).toFixed(1);
        const flag = f.size > 5000 ? ' ⭐' : '';
        console.log(`  ${f.name}: ${kb}KB${flag}`);
      });
      
      const best = frames[0];
      if (best.size > 5000) {
        console.log('\n🎮 SUCCESS! Mario\'s head should be visible!');
        console.log(`  Largest frame: ${best.name} (${(best.size/1024).toFixed(1)}KB)`);
        console.log(`\n  To view: open ${best.path}`);
        
        // Automatically open the best frame
        require('child_process').exec(`open "${best.path}"`);
      } else if (best.size > 1000) {
        console.log('\n📊 Partial rendering detected.');
        console.log('  The emulation may need to run longer to reach the title screen.');
        console.log(`\n  To view best result: open ${best.path}`);
      } else {
        console.log('\n⚠️  Only small frames generated (likely gradients).');
        console.log('  The emulation needs to run much longer to reach the title screen.');
      }
    } else {
      console.log('\n⚠️  No frames were generated.');
    }
  } catch (e) {
    console.log('\n⚠️  Could not check generated frames:', e.message);
  }
  
  // Save the output log for debugging
  fs.writeFileSync('tmp/mario_run.log', output);
  console.log('\n📝 Full log saved to: tmp/mario_run.log');
});

console.log('🚀 Starting emulation...\n');

// Progress indicator
let dots = 0;
const progress = setInterval(() => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const dotsStr = '.'.repeat((dots++ % 4) + 1).padEnd(4);
  process.stdout.write(`\r  Running${dotsStr} ${elapsed}s elapsed`);
}, 1000);

proc.on('close', () => {
  clearInterval(progress);
  console.log(''); // New line after progress
});

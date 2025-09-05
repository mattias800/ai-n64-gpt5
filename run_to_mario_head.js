#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║       🎮 Super Mario 64 - Title Screen Tech Demo 🎮        ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log();
console.log('This will run the emulator until we see Mario\'s glorious head!');
console.log('Expected time: 30-120 minutes (but worth it for the tech demo)');
console.log();

const startTime = Date.now();
let frameCount = 0;
let bridgeCount = 0;
let lastSignificantFrame = null;

// Clean up old frames
const tmpDir = path.join(__dirname, 'tmp');
try {
  const oldFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('mario_head_') && f.endsWith('.png'));
  oldFiles.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
} catch (e) {}

// Build command - optimized for reaching title screen
const args = [
  'packages/headless/dist/cli.js',
  'rom-boot-run',
  './mario64.z64',
  '--cycles', '50000000000',          // 50 billion cycles (enough to reach title for sure)
  '--fastboot-hle',                    // Fast boot with HLE
  '--skip-reserved-at', '0x8005c800',  // Skip known problematic instruction  
  '--vector-auto-return',              // Auto-return from exception vectors
  '--jump-header',                      // Jump to game header
  '--ipl-hle',                         // HLE the IPL boot
  '--vi-init',                         // Initialize VI
  '--vi-vblank',                       // Enable vblank interrupts
  '--vi-interval', '781250',           // ~120 fps for faster progress
  '--bridge',                          // Enable graphics bridge
  '--bridge-any',                      // Process any SP task
  '--bridge-log',                      // Log bridge activity
  '--snapshot', 'tmp/mario_head',     // Output path
  '--snapshot-interval', '500000000',  // Snapshot every 500M cycles
  '--timing-profile', 'fast',          // Use fast timing profile
  '--width', '320',
  '--height', '240'
];

console.log('Configuration for maximum progress:');
console.log('  • 50 billion cycles budget (9 minutes of N64 time)');
console.log('  • Fast timing profile');
console.log('  • 120Hz VI updates for faster frame generation');
console.log('  • Bridge enabled to capture graphics commands');
console.log('  • Snapshots every 500M cycles');
console.log();
console.log('Progress indicators:');
console.log('  📊 0.4KB frames = blank/gradient (initialization)');
console.log('  📈 1-5KB frames = partial graphics');
console.log('  🎯 >5KB frames = likely has Mario!');
console.log();

const proc = spawn('node', args, { cwd: __dirname });

let output = '';
let spTasks = 0;
let lastCycleCount = 0;

proc.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  
  // Monitor for SP task starts (graphics commands)
  if (text.includes('sp_start')) {
    spTasks++;
    if (spTasks % 10 === 0) {
      console.log(`  💫 SP Task #${spTasks} started`);
    }
  }
  
  // Monitor for bridge activity (actual rendering)
  if (text.includes('[bridge]')) {
    bridgeCount++;
    const match = text.match(/dl=0x([a-f0-9]+).*crc=([a-f0-9]+)/);
    if (match) {
      console.log(`  🎨 [Bridge render ${bridgeCount}] Display list: 0x${match[1]}, CRC: ${match[2]}`);
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
        const kb = (stats.size / 1024).toFixed(1);
        
        // Categorize frame
        let category = '⬜';
        if (stats.size > 5000) {
          category = '🎯';
          lastSignificantFrame = filePath;
        } else if (stats.size > 1000) {
          category = '📈';
        } else if (stats.size > 500) {
          category = '📊';
        }
        
        console.log(`  ${category} [Frame ${frameCount}] ${path.basename(filePath)} (${kb}KB)`);
        
        // Alert on significant frames
        if (stats.size > 10000) {
          console.log('    🚨 LARGE FRAME! This likely contains the title screen!');
        }
      } catch (e) {}
    }
  }
});

proc.stderr.on('data', (data) => {
  // Suppress most stderr unless it's important
  const text = data.toString();
  if (text.includes('Error') || text.includes('error')) {
    console.log(`  ⚠️ ${text.trim()}`);
  }
});

// Progress timer
const progressInterval = setInterval(() => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  
  process.stdout.write(`\r  ⏱️  Elapsed: ${minutes}m ${seconds}s | Frames: ${frameCount} | Bridge renders: ${bridgeCount} | SP tasks: ${spTasks}`);
}, 5000);

proc.on('close', (code) => {
  clearInterval(progressInterval);
  console.log('\n');
  
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    Emulation Complete!                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`📊 Statistics:`);
  console.log(`  • Total time: ${minutes} minutes ${seconds} seconds`);
  console.log(`  • Frames captured: ${frameCount}`);
  console.log(`  • Bridge renders: ${bridgeCount}`);
  console.log(`  • SP tasks executed: ${spTasks}`);
  console.log();
  
  // Find all generated frames
  try {
    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('mario_head') && f.endsWith('.png'))
      .map(f => ({
        name: f,
        path: path.join(tmpDir, f),
        size: fs.statSync(path.join(tmpDir, f)).size
      }))
      .sort((a, b) => b.size - a.size);
    
    if (frames.length > 0) {
      console.log('🖼️  Top frames by size:');
      frames.slice(0, 5).forEach((f, i) => {
        const kb = (f.size / 1024).toFixed(1);
        const rank = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
        console.log(`  ${rank} ${f.name}: ${kb}KB`);
      });
      
      const best = frames[0];
      console.log();
      
      if (best.size > 10000) {
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║   🎮 SUCCESS! MARIO\'S HEAD SHOULD BE VISIBLE! 🎮          ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log();
        console.log(`The largest frame (${best.name}) is ${(best.size/1024).toFixed(1)}KB`);
        console.log('This indicates complex graphics data - likely the title screen!');
        console.log();
        console.log(`Opening: ${best.path}`);
        
        // Automatically open the best frame
        require('child_process').exec(`open "${best.path}"`);
      } else if (best.size > 5000) {
        console.log('🎯 Significant rendering detected!');
        console.log(`Largest frame: ${best.name} (${(best.size/1024).toFixed(1)}KB)`);
        console.log('This may contain partial title screen graphics.');
        console.log();
        console.log(`Opening: ${best.path}`);
        require('child_process').exec(`open "${best.path}"`);
      } else if (best.size > 1000) {
        console.log('📈 Some graphics activity detected.');
        console.log('The emulation made progress but may need more time.');
        if (lastSignificantFrame) {
          console.log(`Best frame so far: ${path.basename(lastSignificantFrame)}`);
          require('child_process').exec(`open "${lastSignificantFrame}"`);
        }
      } else {
        console.log('⚠️  Only initialization frames captured.');
        console.log('The emulation needs significantly more time to reach the title screen.');
        console.log('Consider running overnight or on a faster machine.');
      }
      
      // Also check for bridge frames
      const bridgeFrames = frames.filter(f => f.name.includes('bridge'));
      if (bridgeFrames.length > 0) {
        console.log();
        console.log(`🌉 Bridge frames found: ${bridgeFrames.length}`);
        bridgeFrames.slice(0, 3).forEach(f => {
          console.log(`  • ${f.name}: ${(f.size/1024).toFixed(1)}KB`);
        });
      }
    } else {
      console.log('⚠️  No frames were generated.');
      console.log('The emulation may have encountered an issue.');
    }
  } catch (e) {
    console.log('⚠️  Could not analyze frames:', e.message);
  }
  
  // Save the full log
  fs.writeFileSync('tmp/mario_head_full.log', output);
  console.log();
  console.log('📝 Full log saved to: tmp/mario_head_full.log');
  
  // Provide next steps
  console.log();
  console.log('💡 Next steps:');
  if (bridgeCount > 0) {
    console.log('  ✓ Graphics commands were processed');
    console.log('  → Check the largest PNG files for Mario');
  } else if (spTasks > 100) {
    console.log('  ✓ Many SP tasks executed');
    console.log('  → The game is running but hasn\'t started rendering yet');
    console.log('  → Try running again with more cycles');
  } else {
    console.log('  → The game is still initializing');
    console.log('  → This emulator needs significant time to reach the title');
    console.log('  → Consider leaving it running overnight');
  }
});

console.log('🚀 Starting emulation...');
console.log('   (Press Ctrl+C to stop at any time)');
console.log();

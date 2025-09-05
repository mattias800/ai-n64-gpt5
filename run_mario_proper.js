#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('=== Super Mario 64 Proper Boot Attempt ===\n');

// Clean up old artifacts
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// Remove old snapshots
const oldFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('mario_proper_'));
oldFiles.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));

console.log('Starting Super Mario 64 with targeted fixes...\n');

// Run with multiple strategies:
// 1. Pre-stage the ROM code section to RDRAM
// 2. Use fastboot-HLE with FPU enabled  
// 3. Use vector auto-return to escape exception loops
// 4. Enable VI initialization and vblank interrupts
// 5. Use bridge rendering with snapshots

const args = [
  'packages/headless/dist/cli.js',
  'rom-boot-run',
  'mario64.z64',
  '500000000',  // 500 million cycles (~10 seconds of N64 time)
  '--fastboot-hle',
  '--vector-auto-return',
  '--jump-header',
  '--vi-init',
  '--vi-vblank',
  '--bridge',
  '--bridge-log',
  '--snapshot-prefix', 'tmp/mario_proper',
  '--snapshot-interval', '10000000',  // Every 10M cycles
  '--stage-cart', '0x0',  // Stage ROM from start
  '--stage-at', '0x246000',  // To the entry point area in RDRAM  
  '--stage-len', '0x200000',  // 2MB
  '--timing-csv', 'tmp/mario_proper_timing.csv',
  '--output-json'
];

const proc = spawn('node', args, { cwd: __dirname });

let output = '';
let frameCount = 0;
let spTaskCount = 0;
let lastPC = '';

proc.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  
  // Check for frame renders
  if (text.includes('[bridge] frame')) {
    frameCount++;
    const match = text.match(/frame (\d+)/);
    if (match) {
      console.log(`Frame ${match[1]} rendered`);
    }
  }
  
  // Check for SP graphics tasks
  if (text.includes('[sp] start')) {
    spTaskCount++;
    console.log(`SP graphics task #${spTaskCount} started`);
  }
  
  // Track PC for debugging
  const pcMatch = text.match(/"endPC":\s*(\d+)/);
  if (pcMatch) {
    const pc = parseInt(pcMatch[1]);
    const hex = '0x' + pc.toString(16);
    if (hex !== lastPC) {
      lastPC = hex;
      console.log(`CPU at PC: ${hex}`);
    }
  }
});

proc.stderr.on('data', (data) => {
  console.error('Error:', data.toString());
});

proc.on('close', (code) => {
  // Save full output
  fs.writeFileSync('tmp/mario_proper_output.json', output);
  
  console.log('\n=== Run Complete ===');
  console.log(`Exit code: ${code}`);
  console.log(`Frames rendered: ${frameCount}`);
  console.log(`SP tasks started: ${spTaskCount}`);
  
  // Check for snapshots
  const snapshots = fs.readdirSync(tmpDir)
    .filter(f => f.startsWith('mario_proper') && f.endsWith('.png'));
    
  console.log(`Snapshots created: ${snapshots.length}`);
  
  if (snapshots.length > 0) {
    // Find largest snapshot (likely most complete frame)
    let largestFile = '';
    let largestSize = 0;
    
    snapshots.forEach(f => {
      const stats = fs.statSync(path.join(tmpDir, f));
      if (stats.size > largestSize) {
        largestSize = stats.size;
        largestFile = f;
      }
    });
    
    console.log(`\nLargest snapshot: ${largestFile} (${(largestSize/1024).toFixed(1)} KB)`);
    
    if (largestSize > 5000) {
      console.log('This likely contains actual game graphics!');
      const fullPath = path.join(tmpDir, largestFile);
      
      // Try to open the image
      spawn('open', [fullPath]).on('error', () => {
        console.log(`View the image at: ${fullPath}`);
      });
    }
  }
  
  // Parse JSON output for more details
  try {
    const lines = output.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const result = JSON.parse(lastLine);
    
    console.log('\n=== Final Statistics ===');
    console.log(`Cycles executed: ${result.cycles.toLocaleString()}`);
    console.log(`End PC: 0x${result.endPC.toString(16)}`);
    console.log(`VI Origin writes: ${result.events.viOriginWrites}`);
    console.log(`PI DMAs: ${result.events.piDmas}`);
    console.log(`SP starts: ${result.events.spStarts}`);
    
  } catch (e) {
    // JSON parsing failed, that's okay
  }
});

console.log('Running... (this may take a few minutes)\n');

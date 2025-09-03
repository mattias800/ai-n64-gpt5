#!/usr/bin/env node

const { CPU } = require('./packages/core/dist/cpu/cpu.js');
const { Memory } = require('./packages/core/dist/memory.js');
const { Devices } = require('./packages/core/dist/devices/index.js');
const { F3DEX } = require('./packages/web/dist/f3dex.js');
const fs = require('fs');
const { createCanvas } = require('canvas');

// Create a test OSTask for F3DEX
const testOSTask = {
    type: 1, // M_GFXTASK
    flags: 0,
    ucode_boot: 0x80000000,
    ucode_boot_size: 0x1000,
    ucode: 0x80001000,
    ucode_size: 0x1000,
    ucode_data: 0x80002000,
    ucode_data_size: 0x800,
    data_ptr: 0x80100000, // Display list location
    data_size: 0x1000,
    dram_stack: 0x80003000,
    dram_stack_size: 0x400,
    output_buff: 0x80200000,
    output_buff_size: 0x20000,
    yield_data_ptr: 0,
    yield_data_size: 0
};

// Create a simple display list
const displayList = [
    0xe7000000, 0x00000000, // G_RDPPIPESYNC
    0xfc121824, 0xff33ffff, // G_SETCOMBINE
    0xba001402, 0x00000000, // G_SETOTHERMODE_H
    0xb900031d, 0x00552078, // G_SETOTHERMODE_L
    0xe8000000, 0x00000000, // G_ENDDL
];

console.log('Testing F3DEX rendering with synthetic OSTask...');
console.log('OSTask data_ptr:', testOSTask.data_ptr.toString(16));
console.log('Display list commands:', displayList.length);

// Test the address conversion
const physicalAddr = testOSTask.data_ptr & 0x1fffffff;
const virtualAddr = physicalAddr < 0x80000000 ? (physicalAddr | 0x80000000) : physicalAddr;

console.log('Physical address:', physicalAddr.toString(16));
console.log('Virtual address:', virtualAddr.toString(16));
console.log('Address conversion working:', virtualAddr === 0x80100000);

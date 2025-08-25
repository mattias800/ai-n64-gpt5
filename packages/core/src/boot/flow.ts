import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';
import { hleBoot } from './hle.js';
import { hlePifControllerStatus, hlePifReadControllerState } from './pif_hle.js';

export type BootAndControllerResult = {
  initialPC: number;
  controller: { present: boolean; pak: number; reserved: number };
  state: { status: number; buttons: number; stickX: number; stickY: number };
};

export function hleBootAndInitController(cpu: CPU, bus: Bus, rom: Uint8Array, ctrlDramBase = 0x2000): BootAndControllerResult {
  const boot = hleBoot(cpu, bus, rom);
  const status = hlePifControllerStatus(bus, ctrlDramBase);
  const state = hlePifReadControllerState(bus, ctrlDramBase + 0x40);
  return { initialPC: boot.initialPC >>> 0, controller: status, state };
}

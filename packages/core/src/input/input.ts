import { Bus } from '../mem/bus.js';
import { hlePifReadControllerState } from '../boot/pif_hle.js';

export type InputState = {
  status: number;
  buttons: number; // 16-bit mask
  stickX: number; // signed 8-bit
  stickY: number; // signed 8-bit
};

export function readControllerState(bus: Bus, dramAddr = 0x3000): InputState {
  return hlePifReadControllerState(bus, dramAddr);
}

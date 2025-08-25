import { CPU } from '../cpu/cpu.js';
import { Bus } from '../mem/bus.js';

export type ScheduledCallback = () => void;

export class System {
  cycle = 0 >>> 0;
  private events = new Map<number, ScheduledCallback[]>();

  constructor(public readonly cpu: CPU, public readonly bus: Bus) {}

  scheduleAt(cycle: number, cb: ScheduledCallback): void {
    const t = cycle >>> 0;
    const arr = this.events.get(t) ?? [];
    arr.push(cb);
    this.events.set(t, arr);
  }

  scheduleEvery(startCycle: number, interval: number, times: number, cb: ScheduledCallback): void {
    let c = startCycle >>> 0;
    for (let i = 0; i < times; i++) {
      this.scheduleAt(c, cb);
      c = (c + (interval >>> 0)) >>> 0;
    }
  }

  stepCycles(n: number): void {
    for (let i = 0; i < n; i++) {
      // Advance cycle first, run events for this cycle, then step CPU so events are visible to CPU boundary checks
      this.cycle = (this.cycle + 1) >>> 0;
      const due = this.events.get(this.cycle);
      if (due) {
        for (const cb of due) cb();
        this.events.delete(this.cycle);
      }
      this.cpu.step();
    }
  }
}


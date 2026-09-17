import { describe, it, expect } from 'vitest';
import { Poller, type PollerHost } from './resource.js';

// A fake clock: timers fire when `advance` passes their due time.
function fakeHost() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; cb: () => void }>();
  let hidden = false;
  const host: PollerHost = {
    setTimeout: (cb, ms) => {
      const id = nextId++;
      timers.set(id, { due: now + ms, cb });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    isHidden: () => hidden,
  };
  return {
    host,
    setHidden: (v: boolean) => { hidden = v; },
    pending: () => timers.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].cb();
      }
      now = target;
    },
  };
}

describe('Poller', () => {
  it('ticks every interval and stops cleanly', () => {
    const clock = fakeHost();
    let ticks = 0;
    const p = new Poller(() => { ticks += 1; }, clock.host);
    p.start(1000);
    clock.advance(2999);
    expect(ticks).toBe(2);
    p.stop();
    clock.advance(5000);
    expect(ticks).toBe(2);
    expect(clock.pending()).toBe(0);
  });

  it('pauses while hidden and ticks immediately on becoming visible', () => {
    const clock = fakeHost();
    let ticks = 0;
    const p = new Poller(() => { ticks += 1; }, clock.host);
    p.start(1000);
    clock.advance(1000);
    expect(ticks).toBe(1);
    clock.setHidden(true);
    p.visibilityChanged();
    clock.advance(10_000);
    expect(ticks).toBe(1);
    expect(clock.pending()).toBe(0);
    clock.setHidden(false);
    p.visibilityChanged();
    expect(ticks).toBe(2); // the catch-up tick
    clock.advance(1000);
    expect(ticks).toBe(3);
  });

  it('re-arms from now when the interval changes', () => {
    const clock = fakeHost();
    let ticks = 0;
    const p = new Poller(() => { ticks += 1; }, clock.host);
    p.start(4000);
    clock.advance(3000);
    p.setInterval(1500);
    clock.advance(1499);
    expect(ticks).toBe(0);
    clock.advance(1);
    expect(ticks).toBe(1);
    p.setInterval(1500); // same value: no re-arm, next tick still on schedule
    clock.advance(1500);
    expect(ticks).toBe(2);
  });

  it('does not start a timer while hidden', () => {
    const clock = fakeHost();
    clock.setHidden(true);
    const p = new Poller(() => undefined, clock.host);
    p.start(500);
    expect(clock.pending()).toBe(0);
    clock.setHidden(false);
    p.visibilityChanged();
    expect(clock.pending()).toBe(1);
  });
});

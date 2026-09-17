import { describe, it, expect } from 'vitest';
import { notifyRunFinished, onRunFinished, type RunFinished } from './notifications.js';

const event: RunFinished = { scenario: { id: 7, name: 'Shop' }, runId: 42, status: 'failed' };

describe('run-finished notifications', () => {
  it('delivers the event to every adapter and waits for them', async () => {
    const seen: string[] = [];
    const offA = onRunFinished(async function push(e) {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(`push:${e.runId}:${e.status}`);
    });
    const offB = onRunFinished(function email(e) {
      seen.push(`email:${e.scenario.name}`);
    });
    await notifyRunFinished(event);
    expect(seen.sort()).toEqual(['email:Shop', 'push:42:failed']);
    offA();
    offB();
  });

  it('logs a failing adapter and still delivers to the others', async () => {
    const seen: string[] = [];
    const logged: string[] = [];
    const offA = onRunFinished(async function broken() {
      throw new Error('smtp down');
    });
    const offB = onRunFinished(function fine() {
      seen.push('fine');
    });
    await expect(notifyRunFinished(event, (m) => logged.push(m))).resolves.toBeUndefined();
    expect(seen).toEqual(['fine']);
    expect(logged).toEqual(['notification adapter broken failed for run #42: smtp down']);
    offA();
    offB();
  });

  it('is a no-op with nothing registered, and unregistering works', async () => {
    let calls = 0;
    const off = onRunFinished(() => { calls += 1; });
    off();
    await notifyRunFinished(event);
    expect(calls).toBe(0);
  });
});

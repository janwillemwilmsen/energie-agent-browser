import { describe, it, expect } from 'vitest';
import type { A11yTree } from '@eab/shared';
import { parseSnapshotText } from '../agentBrowser/parser.js';
import {
  executeStep,
  executeSteps,
  parseStep,
  type Browser,
  type RunResult,
  type StepContext,
} from './stepExecutor.js';

// --- A scripted fake at the Browser seam --------------------------------------------

type Handler = (args: string[]) => RunResult | undefined;

interface FakeBrowser extends Browser {
  calls: string[][];
  snapshots: number;
  closed: number;
}

const OK: RunResult = { stdout: '', stderr: '', exitCode: 0 };

/**
 * `trees` is a queue of snapshots: each snapshot() call shifts one off, and the
 * last one repeats. `handlers` answer run() calls; the first to return a result
 * wins, anything unhandled succeeds with empty output.
 */
function fakeBrowser(trees: A11yTree[], handlers: Handler[] = []): FakeBrowser {
  const queue = [...trees];
  const fake: FakeBrowser = {
    calls: [],
    snapshots: 0,
    closed: 0,
    async run(args) {
      fake.calls.push(args);
      for (const h of handlers) {
        const r = h(args);
        if (r) return r;
      }
      return OK;
    },
    async snapshot() {
      fake.snapshots += 1;
      if (queue.length === 0) throw new Error('fake: no snapshot scripted');
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    async close() {
      fake.closed += 1;
    },
  };
  return fake;
}

function tree(snapshot: string, url = 'https://example.test/'): A11yTree {
  return parseSnapshotText(snapshot, url);
}

const EMPTY = tree('');
const WITH_BUTTON = tree(`- button "Go" [ref=e1]`);

function context(browser: Browser, extra: Partial<StepContext> = {}): StepContext & { lines: string[]; slept: number[] } {
  const lines: string[] = [];
  const slept: number[] = [];
  return {
    browser,
    log: (l) => lines.push(l),
    timing: { selectorWaitMs: 50, selectorPollMs: 1, sleep: async (ms) => { slept.push(ms); } },
    lines,
    slept,
    ...extra,
  };
}

const ran = (b: FakeBrowser, cmd: string) => b.calls.filter((c) => c[0] === cmd);

// --- Tests ------------------------------------------------------------------------------

describe('Step executor', () => {
  it('hands a raw locator to the browser verbatim, without a snapshot', async () => {
    const b = fakeBrowser([WITH_BUTTON]);
    await executeStep(context(b), parseStep('click', { selector: { role: '', name: '', locator: '#go' } }));
    expect(ran(b, 'click')).toEqual([['click', '#go']]);
    expect(b.snapshots).toBe(0);
  });

  it('resolves role+name against the tree, waiting for it to appear', async () => {
    // First snapshot is empty (page still rendering); the button shows up on the next.
    const b = fakeBrowser([EMPTY, WITH_BUTTON]);
    await executeStep(context(b), parseStep('click', { selector: { role: 'button', name: 'Go' } }));
    expect(b.snapshots).toBe(2);
    expect(ran(b, 'click')).toEqual([['click', '@e1']]);
    // A click settles: the load-state wait runs after it.
    expect(b.calls.at(-1)).toEqual(['wait', '--load', 'load']);
  });

  it('fails with a diagnostic once the implicit-wait budget is spent', async () => {
    const b = fakeBrowser([EMPTY]);
    await expect(
      executeStep(context(b), parseStep('click', { selector: { role: 'button', name: 'Go' } })),
    ).rejects.toThrow(/NO nodes of role "button"/);
    expect(ran(b, 'click')).toHaveLength(0);
  });

  it('falls back to a deep shadow-DOM query when the CLI cannot find a CSS locator', async () => {
    const b = fakeBrowser([], [
      (a) => (a[0] === 'click' ? { stdout: '', stderr: 'Error: Element not found: #deep', exitCode: 1 } : undefined),
      (a) => (a[0] === 'eval' ? { stdout: JSON.stringify({ ok: true, tag: 'button' }), stderr: '', exitCode: 0 } : undefined),
    ]);
    const ctx = context(b);
    await executeStep(ctx, parseStep('click', { selector: { role: '', name: '', locator: '#deep' } }));
    expect(ran(b, 'eval')).toHaveLength(1);
    expect(ran(b, 'eval')[0]![1]).toContain('"#deep"');
    expect(ctx.lines.some((l) => /via shadow-DOM fallback/.test(l))).toBe(true);
  });

  it('sets a native <select> in-page when the selector targets an option', async () => {
    const b = fakeBrowser(
      [tree(`- combobox "Country"\n  - option "Netherlands" [ref=e3]`)],
      [(a) => (a[0] === 'eval' ? { stdout: 'ok:nl', stderr: '', exitCode: 0 } : undefined)],
    );
    await executeStep(
      context(b),
      parseStep('select', { selector: { role: 'option', name: 'Netherlands' }, value: 'Netherlands' }),
    );
    expect(ran(b, 'select')).toHaveLength(0);
    expect(ran(b, 'eval')).toHaveLength(1);
  });

  it('retries a failed step per the policy, pausing before each retry and after success', async () => {
    let attempts = 0;
    const b = fakeBrowser([], [
      (a) => {
        if (a[0] !== 'click') return undefined;
        attempts += 1;
        return attempts < 3 ? { stdout: '', stderr: 'timeout', exitCode: 1 } : OK;
      },
    ]);
    const ctx = context(b);
    await executeSteps(
      ctx,
      [{ position: 1, step: parseStep('click', { selector: { role: '', name: '', locator: '#go' } }) }],
      { retries: 2, retryWaitBeforeMs: 10, retryWaitAfterMs: 5 },
    );
    expect(attempts).toBe(3);
    // Two retry pauses, one post-success pause; the 150ms click settles are the rest.
    expect(ctx.slept.filter((ms) => ms !== 150)).toEqual([10, 10, 5]);
    expect(ctx.lines.filter((l) => /retry 1\/2|retry 2\/2/.test(l))).toHaveLength(2);
  });

  it('gives up after the last retry with the step error', async () => {
    const b = fakeBrowser([], [(a) => (a[0] === 'click' ? { stdout: '', stderr: 'boom', exitCode: 1 } : undefined)]);
    await expect(
      executeSteps(
        context(b),
        [{ position: 1, step: parseStep('click', { selector: { role: '', name: '', locator: '#go' } }) }],
        { retries: 1, retryWaitBeforeMs: 0, retryWaitAfterMs: 0 },
      ),
    ).rejects.toThrow(/click failed: boom/);
    expect(ran(b, 'click')).toHaveLength(2);
  });

  it('rejects a malformed step before the browser is touched', () => {
    expect(() => parseStep('navigate', { url: 'not a url' })).toThrow(/invalid navigate step at url/);
    expect(() => parseStep('type', { selector: { role: 'textbox', name: 'Email' } })).toThrow(/invalid type step at text/);
    expect(() => parseStep('teleport', {})).toThrow(/invalid teleport step/);
  });

  it('refuses run-only kinds outside a scenario run', async () => {
    const b = fakeBrowser([]);
    await expect(executeStep(context(b), parseStep('screenshot', {}))).rejects.toThrow(/only available in a scenario run/);
    await expect(executeStep(context(b), parseStep('record_start', {}))).rejects.toThrow(/only available in a scenario run/);
    expect(b.calls).toHaveLength(0);
  });

  it('passes auth selector overrides through to auth login', async () => {
    const b = fakeBrowser([]);
    const ctx = context(b, { authSelectors: () => ({ usernameSelector: '#user', submitSelector: 'button[type=submit]' }) });
    await executeStep(ctx, parseStep('auth-login', { name: 'acme' }));
    expect(b.calls).toEqual([
      ['auth', 'login', 'acme', '--username-selector', '#user', '--submit-selector', 'button[type=submit]'],
    ]);
  });
});

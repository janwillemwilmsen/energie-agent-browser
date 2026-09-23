import { describe, it, expect } from 'vitest';
import { parseStepPayload as parseStep, safeParseScenarioStepPayload, safeParseStepPayload, type A11yTree } from '@eab/shared';
import { parseSnapshotText } from '../agentBrowser/parser.js';
import {
  executeStep,
  executeSteps,
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

  // agent-browser's semantic locators are a separate subcommand
  // (`find <by> <value> <action> [value] [--name] [--exact]`), resolved by the
  // browser tool in the live page — no snapshot on our side.
  describe('find selectors', () => {
    const NOT_FOUND: RunResult = {
      stdout: '',
      stderr: "✗ No element found by testid 'nope'. Verify the selector, role, or name is correct and the element exists in the DOM.",
      exitCode: 1,
    };

    it('runs click / fill / check through `find`, with the role name filter and exact flag', async () => {
      const b = fakeBrowser([]);
      const ctx = context(b);
      await executeStep(ctx, parseStep('click', { selector: { role: '', name: '', find: { by: 'role', value: 'button', name: 'Submit' } } }));
      await executeStep(ctx, parseStep('fill', { selector: { role: '', name: '', find: { by: 'label', value: 'Email' } }, value: 'a@b.c' }));
      await executeStep(ctx, parseStep('check', { selector: { role: '', name: '', find: { by: 'role', value: 'checkbox', name: 'Ik heb zonnepanelen', exact: true } } }));
      expect(ran(b, 'find')).toEqual([
        ['find', 'role', 'button', 'click', '--name', 'Submit'],
        ['find', 'label', 'Email', 'fill', 'a@b.c'],
        ['find', 'role', 'checkbox', 'check', '--name', 'Ik heb zonnepanelen', '--exact'],
      ]);
      expect(b.snapshots).toBe(0);
      // A find-click settles like any click.
      expect(b.calls[1]).toEqual(['wait', '--load', 'load']);
    });

    it('surfaces the CLI diagnostic when nothing matches', async () => {
      const b = fakeBrowser([], [(a) => (a[0] === 'find' ? NOT_FOUND : undefined)]);
      await expect(
        executeStep(context(b), parseStep('click', { selector: { role: '', name: '', find: { by: 'testid', value: 'nope' } } })),
      ).rejects.toThrow(/click failed: .*No element found by testid 'nope'/);
    });

    it('waits by polling `find … text` until it succeeds', async () => {
      let calls = 0;
      const b = fakeBrowser([], [(a) => (a[0] === 'find' && ++calls < 3 ? NOT_FOUND : undefined)]);
      await executeStep(context(b), parseStep('wait', { selector: { role: '', name: '', find: { by: 'text', value: 'Welcome' } } }));
      expect(ran(b, 'find')).toHaveLength(3);
      expect(ran(b, 'find')[0]).toEqual(['find', 'text', 'Welcome', 'text']);
    });

    it('refuses the actions `find` does not offer', async () => {
      const b = fakeBrowser([]);
      const sel = { role: '', name: '', find: { by: 'testid' as const, value: 'x' } };
      await expect(executeStep(context(b), parseStep('type', { selector: sel, text: 'hi' }))).rejects.toThrow(/type does not support a find selector/);
      await expect(executeStep(context(b), parseStep('uncheck', { selector: sel }))).rejects.toThrow(/uncheck does not support a find selector/);
      await expect(executeStep(context(b), parseStep('scroll', { selector: sel }))).rejects.toThrow(/scroll does not support a find selector/);
      expect(b.calls).toHaveLength(0);
    });
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

  it('presses a key on the focused element and lets a navigation settle', async () => {
    const b = fakeBrowser([]);
    await executeStep(context(b), parseStep('press', { key: ' Enter ' }));
    expect(b.calls).toEqual([['press', 'Enter'], ['wait', '--load', 'load']]);
    expect(b.snapshots).toBe(0);
    expect(() => parseStep('press', { key: '  ' })).toThrow(/invalid press step at key/);
  });

  it('rejects a malformed step before the browser is touched', () => {
    expect(() => parseStep('navigate', { url: 'not a url' })).toThrow(/invalid navigate step at url/);
    expect(() => parseStep('type', { selector: { role: 'textbox', name: 'Email' } })).toThrow(/invalid type step at text/);
    expect(() => parseStep('teleport', {})).toThrow(/invalid teleport step/);
    const r = safeParseStepPayload('fill', { selector: { role: 'textbox', name: 'Email' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual([{ path: 'value', message: 'Required' }]);
  });

  it('accepts auth-login as a Step but not as a Scenario Step', () => {
    expect(safeParseStepPayload('auth-login', { name: 'acme' }).ok).toBe(true);
    const r = safeParseScenarioStepPayload('auth-login', { name: 'acme' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid auth-login step/);
    expect(safeParseScenarioStepPayload('click', { selector: { role: 'button', name: 'Go' } }).ok).toBe(true);
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

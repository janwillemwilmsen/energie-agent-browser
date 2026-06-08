import { run, runJson } from '../agentBrowser/driver.js';
import { parseSnapshotText } from '../agentBrowser/parser.js';
import { resolveSelector } from './selector.js';
import type { A11yNode, A11yTree, PreflightStep, SelectorStrategy } from '@eab/shared';

// Shared step executor for preflights. Called from:
//   - /api/preflights/recorder/exec-step (live recording)
//   - /api/preflights/:id/replay         (clean replay)
//   - executeScenario in scenarios/runner.ts (scenario run with preflight)
// This keeps the step semantics identical no matter which surface invokes them.

async function snapshotTree(session: string): Promise<A11yTree> {
  const data = await runJson<{ origin: string; snapshot: string }>(
    ['snapshot', '--compact'],
    { session, timeoutMs: 30_000 },
  );
  return parseSnapshotText(data.snapshot ?? '', data.origin ?? '');
}

// Selector-resolution timing. Cookie banners and other JS-injected UI often
// don't appear in the accessibility tree until a beat after navigation.
// Without polling, a click step immediately after a navigate races the page's
// own rendering and fails with "candidates: 0". This matches the "implicit
// wait" pattern used by Playwright (~30s) and Cypress (~4s).
const SELECTOR_WAIT_MS = 15_000;
const SELECTOR_POLL_MS = 250;

function collectAllNodes(node: A11yNode, out: A11yNode[]): void {
  if (node.role && node.role !== 'root') out.push(node);
  for (const c of node.children) collectAllNodes(c, out);
}

function diagnoseFailure(
  selector: SelectorStrategy,
  tree: A11yTree | null,
  lastErr: Error | null,
  waitedMs: number,
): string {
  const baseMsg = lastErr?.message ?? 'selector did not resolve';
  if (!tree) return `${baseMsg} (waited ${waitedMs}ms, no snapshot available)`;
  const all: A11yNode[] = [];
  collectAllNodes(tree.root, all);
  const sameRole = all.filter(
    (n) => n.role.toLowerCase() === selector.role.toLowerCase(),
  );
  const sampleNames = sameRole
    .map((n) => `"${n.name}"`)
    .filter((s) => s !== '""')
    .slice(0, 10);
  const parts: string[] = [
    `${baseMsg} (waited ${waitedMs}ms)`,
    `snapshot URL=${tree.url || '(empty)'}`,
    `tree size=${all.length} nodes`,
  ];
  if (sameRole.length === 0) {
    parts.push(
      `NO nodes of role "${selector.role}" in the tree — page may not have loaded yet, ` +
      `OR your target is inside an iframe / shadow DOM that agent-browser's snapshot ` +
      `doesn't traverse by default.`,
    );
  } else {
    parts.push(
      `${sameRole.length} "${selector.role}" node(s) seen, names: ` +
      (sampleNames.length ? sampleNames.join(', ') : '(all unnamed)'),
    );
  }
  return parts.join(' | ');
}

async function resolveSelectorWithWait(
  session: string,
  selector: SelectorStrategy,
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + SELECTOR_WAIT_MS;
  let lastErr: Error | null = null;
  let lastTree: A11yTree | null = null;
  const tryOnce = async (): Promise<string> => {
    lastTree = await snapshotTree(session);
    return resolveSelector(selector, lastTree);
  };
  try { return await tryOnce(); }
  catch (e: any) { lastErr = e; }
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SELECTOR_POLL_MS));
    try { return await tryOnce(); }
    catch (e: any) { lastErr = e; }
  }
  throw new Error(diagnoseFailure(selector, lastTree, lastErr, Date.now() - startedAt));
}

// The first `open` issued right after a daemon respawn under a fresh
// --session-name occasionally returns success but doesn't actually navigate
// (browser stays at about:blank). It's a cold-start race between agent-
// browser's --session-name state-load path and the new command. Verify the
// URL really changed; if it stays blank for a few seconds, re-issue the
// open and try again.
const NAV_ATTEMPTS = 3;
const NAV_SETTLE_MS = 5_000;
const NAV_POLL_MS = 250;
async function execNavigate(session: string, url: string): Promise<void> {
  let lastUrl = '';
  for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
    const r = await run(['open', url], { session, timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`navigate failed: ${r.stderr || r.stdout}`);
    const deadline = Date.now() + NAV_SETTLE_MS;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, NAV_POLL_MS));
      try {
        const tree = await snapshotTree(session);
        lastUrl = tree.url || '';
        if (lastUrl && lastUrl !== 'about:blank' && !lastUrl.startsWith('chrome://')) {
          return;
        }
      } catch { /* keep polling */ }
    }
  }
  throw new Error(
    `navigate did not stick: tried open(${url}) ${NAV_ATTEMPTS}× but URL stayed at ` +
      `"${lastUrl || 'about:blank'}".`,
  );
}

// Per-step retry policy for a preflight (mirrors the scenario runner's policy).
// `restartOnFailure` is a whole-run concern handled by the callers (Replay /
// scenario runner) because resetting the browser connection — and whether to
// also wipe persisted state — differs between those surfaces.
export interface PreflightRetryPolicy {
  retries: number;
  retryWaitBeforeMs: number;
  retryWaitAfterMs: number;
}

const NO_RETRY: PreflightRetryPolicy = {
  retries: 0,
  retryWaitBeforeMs: 0,
  retryWaitAfterMs: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function executePreflightStep(session: string, step: PreflightStep): Promise<void> {
  if (step.kind === 'navigate') {
    await execNavigate(session, step.url);
    return;
  }
  if (step.kind === 'wait') {
    const r = await run(['wait', String(step.ms)], { session, timeoutMs: step.ms + 10_000 });
    if (r.exitCode !== 0) throw new Error(`wait failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (step.kind === 'auth-login') {
    // Delegates the whole credential-handling flow to agent-browser's Auth
    // Vault. The encrypted profile under ~/.agent-browser/auth/<name>.json
    // holds the URL + username + password; the command navigates to the URL,
    // waits for the form fields, types the creds, and submits.
    const r = await run(['auth', 'login', step.name], { session, timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`auth login "${step.name}" failed: ${r.stderr || r.stdout}`);
    return;
  }
  // click / type — selector-resolved with implicit wait.
  const selector = step.selector as SelectorStrategy;
  const ref = await resolveSelectorWithWait(session, selector);
  const args: string[] = [step.kind, ref];
  if (step.kind === 'type') args.push(step.text);
  const r = await run(args, { session, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`${step.kind} failed: ${r.stderr || r.stdout}`);
}

// Run one preflight step, re-attempting on failure per the policy: pause
// `retryWaitBeforeMs` before each retry and `retryWaitAfterMs` after a retry
// that finally succeeds. Throws if every attempt fails. Mirrors the scenario
// runner's executeStepWithRetries.
async function executePreflightStepWithRetries(
  session: string,
  step: PreflightStep,
  policy: PreflightRetryPolicy,
  onStepLog?: (msg: string) => void,
): Promise<void> {
  const retries = Math.max(0, policy.retries ?? 0);
  const waitBefore = Math.max(0, policy.retryWaitBeforeMs ?? 0);
  const waitAfter = Math.max(0, policy.retryWaitAfterMs ?? 0);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await executePreflightStep(session, step);
      if (attempt > 0 && waitAfter > 0) {
        onStepLog?.(`retry: waiting ${waitAfter}ms after success`);
        await sleep(waitAfter);
      }
      return;
    } catch (e: any) {
      if (attempt >= retries) throw e;
      onStepLog?.(`${step.kind} failed: ${e?.message ?? e} — retry ${attempt + 1}/${retries}`);
      if (waitBefore > 0) {
        onStepLog?.(`retry: waiting ${waitBefore}ms before re-attempt`);
        await sleep(waitBefore);
      }
    }
  }
}

export async function executePreflightSteps(
  session: string,
  steps: PreflightStep[],
  onStepLog?: (msg: string) => void,
  policy: PreflightRetryPolicy = NO_RETRY,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    onStepLog?.(`preflight ${i + 1}/${steps.length}: ${step.kind}${
      step.kind === 'navigate' ? ` ${step.url}` :
      step.kind === 'wait' ? ` ${step.ms}ms` :
      step.kind === 'auth-login' ? ` "${step.name}"` :
      ''
    }`);
    await executePreflightStepWithRetries(session, step, policy, onStepLog);
  }
}

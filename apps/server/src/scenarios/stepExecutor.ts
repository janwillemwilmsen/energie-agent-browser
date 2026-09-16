import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { StepPayload } from '@eab/shared';
import type { A11yNode, A11yTree, SelectorStrategy } from '@eab/shared';
import type { AuthSelectors } from '../authSelectors.js';
import { resolveSelector } from './selector.js';
import { isOptionSelector, execSelectOptionFallback } from './selectFallback.js';
import { isElementNotFound, runLocatorFallback, waitForLocatorFallback } from './shadowFallback.js';

// The Step executor: the ONE place a Step is carried out against a Browser.
// Scenario runs, Preflight replay, the Preflight recorder and the AI scenario
// agent all call in here, so every surface gets identical semantics —
// selector resolution with implicit wait, verified navigation, shadow-DOM and
// option fallbacks, and per-step retries.
//
// Nothing in this module touches the database, the config or the process
// table. Everything it needs comes in through StepContext, which is what makes
// the whole Step vocabulary testable with a fake Browser (see
// stepExecutor.test.ts).

// --- The Browser seam -----------------------------------------------------------

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * What a Step needs from the browser tool. Satisfied by the agent-browser CLI
 * in production (agentBrowser/cliBrowser.ts) and by a scripted fake in tests.
 */
export interface Browser {
  /** Run one agent-browser command (without the --session prefix). */
  run(args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** Take a compact accessibility snapshot of the current page. */
  snapshot(): Promise<A11yTree>;
  /** Tear the session down; a later command re-bootstraps it on demand. */
  close(): Promise<void>;
}

// --- Context: capabilities a caller may provide -----------------------------------

export interface Timing {
  /** Implicit wait for a role+name selector to appear in the a11y tree. */
  selectorWaitMs: number;
  selectorPollMs: number;
  /** How long to watch the URL leave about:blank after `open`, and how often. */
  navSettleMs: number;
  navPollMs: number;
  sleep(ms: number): Promise<void>;
}

/**
 * Where screenshots go. Only Scenario runs have this; a screenshot Step
 * without it fails with a clear error.
 */
export interface Artifacts {
  screenshotDir: string;
  /** Compact stamp (YYYYMMDD-HHMMSS) embedded in every screenshot filename. */
  fileStamp: string;
  /** The run's viewport; restored after a 'mobile' screenshot. */
  viewport: 'desktop' | 'mobile';
  /** Filenames captured so far; the executor appends to it. */
  screenshots: string[];
}

/** Video recording hooks for record_start / record_stop. */
export interface Recorder {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface StepContext {
  browser: Browser;
  log: (line: string) => void;
  /** Override the defaults (tests use instant sleeps and short waits). */
  timing?: Partial<Timing>;
  artifacts?: Artifacts;
  recorder?: Recorder;
  /** Per-profile selector overrides for auth-login. Absent means no overrides. */
  authSelectors?: (profileName: string) => AuthSelectors;
}

export interface RetryPolicy {
  retries: number;
  retryWaitBeforeMs: number;
  retryWaitAfterMs: number;
}

export const NO_RETRY: RetryPolicy = { retries: 0, retryWaitBeforeMs: 0, retryWaitAfterMs: 0 };

/** A Step with its 1-based position in the sequence (used in logs and filenames). */
export interface IndexedStep {
  position: number;
  step: StepPayload;
}

export const MOBILE_DEVICE = 'iPhone 14';

// Selector-resolution timing. Cookie banners and other JS-injected UI often
// don't appear in the accessibility tree until a beat after navigation.
// Without polling, a click step immediately after a navigate races the page's
// own rendering and fails with "candidates: 0". This matches the "implicit
// wait" pattern used by Playwright (~30s) and Cypress (~4s).
const DEFAULT_TIMING: Timing = {
  selectorWaitMs: 15_000,
  selectorPollMs: 250,
  navSettleMs: 5_000,
  navPollMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const SCREENSHOT_NOT_READY_RETRIES = 6;

// --- Parsing --------------------------------------------------------------------

/**
 * Turn a stored row (kind + JSON payload) into a typed Step, or throw a
 * descriptive error. Called once per Step before any browser work starts, so a
 * malformed Step fails at the top of the run rather than mid-flight.
 */
export function parseStep(kind: string, payload: unknown): StepPayload {
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const result = StepPayload.safeParse({ ...raw, kind });
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path?.length ? ` at ${issue.path.join('.')}` : '';
  throw new Error(`invalid ${kind} step${where}: ${issue?.message ?? 'does not match schema'}`);
}

/** One-line human summary of a Step for logs. */
export function describeStep(step: StepPayload): string {
  switch (step.kind) {
    case 'navigate': return `navigate ${step.url}`;
    case 'wait': return step.selector ? `wait for ${selectorLabel(step.selector)}` : `wait ${step.ms ?? 1000}ms`;
    case 'auth-login': return `auth-login "${step.name}"`;
    case 'click': case 'check': case 'uncheck':
      return `${step.kind} ${selectorLabel(step.selector)}`;
    case 'type': return `type ${selectorLabel(step.selector)} ${JSON.stringify(step.text)}`;
    case 'fill': case 'select':
      return `${step.kind} ${selectorLabel(step.selector)} ${JSON.stringify(step.value)}`;
    case 'scroll':
      return step.selector ? `scroll into view ${selectorLabel(step.selector)}`
        : step.toTop ? 'scroll to top' : step.toBottom ? 'scroll to bottom' : `scroll ${step.dy ?? 400}`;
    case 'screenshot': return `screenshot${step.label ? ` ${step.label}` : ''}`;
    case 'evaluate': return `evaluate ${step.js.slice(0, 40)}…`;
    case 'record_start': return 'record start';
    case 'record_stop': return 'record stop';
    case 'close': return 'close browser session';
  }
}

function selectorLabel(s: SelectorStrategy): string {
  if (s.locator?.trim()) return s.locator.trim();
  return `${s.role} "${s.name}"${typeof s.ordinal === 'number' ? ` #${s.ordinal}` : ''}`;
}

// --- Sequence + retries -----------------------------------------------------------

/**
 * Run a sequence of Steps in order, re-attempting each failed Step per the
 * policy: pause `retryWaitBeforeMs` before every retry and `retryWaitAfterMs`
 * after a retry that finally succeeds. Throws when a Step exhausts its retries.
 * Whole-run restarts are a caller concern (they need session knowledge).
 */
export async function executeSteps(
  ctx: StepContext,
  steps: IndexedStep[],
  policy: RetryPolicy = NO_RETRY,
): Promise<void> {
  for (const { position, step } of steps) {
    await executeStepWithRetries(ctx, step, position, policy);
  }
}

async function executeStepWithRetries(
  ctx: StepContext,
  step: StepPayload,
  position: number,
  policy: RetryPolicy,
): Promise<void> {
  const timing = { ...DEFAULT_TIMING, ...ctx.timing };
  const retries = Math.max(0, policy.retries ?? 0);
  const waitBefore = Math.max(0, policy.retryWaitBeforeMs ?? 0);
  const waitAfter = Math.max(0, policy.retryWaitAfterMs ?? 0);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await executeStep(ctx, step, position);
      if (attempt > 0 && waitAfter > 0) {
        ctx.log(`retry: waiting ${waitAfter}ms after success`);
        await timing.sleep(waitAfter);
      }
      return;
    } catch (e: any) {
      if (attempt >= retries) throw e;
      ctx.log(
        `step #${position} (${step.kind}) failed: ${e?.message ?? e} — retry ${attempt + 1}/${retries}`,
      );
      if (waitBefore > 0) {
        ctx.log(`retry: waiting ${waitBefore}ms before re-attempt`);
        await timing.sleep(waitBefore);
      }
    }
  }
}

// --- One Step ---------------------------------------------------------------------

export async function executeStep(ctx: StepContext, step: StepPayload, position = 0): Promise<void> {
  const { browser, log } = ctx;
  const timing = { ...DEFAULT_TIMING, ...ctx.timing };

  switch (step.kind) {
    case 'record_start':
      await requireRecorder(ctx, step.kind).start();
      return;
    case 'record_stop':
      await requireRecorder(ctx, step.kind).stop();
      return;
    case 'close':
      // Tear down the browser session. A later step that talks to the browser
      // re-bootstraps the session on demand.
      log('close browser session');
      await browser.close().catch((e: any) => log(`close failed (non-fatal): ${e?.message ?? e}`));
      log('browser session closed');
      return;
    case 'navigate':
      log(`navigate ${step.url}`);
      await navigate(ctx, timing, step.url);
      return;
    case 'auth-login': {
      // Delegates the whole credential-handling flow to agent-browser's Auth
      // Vault: the command navigates to the profile's URL, waits for the form
      // fields, types the creds, and submits. The vault can't store CSS
      // selectors, so per-profile overrides come in through the context.
      const args = ['auth', 'login', step.name];
      const sel = ctx.authSelectors?.(step.name) ?? {};
      if (sel.usernameSelector) args.push('--username-selector', sel.usernameSelector);
      if (sel.passwordSelector) args.push('--password-selector', sel.passwordSelector);
      if (sel.submitSelector) args.push('--submit-selector', sel.submitSelector);
      log(`auth login "${step.name}"`);
      const r = await browser.run(args, { timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new Error(`auth login "${step.name}" failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'click':
    case 'type':
    case 'fill':
    case 'select':
    // check/uncheck are the state-aware checkbox actions: no-ops when the box
    // is already in the desired state, unlike a blind click toggle.
    case 'check':
    case 'uncheck': {
      const selector = step.selector;
      const value =
        step.kind === 'type' ? step.text
        : step.kind === 'fill' || step.kind === 'select' ? step.value
        : undefined;
      const ref = await resolveRef(ctx, timing, selector);
      // A select step whose selector targets the OPTION (not the dropdown)
      // means the a11y tree had no ref-addressable combobox (e.g. Chromium's
      // MenuListPopup shape) — set the parent <select> via the JS fallback.
      if (step.kind === 'select' && !selector.locator && isOptionSelector(selector)) {
        log(`select (option fallback) ${JSON.stringify(step.value)}`);
        await execSelectOptionFallback(browser, selector, step.value);
        return;
      }
      const args = [step.kind, ref];
      // 'select' picks an option in a native <select> by label/value — the
      // selector targets the combobox itself (options have no box model).
      if (value !== undefined) args.push(value);
      log(`${step.kind} ${ref}`);
      const r = await browser.run(args, { timeoutMs: 30_000 });
      if (r.exitCode !== 0) {
        // CSS/text/xpath locators don't pierce shadow DOM in agent-browser;
        // retry in-page via a deep query over open shadow roots.
        if (selector.locator && isElementNotFound(r.stderr, r.stdout)) {
          log(`${step.kind}: locator not found by CLI — trying shadow-DOM fallback`);
          const fb = await runLocatorFallback(browser, step.kind, selector.locator, value);
          if (fb.ok) {
            log(`${step.kind} ${selector.locator} via shadow-DOM fallback (<${fb.tag}>)`);
            return;
          }
          throw new Error(
            `${step.kind} failed: ${(r.stderr || r.stdout).trim()} — shadow-DOM fallback also failed: ${fb.reason}`,
          );
        }
        throw new Error(`${step.kind} failed: ${r.stderr || r.stdout}`);
      }
      // A click may have kicked off a navigation (e.g. a link to another
      // site). Give the new document a moment to load so the next step
      // doesn't race it.
      if (step.kind === 'click') await settleAfterInteraction(browser, timing);
      return;
    }
    case 'scroll': {
      // A scroll step carrying a selector means "scroll this element into
      // view" — resolve the selector like click.
      if (step.selector) {
        const sel = step.selector;
        const ref = await resolveRef(ctx, timing, sel);
        log(`scroll into view ${ref}`);
        const r = await browser.run(['scrollintoview', ref], { timeoutMs: 30_000 });
        if (r.exitCode !== 0) {
          if (sel.locator && isElementNotFound(r.stderr, r.stdout)) {
            const fb = await runLocatorFallback(browser, 'scrollintoview', sel.locator);
            if (fb.ok) { log(`scrolled into view via shadow-DOM fallback`); return; }
            throw new Error(`scroll into view failed: ${(r.stderr || r.stdout).trim()} — shadow-DOM fallback also failed: ${fb.reason}`);
          }
          throw new Error(`scroll into view failed: ${r.stderr || r.stdout}`);
        }
        return;
      }
      if (step.toTop) {
        log(`scroll to top`);
        const r = await browser.run(['scroll', 'up', '100000'], { timeoutMs: 15_000 });
        if (r.exitCode !== 0) throw new Error(`scroll failed: ${failureText(r)}`);
        return;
      }
      if (step.toBottom) {
        // Mirrors agent-browser's documented infinite-scroll pattern: repeated
        // scroll+wait so IntersectionObserver-based lazy loaders fire on each
        // stride.
        const stridePx = 800;
        const waitMs = 600;
        const iterations = 15;
        log(`scroll to bottom (${iterations} × ${stridePx}px)`);
        for (let i = 0; i < iterations; i++) {
          const r = await browser.run(['scroll', 'down', String(stridePx)], { timeoutMs: 15_000 });
          if (r.exitCode !== 0) throw new Error(`scroll failed: ${failureText(r)}`);
          await timing.sleep(waitMs);
        }
        return;
      }
      const dy = step.dy ?? 400;
      const direction = dy >= 0 ? 'down' : 'up';
      log(`scroll ${direction} ${Math.abs(dy)}`);
      const r = await browser.run(['scroll', direction, String(Math.abs(dy))], { timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(`scroll failed: ${failureText(r)}`);
      return;
    }
    case 'wait': {
      if (step.selector) {
        // Poll for the element to appear. We deliberately do NOT pre-snapshot
        // and resolve to an `@eN` ref — refs are bound to a single snapshot
        // and go stale the instant the DOM mutates (which is exactly what
        // we're waiting for in the first place). agent-browser's `wait --text`
        // polls the live page for a substring match, which is what the user
        // actually means by "wait for the button labelled X".
        const sel = step.selector;
        const locator = sel.locator?.trim();
        const text = sel.name?.trim();
        if (!locator && !text) {
          throw new Error('wait: selector has no locator or name/text to wait for');
        }
        log(locator ? `wait for ${locator}` : `wait for text "${text}" (${sel.role})`);
        const r = await browser.run(locator ? ['wait', locator] : ['wait', '--text', text!], {
          timeoutMs: 35_000,
        });
        if (r.exitCode !== 0) {
          if (locator) {
            // The CLI's selector wait can't see into shadow DOM — poll a deep
            // query over open shadow roots instead before giving up.
            const fb = await waitForLocatorFallback(browser, locator);
            if (fb.ok) { log(`wait satisfied via shadow-DOM fallback`); return; }
          }
          throw new Error(
            `wait failed (exit=${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || 'no output — element did not appear within agent-browser default timeout'}`,
          );
        }
        return;
      }
      const ms = step.ms ?? 1000;
      log(`wait ${ms}ms`);
      const r = await browser.run(['wait', String(ms)], { timeoutMs: ms + 10_000 });
      if (r.exitCode !== 0) {
        throw new Error(`wait failed (exit=${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || 'no output'}`);
      }
      return;
    }
    case 'evaluate': {
      log(`eval ${step.js.slice(0, 60)}…`);
      const r = await browser.run(['eval', step.js], { timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new Error(`eval failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'screenshot':
      await screenshot(ctx, timing, step, position);
      return;
  }
}

// --- Helpers ----------------------------------------------------------------------

function failureText(r: RunResult): string {
  return (r.stderr || r.stdout).trim()
    || `(no output, exit code ${r.exitCode} — the browser session likely crashed or was closed mid-run)`;
}

function requireRecorder(ctx: StepContext, kind: string): Recorder {
  if (!ctx.recorder) throw new Error(`${kind}: video recording is only available in a scenario run`);
  return ctx.recorder;
}

function requireArtifacts(ctx: StepContext, kind: string): Artifacts {
  if (!ctx.artifacts) throw new Error(`${kind}: screenshots are only available in a scenario run`);
  return ctx.artifacts;
}

/**
 * Resolve a selector to something agent-browser accepts on the command line.
 * A raw locator ("#id", "[data-testid=…]", "text=…", "xpath=…", any CSS) goes
 * verbatim — agent-browser resolves and auto-waits for the element itself.
 * Otherwise resolve role+name against the a11y tree, polling until the
 * implicit-wait budget is spent, then fail with a diagnostic.
 */
async function resolveRef(ctx: StepContext, timing: Timing, selector: SelectorStrategy): Promise<string> {
  if (selector.locator?.trim()) return selector.locator.trim();
  const startedAt = Date.now();
  const deadline = startedAt + timing.selectorWaitMs;
  let lastErr: Error | null = null;
  let lastTree: A11yTree | null = null;
  const tryOnce = async (): Promise<string> => {
    lastTree = await ctx.browser.snapshot();
    return resolveSelector(selector, lastTree);
  };
  try { return await tryOnce(); }
  catch (e: any) { lastErr = e; }
  while (Date.now() < deadline) {
    await timing.sleep(timing.selectorPollMs);
    try { return await tryOnce(); }
    catch (e: any) { lastErr = e; }
  }
  throw new Error(diagnoseFailure(selector, lastTree, lastErr, Date.now() - startedAt));
}

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
  const sameRole = all.filter((n) => n.role.toLowerCase() === selector.role.toLowerCase());
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

// The first `open` issued right after a daemon respawn under a fresh
// --session-name occasionally returns success but doesn't actually navigate
// (browser stays at about:blank). It's a cold-start race between agent-
// browser's --session-name state-load path and the new command. Verify the
// URL really changed; if it stays blank for a few seconds, re-issue the open
// and try again.
const NAV_ATTEMPTS = 3;
async function navigate(ctx: StepContext, timing: Timing, url: string): Promise<void> {
  let lastUrl = '';
  for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
    const r = await ctx.browser.run(['open', url], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`navigate failed: ${r.stderr || r.stdout}`);
    const deadline = Date.now() + timing.navSettleMs;
    do {
      try {
        const tree = await ctx.browser.snapshot();
        lastUrl = tree.url || '';
        if (lastUrl && lastUrl !== 'about:blank' && !lastUrl.startsWith('chrome://')) return;
      } catch { /* keep polling */ }
      await timing.sleep(timing.navPollMs);
    } while (Date.now() < deadline);
    if (attempt < NAV_ATTEMPTS) ctx.log(`navigate: URL still "${lastUrl || 'about:blank'}" — re-issuing open (${attempt}/${NAV_ATTEMPTS})`);
  }
  throw new Error(
    `navigate did not stick: tried open(${url}) ${NAV_ATTEMPTS}× but URL stayed at "${lastUrl || 'about:blank'}".`,
  );
}

// Best-effort `wait --load load`: returns as soon as the current document has
// fired `load` (immediately if it already has). Never throws — a timeout just
// means we proceed and let the next command report a real error.
async function waitForLoad(browser: Browser, timeoutMs: number): Promise<void> {
  try { await browser.run(['wait', '--load', 'load'], { timeoutMs }); } catch { /* ignore */ }
}

// After a click that may have started a navigation (link to another page or
// site), let the new document load before the next step. `wait --load` is
// cheap when nothing is navigating, so this adds no noticeable delay to
// ordinary in-page clicks. Best-effort: never fails the step.
async function settleAfterInteraction(browser: Browser, timing: Timing): Promise<void> {
  // A navigation triggered by the click needs a beat to actually start
  // before the load-state wait can see it.
  await timing.sleep(150);
  await waitForLoad(browser, 10_000);
}

/** Set the browser to the run's viewport (desktop size or the mobile device). */
export async function applyViewport(
  browser: Browser,
  viewport: 'desktop' | 'mobile',
  log: (line: string) => void,
): Promise<void> {
  if (viewport === 'mobile') {
    log(`> set device "${MOBILE_DEVICE}"`);
    await browser.run(['set', 'device', MOBILE_DEVICE], { timeoutMs: 15_000 });
    log(`< set device ok`);
  } else {
    log(`> set viewport 1440x900`);
    await browser.run(['set', 'viewport', '1440', '900'], { timeoutMs: 15_000 });
    log(`< set viewport ok`);
  }
}

// Chrome's CDP error for "the frame has no layout yet" — seen when a screenshot
// is requested while a navigation is still committing / before first paint.
function isPageNotReadyError(stderr: string, stdout: string): boolean {
  const s = `${stderr}\n${stdout}`;
  return /Cannot take screenshot with 0 (width|height)/i.test(s) || /Unable to capture screenshot/i.test(s);
}

async function screenshot(
  ctx: StepContext,
  timing: Timing,
  step: Extract<StepPayload, { kind: 'screenshot' }>,
  position: number,
): Promise<void> {
  const { browser, log } = ctx;
  const artifacts = requireArtifacts(ctx, step.kind);
  const label = (step.label ?? `step-${position}`).replace(/[^a-z0-9._-]/gi, '_');
  // A 'mobile' shot captures at the mobile device regardless of the run's
  // viewport, so it gets the 'mobile' suffix (and pairs across runs in the
  // diff view). Otherwise it follows the run's current viewport.
  const mobileShot = step.viewport === 'mobile';
  const suffix = mobileShot ? 'mobile' : artifacts.viewport;
  // png (default) is lossless; jpeg is captured natively by agent-browser;
  // webp is captured as png and post-converted with sharp below.
  const format = step.format ?? 'png';
  const quality = step.quality ?? 80;
  const ext = format === 'jpeg' ? 'jpg' : format;
  // NNN-YYYYMMDD-HHMMSS-label-viewport.<ext> — position stays first (diff sort
  // relies on it); the timestamp block sits between position and label and is
  // stripped by the cross-run slot matchers so screenshots still pair up.
  const filename = `${position.toString().padStart(3, '0')}-${artifacts.fileStamp}-${label}-${suffix}.${ext}`;
  const filepath = path.join(artifacts.screenshotDir, filename);
  const capturePath = format === 'webp' ? `${filepath}.capture.png` : filepath;
  // agent-browser's screenshot default is VIEWPORT-only; --full captures the
  // entire scrollable page.
  const fullPage = step.fullPage !== false;
  // --annotate overlays numbered labels on interactive elements and prints a
  // legend (label [N] -> @eN role/name) to stdout.
  const annotate = step.annotate === true;

  if (mobileShot) {
    // Let the current layout settle, switch to the mobile device, let the
    // responsive reflow happen, then capture.
    await timing.sleep(50);
    log(`> set device "${MOBILE_DEVICE}" (mobile screenshot)`);
    await browser.run(['set', 'device', MOBILE_DEVICE], { timeoutMs: 15_000 });
    await timing.sleep(50);
  }

  // Global flags must precede the subcommand.
  const args: string[] = [];
  if (format === 'jpeg') args.push('--screenshot-format', 'jpeg', '--screenshot-quality', String(quality));
  args.push('screenshot');
  if (fullPage) args.push('--full');
  if (annotate) args.push('--annotate');
  args.push(capturePath);
  log(
    `screenshot${fullPage ? ' (full)' : ' (viewport)'}${mobileShot ? ' (mobile)' : ''}${annotate ? ' (annotated)' : ''}${format !== 'png' ? ` (${format} q${quality})` : ''} → ${filename}`,
  );
  // Chrome refuses to capture while a navigation is mid-flight (the new
  // document has no layout yet). That's transient — typically the step right
  // after a click that navigated elsewhere. Wait for the load state and retry
  // a few times before giving up.
  let r = await browser.run(args, { timeoutMs: 60_000 });
  for (let attempt = 1; r.exitCode !== 0 && isPageNotReadyError(r.stderr, r.stdout) && attempt <= SCREENSHOT_NOT_READY_RETRIES; attempt++) {
    log(`screenshot: page not ready yet (${(r.stderr || r.stdout).trim().split('\n')[0]}) — waiting for load and retrying (${attempt}/${SCREENSHOT_NOT_READY_RETRIES})`);
    await timing.sleep(500);
    await waitForLoad(browser, 10_000);
    r = await browser.run(args, { timeoutMs: 60_000 });
  }
  if (r.exitCode !== 0) throw new Error(`screenshot failed: ${r.stderr || r.stdout}`);
  if (format === 'webp') {
    // agent-browser can't emit webp — convert the png capture and drop it.
    await sharp(capturePath).webp({ quality }).toFile(filepath);
    fs.rmSync(capturePath, { force: true });
  }
  artifacts.screenshots.push(filename);
  // The annotate legend is on stdout — keep it in the run log so the labels
  // are interpretable later.
  if (annotate && r.stdout.trim()) log(r.stdout.trim());

  if (mobileShot) {
    // Restore the run's viewport so following steps run as before.
    await timing.sleep(50);
    await applyViewport(browser, artifacts.viewport, log);
  }
}

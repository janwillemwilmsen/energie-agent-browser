import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { run, runJson, closeSession, ensureSession } from '../agentBrowser/driver.js';
import { parseSnapshotText } from '../agentBrowser/parser.js';
import { resolveSelector } from './selector.js';
import type { SelectorStrategy, ViewportPreset } from '@eab/shared';

const MOBILE_DEVICE = 'iPhone 14';

interface StepRow {
  id: number;
  scenario_id: number;
  position: number;
  kind: string;
  payload_json: string;
}

interface ScenarioRow {
  id: number;
  name: string;
  url: string;
  viewport_preset: ViewportPreset;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
}

interface RunContext {
  runId: number;
  session: string;
  scenario: ScenarioRow;
  viewport: 'desktop' | 'mobile';
  screenshotDir: string;
  log: string[];
  screenshots: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(ctx: { runId: number; log: string[] }, line: string): void {
  const stamped = `[${nowIso()}] ${line}`;
  ctx.log.push(stamped);
  // eslint-disable-next-line no-console
  console.log(`run#${ctx.runId} ${stamped}`);
  try {
    getDb()
      .prepare('UPDATE runs SET log_text = ? WHERE id = ?')
      .run(ctx.log.join('\n'), ctx.runId);
  } catch {
    /* ignore */
  }
}

async function snapshotTree(session: string) {
  const data = await runJson<{ origin: string; snapshot: string }>(
    ['snapshot', '--compact'],
    { session, timeoutMs: 30_000 },
  );
  return parseSnapshotText(data.snapshot ?? '', data.origin ?? '');
}

async function applyViewport(ctx: RunContext): Promise<void> {
  if (ctx.viewport === 'mobile') {
    appendLog(ctx, `> set device "${MOBILE_DEVICE}"`);
    await run(['set', 'device', MOBILE_DEVICE], { session: ctx.session, timeoutMs: 15_000 });
    appendLog(ctx, `< set device ok`);
  } else {
    appendLog(ctx, `> set viewport 1440x900`);
    await run(['set', 'viewport', '1440', '900'], { session: ctx.session, timeoutMs: 15_000 });
    appendLog(ctx, `< set viewport ok`);
  }
}

async function executeStep(ctx: RunContext, step: StepRow): Promise<void> {
  const payload = JSON.parse(step.payload_json);

  switch (step.kind) {
    case 'navigate': {
      const url = String(payload.url);
      appendLog(ctx, `navigate ${url}`);
      const r = await run(['open', url], { session: ctx.session, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new Error(`navigate failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'click':
    case 'type':
    case 'fill': {
      const selector = payload.selector as SelectorStrategy;
      const tree = await snapshotTree(ctx.session);
      const ref = resolveSelector(selector, tree);
      const args = [step.kind, ref];
      if (step.kind === 'type') args.push(String(payload.text ?? ''));
      if (step.kind === 'fill') args.push(String(payload.value ?? ''));
      appendLog(ctx, `${step.kind} ${ref}`);
      const r = await run(args, { session: ctx.session, timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new Error(`${step.kind} failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'scroll': {
      // A scroll step carrying a selector means "scroll this element into
      // view" — resolve the selector against a fresh snapshot, like click.
      if (payload.selector) {
        const tree = await snapshotTree(ctx.session);
        const ref = resolveSelector(payload.selector as SelectorStrategy, tree);
        appendLog(ctx, `scroll into view ${ref}`);
        const r = await run(['scrollintoview', ref], { session: ctx.session, timeoutMs: 30_000 });
        if (r.exitCode !== 0) throw new Error(`scroll into view failed: ${r.stderr || r.stdout}`);
        return;
      }
      if (payload.toTop) {
        appendLog(ctx, `scroll to top`);
        const r = await run(['scroll', 'up', '100000'], {
          session: ctx.session,
          timeoutMs: 15_000,
        });
        if (r.exitCode !== 0) throw new Error(`scroll failed: ${r.stderr || r.stdout}`);
        return;
      }
      if (payload.toBottom) {
        // Mirrors agent-browser's documented infinite-scroll pattern
        // (skill-data/core/templates/capture-workflow.sh): repeated scroll+wait
        // so IntersectionObserver-based lazy loaders fire on each stride.
        const stridePx = 800;
        const waitMs = 600;
        const iterations = 15;
        appendLog(ctx, `scroll to bottom (${iterations} × ${stridePx}px)`);
        for (let i = 0; i < iterations; i++) {
          const r = await run(['scroll', 'down', String(stridePx)], {
            session: ctx.session,
            timeoutMs: 15_000,
          });
          if (r.exitCode !== 0) throw new Error(`scroll failed: ${r.stderr || r.stdout}`);
          await new Promise((res) => setTimeout(res, waitMs));
        }
        return;
      }
      const dy = Number(payload.dy ?? 400);
      const direction = dy >= 0 ? 'down' : 'up';
      appendLog(ctx, `scroll ${direction} ${Math.abs(dy)}`);
      const r = await run(['scroll', direction, String(Math.abs(dy))], {
        session: ctx.session,
        timeoutMs: 15_000,
      });
      if (r.exitCode !== 0) throw new Error(`scroll failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'wait': {
      if (payload.selector) {
        // Poll for the element to appear. We deliberately do NOT pre-snapshot
        // and resolve to an `@eN` ref — refs are bound to a single snapshot
        // and go stale the instant the DOM mutates (which is exactly what
        // we're waiting for in the first place). agent-browser's `wait --text`
        // polls the live page for a substring match, which is what the user
        // actually means by "wait for the button labelled X".
        const sel = payload.selector as SelectorStrategy;
        const text = sel.name?.trim();
        if (!text) {
          throw new Error('wait: selector has no name/text to wait for');
        }
        appendLog(ctx, `wait for text "${text}" (${sel.role})`);
        const r = await run(['wait', '--text', text], {
          session: ctx.session,
          timeoutMs: 35_000,
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `wait failed (exit=${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || 'no output — element did not appear within agent-browser default timeout'}`,
          );
        }
        return;
      }
      const ms = Number(payload.ms ?? 1000);
      appendLog(ctx, `wait ${ms}ms`);
      const r = await run(['wait', String(ms)], { session: ctx.session, timeoutMs: ms + 10_000 });
      if (r.exitCode !== 0) {
        throw new Error(
          `wait failed (exit=${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || 'no output'}`,
        );
      }
      return;
    }
    case 'evaluate': {
      const js = String(payload.js ?? '');
      appendLog(ctx, `eval ${js.slice(0, 60)}…`);
      const r = await run(['eval', js], { session: ctx.session, timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new Error(`eval failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'screenshot': {
      const label = String(payload.label ?? `step-${step.position}`).replace(/[^a-z0-9._-]/gi, '_');
      // A 'mobile' shot captures at the mobile device regardless of the run's
      // viewport, so it gets the 'mobile' suffix (and pairs across runs in the
      // diff view). Otherwise it follows the run's current viewport.
      const mobileShot = payload.viewport === 'mobile';
      const suffix = mobileShot ? 'mobile' : ctx.viewport;
      const filename = `${step.position.toString().padStart(3, '0')}-${label}-${suffix}.png`;
      const filepath = path.join(ctx.screenshotDir, filename);
      // agent-browser's screenshot default is VIEWPORT-only; --full captures
      // the entire scrollable page. Step payload's `fullPage` defaults to true
      // on the frontend, so most steps end up with --full unless explicitly
      // opted out.
      const fullPage = payload.fullPage !== false;
      // --annotate overlays numbered labels on interactive elements and prints
      // a legend (label [N] -> @eN role/name) to stdout.
      const annotate = payload.annotate === true;

      if (mobileShot) {
        // Let the current layout settle, switch to the mobile device, let the
        // responsive reflow happen, then capture.
        await sleep(50);
        appendLog(ctx, `> set device "${MOBILE_DEVICE}" (mobile screenshot)`);
        await run(['set', 'device', MOBILE_DEVICE], { session: ctx.session, timeoutMs: 15_000 });
        await sleep(50);
      }

      const args = ['screenshot'];
      if (fullPage) args.push('--full');
      if (annotate) args.push('--annotate');
      args.push(filepath);
      appendLog(
        ctx,
        `screenshot${fullPage ? ' (full)' : ' (viewport)'}${mobileShot ? ' (mobile)' : ''}${annotate ? ' (annotated)' : ''} → ${filename}`,
      );
      const r = await run(args, { session: ctx.session, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new Error(`screenshot failed: ${r.stderr || r.stdout}`);
      ctx.screenshots.push(filename);
      // The annotate legend is on stdout — keep it in the run log so the labels
      // are interpretable later.
      if (annotate && r.stdout.trim()) appendLog(ctx, r.stdout.trim());

      if (mobileShot) {
        // Restore the run's viewport so following steps run as before.
        await sleep(50);
        await applyViewport(ctx);
      }
      return;
    }
    default:
      appendLog(ctx, `skipping unknown step kind: ${step.kind}`);
  }
}

// Run one step, re-attempting on failure per the scenario's retry policy:
// pause `retry_wait_before_ms` before each retry, and `retry_wait_after_ms`
// after a retry that finally succeeds. Throws if all attempts fail.
async function executeStepWithRetries(ctx: RunContext, step: StepRow): Promise<void> {
  const retries = Math.max(0, ctx.scenario.retries ?? 0);
  const waitBefore = Math.max(0, ctx.scenario.retry_wait_before_ms ?? 0);
  const waitAfter = Math.max(0, ctx.scenario.retry_wait_after_ms ?? 0);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await executeStep(ctx, step);
      if (attempt > 0 && waitAfter > 0) {
        appendLog(ctx, `retry: waiting ${waitAfter}ms after success`);
        await sleep(waitAfter);
      }
      return;
    } catch (e: any) {
      if (attempt >= retries) throw e;
      appendLog(
        ctx,
        `step #${step.position} (${step.kind}) failed: ${e.message} — retry ${attempt + 1}/${retries}`,
      );
      if (waitBefore > 0) {
        appendLog(ctx, `retry: waiting ${waitBefore}ms before re-attempt`);
        await sleep(waitBefore);
      }
    }
  }
}

async function runOnce(ctx: RunContext, steps: StepRow[]): Promise<void> {
  await applyViewport(ctx);
  for (const step of steps) {
    await executeStepWithRetries(ctx, step);
  }
}

export async function executeScenario(scenarioId: number): Promise<number> {
  const db = getDb();
  const scenario = db
    .prepare(
      `SELECT id, name, url, viewport_preset,
              retries, retry_wait_before_ms, retry_wait_after_ms, restart_on_failure
       FROM scenarios WHERE id = ?`,
    )
    .get(scenarioId) as ScenarioRow | undefined;
  if (!scenario) throw new Error(`Scenario ${scenarioId} not found`);

  const steps = db
    .prepare('SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY position')
    .all(scenarioId) as StepRow[];

  const runRow = db
    .prepare(
      `INSERT INTO runs (scenario_id, status, started_at) VALUES (?, 'running', CURRENT_TIMESTAMP)`,
    )
    .run(scenarioId);
  const runId = Number(runRow.lastInsertRowid);
  const screenshotDir = path.join(config.dataDir, 'screenshots', String(runId));
  fs.mkdirSync(screenshotDir, { recursive: true });

  const viewports: ('desktop' | 'mobile')[] =
    scenario.viewport_preset === 'both'
      ? ['desktop', 'mobile']
      : [scenario.viewport_preset];

  const log: string[] = [];
  const screenshots: string[] = [];
  let status: 'success' | 'failed' = 'success';
  // All work uses the shared `default` session — the user bootstraps it once
  // from any Terminal/Editor tab and every run + the live preview share it.
  const session = 'default';
  const maxRestarts = Math.max(0, scenario.restart_on_failure ?? 0);

  // Whole-run restart loop. A run that fails (a step exhausted its retries) is
  // retried from the top, after resetting the browser connection — this re-runs
  // all prior steps, so it's safe for stateful flows (unlike reloading mid-run).
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    if (attempt > 0) {
      appendLog(
        { runId, log },
        `run failed — resetting browser connection and restarting (restart ${attempt}/${maxRestarts})`,
      );
      try {
        await closeSession(session).catch(() => undefined);
        await ensureSession(session);
        appendLog({ runId, log }, 'browser connection reset; re-running scenario from the top');
      } catch (e: any) {
        appendLog({ runId, log }, `connection reset failed: ${e.message}`);
      }
    }

    // Each attempt starts from a clean screenshot set (filenames are reused).
    screenshots.length = 0;
    status = 'success';

    for (const viewport of viewports) {
      const ctx: RunContext = {
        runId,
        session,
        scenario,
        viewport,
        screenshotDir,
        log,
        screenshots,
      };
      appendLog(ctx, `=== viewport: ${viewport} ===`);
      try {
        await runOnce(ctx, steps);
      } catch (e: any) {
        status = 'failed';
        appendLog(ctx, `ERROR: ${e.message}`);
        break;
      }
    }

    if (status === 'success') break;
  }

  db.prepare(
    `UPDATE runs
     SET status = ?, finished_at = CURRENT_TIMESTAMP, log_text = ?, screenshot_paths_json = ?
     WHERE id = ?`,
  ).run(status, log.join('\n'), JSON.stringify(screenshots), runId);

  return runId;
}

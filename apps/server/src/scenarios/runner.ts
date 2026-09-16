import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { closeSession, ensureSession } from '../agentBrowser/driver.js';
import { cliBrowser } from '../agentBrowser/cliBrowser.js';
import { getAuthSelectors } from '../authSelectors.js';
import {
  applyViewport,
  executeSteps,
  type IndexedStep,
  type RetryPolicy,
  type StepContext,
} from './stepExecutor.js';
import { StreamRecorder } from './streamRecorder.js';
import { notifyScenarioFailure, notifyScenarioSuccess } from '../push.js';
import { notifyRunResultEmail } from '../email.js';
import { parseStepPayload, type ViewportPreset } from '@eab/shared';

// Scenario-run orchestration: loads the Scenario and its Preflight, creates the
// Run row, binds the browser session, applies the Preflight, runs the Steps per
// viewport with whole-run restarts, persists the outcome and notifies. The
// Steps themselves are carried out by the Step executor (stepExecutor.ts).

// Holds the in-flight video recording for a run. Recording is bracketed by
// `record_start` / `record_stop` steps, so a run may have zero, one, or several
// recordings; the holder tracks the currently-open one and an index that keeps
// each clip's filename unique. Shared across viewports and restart attempts.
interface RecordingHolder {
  recorder: StreamRecorder | null;
  absPath: string | null;
  relPath: string | null;
  index: number;
  /** The run's file stamp; clip filenames share it with the screenshots. */
  fileStamp: string;
}

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
  preflight_id: number | null;
  preflight_mode: string;
}

interface RunContext {
  runId: number;
  session: string;
  scenario: ScenarioRow;
  log: string[];
  recording: RecordingHolder;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Compact, filesystem-safe, sortable local-time stamp for screenshot filenames:
// "20260606-143025" (YYYYMMDD-HHMMSS). Local time so it matches the timestamps
// the UI renders elsewhere (toLocaleString). The cross-run slot matchers in the
// timeline and diff pairing strip this block, so it's purely informational.
function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
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

// Begin a recording at this point in the step sequence. Best-effort: a failure
// to start logs a warning but never throws, so it can't fail the run. A
// `record_start` while one is already open is ignored (keeps a single clip
// across the 'both' viewports and restart re-runs).
async function startRecordingStep(ctx: RunContext): Promise<void> {
  if (ctx.recording.recorder) {
    appendLog(ctx, `record start: already recording — ignoring`);
    return;
  }
  const recDirAbs = path.join(config.dataDir, 'recordings', String(ctx.scenario.id));
  try { fs.mkdirSync(recDirAbs, { recursive: true }); } catch { /* ignore */ }
  const safeName = (ctx.scenario.name || `scenario-${ctx.scenario.id}`)
    .replace(/[^a-z0-9._-]/gi, '_')
    .slice(0, 60);
  ctx.recording.index += 1;
  const suffix = ctx.recording.index > 1 ? `-${ctx.recording.index}` : '';
  const file = `${ctx.recording.fileStamp}-${safeName}${suffix}.webm`;
  ctx.recording.absPath = path.join(recDirAbs, file);
  ctx.recording.relPath = `recordings/${ctx.scenario.id}/${file}`;
  ctx.recording.recorder = await StreamRecorder.start({
    session: ctx.session,
    outPath: ctx.recording.absPath,
    log: (m) => appendLog(ctx, m),
  });
  appendLog(
    ctx,
    ctx.recording.recorder
      ? `recording started (screencast) → ${ctx.recording.relPath}`
      : `recording start failed (non-fatal)`,
  );
}

// Stop the open recording (if any) and register the saved webm. Used by the
// `record_stop` step and by the run-level finalizer for an unclosed recording.
async function stopRecordingStep(ctx: RunContext): Promise<void> {
  const rec = ctx.recording.recorder;
  if (!rec) return;
  ctx.recording.recorder = null;
  const frames = rec.frameCount;
  const saved = await rec.stop().catch(() => false);
  const { absPath, relPath } = ctx.recording;
  ctx.recording.absPath = null;
  ctx.recording.relPath = null;
  if (saved && absPath && relPath && fs.existsSync(absPath)) {
    const size = fs.statSync(absPath).size;
    getDb()
      .prepare(
        `INSERT INTO recordings (scenario_id, run_id, file_path, size_bytes) VALUES (?, ?, ?, ?)`,
      )
      .run(ctx.scenario.id, ctx.runId, relPath, size);
    appendLog(ctx, `recording saved (${Math.round(size / 1024)} KB, ${frames} frames)`);
  } else {
    appendLog(ctx, `recording produced no file (non-fatal)`);
  }
}

export interface ExecuteScenarioOptions {
  /**
   * Restart the browser session before the run so it starts with an empty
   * cookie jar / storage ("Reset & play"). Steps-mode preflights already get
   * this unconditionally; the flag extends the guarantee to scenarios without
   * a preflight (e.g. a cookie-consent step inside the scenario itself) and
   * to cookies-mode preflights.
   */
  freshSession?: boolean;
}

export async function executeScenario(
  scenarioId: number,
  opts: ExecuteScenarioOptions = {},
): Promise<number> {
  const db = getDb();
  const scenario = db
    .prepare(
      `SELECT id, name, url, viewport_preset,
              retries, retry_wait_before_ms, retry_wait_after_ms, restart_on_failure,
              preflight_id, preflight_mode
       FROM scenarios WHERE id = ?`,
    )
    .get(scenarioId) as ScenarioRow | undefined;
  if (!scenario) throw new Error(`Scenario ${scenarioId} not found`);

  // If a preflight is attached, load BOTH its name (for daemon binding) AND
  // its step list (to execute as a step prefix before the scenario's own
  // steps). Executing the steps every time is what gives us durable session
  // semantics: it doesn't matter that the auth.json's Auth0 session cookie
  // expires after ~2 hours, because every scenario run goes through the
  // login flow fresh. Soft-deleted preflights resolve to null here and the
  // scenario degrades to running with no preflight.
  let preflightName: string | null = null;
  let preflightStepsJson = '[]';
  // The preflight carries its own retry/restart policy (configured on the
  // /preflight page). Per-step retries apply to every attempt; restarts re-run
  // the whole preflight after resetting the browser connection.
  let preflightPolicy: RetryPolicy = { retries: 0, retryWaitBeforeMs: 0, retryWaitAfterMs: 0 };
  let preflightRestarts = 0;
  if (scenario.preflight_id != null) {
    const pf = db
      .prepare(
        `SELECT name, steps_json,
                retries, retry_wait_before_ms, retry_wait_after_ms, restart_on_failure
         FROM preflights WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(scenario.preflight_id) as
      | {
          name: string;
          steps_json: string;
          retries: number;
          retry_wait_before_ms: number;
          retry_wait_after_ms: number;
          restart_on_failure: number;
        }
      | undefined;
    if (pf) {
      preflightName = pf.name;
      preflightStepsJson = pf.steps_json;
      preflightPolicy = {
        retries: Math.max(0, pf.retries ?? 0),
        retryWaitBeforeMs: Math.max(0, pf.retry_wait_before_ms ?? 0),
        retryWaitAfterMs: Math.max(0, pf.retry_wait_after_ms ?? 0),
      };
      preflightRestarts = Math.max(0, pf.restart_on_failure ?? 0);
    }
  }

  const stepRows = db
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
  // One stamp for the whole run; reused across viewports and restart attempts.
  const runFileStamp = fileStamp(new Date());

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
  const browser = cliBrowser(session);
  const maxRestarts = Math.max(0, scenario.restart_on_failure ?? 0);
  // Video recording is opened/closed by `record_start` / `record_stop` steps;
  // this holder is shared across viewports and restart attempts so a recording
  // started in one survives into the next.
  const recording: RecordingHolder = {
    recorder: null, absPath: null, relPath: null, index: 0, fileStamp: runFileStamp,
  };
  const ctx: RunContext = { runId, session, scenario, log, recording };
  const scenarioPolicy: RetryPolicy = {
    retries: Math.max(0, scenario.retries ?? 0),
    retryWaitBeforeMs: Math.max(0, scenario.retry_wait_before_ms ?? 0),
    retryWaitAfterMs: Math.max(0, scenario.retry_wait_after_ms ?? 0),
  };

  // Finish the run as failed before any Step ran (bad step data, preflight
  // failure). The normal path at the bottom handles everything else.
  const finishFailedEarly = (reason: string): number => {
    appendLog(ctx, reason);
    db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
                       log_text = ?, screenshot_paths_json = ? WHERE id = ?`,
    ).run(log.join('\n'), JSON.stringify([]), runId);
    void notifyScenarioFailure({ id: scenario.id, name: scenario.name }, runId);
    void notifyRunResultEmail({ id: scenario.id, name: scenario.name }, runId, 'failed');
    return runId;
  };

  // Parse every Step up front so a malformed one fails the run here, with a
  // precise message, instead of mid-flight in the browser.
  let steps: IndexedStep[];
  let preflightSteps: IndexedStep[];
  try {
    steps = stepRows.map((row) => {
      try {
        return { position: row.position, step: parseStepPayload(row.kind, JSON.parse(row.payload_json)) };
      } catch (e: any) {
        throw new Error(`scenario step #${row.position}: ${e?.message ?? e}`);
      }
    });
    let rawPreflight: unknown[] = [];
    try { rawPreflight = JSON.parse(preflightStepsJson); } catch { rawPreflight = []; }
    preflightSteps = rawPreflight.map((raw, i) => {
      const { kind, ...payload } = (raw ?? {}) as { kind?: string };
      try {
        return { position: i + 1, step: parseStepPayload(String(kind ?? ''), payload) };
      } catch (e: any) {
        throw new Error(`preflight "${preflightName}" step #${i + 1}: ${e?.message ?? e}`);
      }
    });
  } catch (e: any) {
    return finishFailedEarly(`invalid step data — ${e?.message ?? e}`);
  }

  // "Reset & play": restart the daemon up front so the run starts with an
  // empty cookie jar regardless of preflight mode. (Steps-mode preflights
  // restart below anyway; this covers no-preflight and cookies-mode runs.)
  if (opts.freshSession) {
    appendLog(ctx, 'fresh session requested — restarting browser');
    await closeSession(session).catch(() => undefined);
  }

  // Preflight application: bind the daemon to the preflight's --session-name
  // (so any state save still lands in the right slot) AND execute the
  // preflight's step list fresh. The freshness is the whole point — if you've
  // recorded a login flow in the preflight, this is what re-runs it on every
  // scenario run, sidestepping the Auth0/IdP session-cookie TTL problem.
  //
  // 'cookies' mode: skip the steps and just load the preflight's saved
  // cookies/localStorage — fast, but requires a saved state file (from Save
  // preflight / Replay). 'steps' mode (default): re-run the steps in a clean
  // browser so login/consent happen fresh every run.
  //
  // Called before the first attempt AND on every whole-run restart: the
  // restart closes the session, which throws away the preflight's in-memory
  // cookies (login, consent, …), so without re-applying, a restarted attempt
  // would run logged-out. Throws when every internal attempt failed.
  const useCookiesOnly = scenario.preflight_mode === 'cookies';
  async function applyPreflight(name: string): Promise<void> {
    appendLog(
      ctx,
      useCookiesOnly
        ? `preflight "${name}": loading saved cookies (mode=cookies, steps skipped)`
        : `preflight "${name}": binding daemon + executing ${preflightSteps.length} step(s)`,
    );
    // Preflight Steps have no artifacts or recorder: a screenshot inside a
    // preflight is not a thing.
    const preflightCtx: StepContext = {
      browser,
      log: (msg) => appendLog(ctx, '  ' + msg),
      authSelectors: getAuthSelectors,
    };
    // Whole-preflight restart loop. Unlike Replay, a scenario run does NOT wipe
    // persisted state between attempts — the preflight re-runs its login flow
    // fresh anyway; we only reset the browser connection so a hung/flaky daemon
    // gets a clean socket before re-running.
    let preflightErr: any = null;
    for (let attempt = 0; attempt <= preflightRestarts; attempt++) {
      try {
        if (attempt > 0) {
          appendLog(
            ctx,
            `preflight "${name}" failed — resetting browser and restarting (restart ${attempt}/${preflightRestarts})`,
          );
          await closeSession(session).catch(() => undefined);
        }
        if (useCookiesOnly) {
          // Load the persisted state (default ensureSession behavior) and do
          // NOT run the steps.
          await ensureSession(session, { sessionName: name });
          appendLog(ctx, `preflight "${name}": cookies loaded`);
        } else {
          // Fresh-browser guarantee: a daemon reused from a previous run still
          // holds that run's in-memory cookies — ensureSession reuses on a
          // session-name match, and skipStateLoad only skips the on-disk state
          // load, not the live jar. A leftover consent cookie would hide the
          // banner and fail the "click consent" step, so always restart the
          // daemon before a steps-mode preflight. (attempt > 0 already closed
          // above; the extra close is then a cheap no-op.)
          if (attempt === 0) await closeSession(session).catch(() => undefined);
          // skipStateLoad: run the preflight in a genuinely CLEAN browser. We
          // re-execute its steps from scratch (login, cookie-consent, …), so
          // loading the preflight's saved cookies would be counter-productive —
          // e.g. a restored consent cookie means the consent banner never
          // appears and the "click consent" step fails. Binding the name
          // (without loading) keeps any future save landing in the right slot.
          await ensureSession(session, { sessionName: name, skipStateLoad: true });
          // NOTE: recording is deliberately NOT started here. The preflight
          // navigates (login), and `record start` poisons the next navigation —
          // so we wait and start recording after the scenario's first navigation.
          if (preflightSteps.length > 0) {
            await executeSteps(preflightCtx, preflightSteps, preflightPolicy);
            appendLog(ctx, `preflight "${name}": ok`);
          }
        }
        return;
      } catch (e: any) {
        preflightErr = e;
      }
    }
    throw preflightErr;
  }

  if (preflightName) {
    try {
      await applyPreflight(preflightName);
    } catch (e: any) {
      // Hard-fail the run: scenarios that depend on the preflight (e.g. a
      // logged-in scenario) can't usefully run without it. Better to surface
      // the preflight error in the run log than silently hit the login page.
      return finishFailedEarly(`preflight "${preflightName}" failed: ${e.message}`);
    }
  }

  // Whole-run restart loop. A run that fails (a step exhausted its retries) is
  // retried from the top, after resetting the browser connection — this re-runs
  // all prior steps, so it's safe for stateful flows (unlike reloading mid-run).
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    if (attempt > 0) {
      appendLog(
        ctx,
        `run failed — resetting browser connection and restarting (restart ${attempt}/${maxRestarts})`,
      );
      try {
        await closeSession(session).catch(() => undefined);
        // The close above threw away everything the preflight established in
        // the browser (login cookies, consent, …), so re-apply it — otherwise
        // the restarted attempt runs logged-out and fails for a different
        // reason than the original failure.
        if (preflightName) {
          await applyPreflight(preflightName);
        } else {
          await ensureSession(session);
        }
        appendLog(ctx, 'browser connection reset; re-running scenario from the top');
      } catch (e: any) {
        // Preflight/connection reset failed — this attempt can't usefully run
        // the scenario steps, so skip straight to the next restart (if any).
        appendLog(ctx, `restart reset failed: ${e.message}`);
        status = 'failed';
        continue;
      }
    }

    // Each attempt starts from a clean screenshot set (filenames are reused).
    screenshots.length = 0;
    status = 'success';

    for (const viewport of viewports) {
      const stepCtx: StepContext = {
        browser,
        log: (line) => appendLog(ctx, line),
        artifacts: { screenshotDir, fileStamp: runFileStamp, viewport, screenshots },
        recorder: {
          start: () => startRecordingStep(ctx),
          stop: () => stopRecordingStep(ctx),
        },
        authSelectors: getAuthSelectors,
      };
      appendLog(ctx, `=== viewport: ${viewport} ===`);
      try {
        await applyViewport(browser, viewport, stepCtx.log);
        await executeSteps(stepCtx, steps, scenarioPolicy);
      } catch (e: any) {
        status = 'failed';
        appendLog(ctx, `ERROR: ${e.message}`);
        break;
      }
    }

    if (status === 'success') break;
  }

  // A recording left open (a `record_start` without a matching `record_stop`,
  // or a run that failed mid-recording) is finalized here so the partial clip
  // is still saved.
  await stopRecordingStep(ctx);

  db.prepare(
    `UPDATE runs
     SET status = ?, finished_at = CURRENT_TIMESTAMP, log_text = ?, screenshot_paths_json = ?
     WHERE id = ?`,
  ).run(status, log.join('\n'), JSON.stringify(screenshots), runId);

  if (status === 'failed') {
    void notifyScenarioFailure({ id: scenario.id, name: scenario.name }, runId);
  } else {
    void notifyScenarioSuccess({ id: scenario.id, name: scenario.name }, runId);
  }
  void notifyRunResultEmail({ id: scenario.id, name: scenario.name }, runId, status);
  return runId;
}

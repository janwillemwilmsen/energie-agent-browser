import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PreflightCreate, PreflightUpdate, PreflightStep } from '@eab/shared';
import { getDb } from '../db/index.js';
import {
  ensureSession,
  closeSession,
  flushSessionState,
  clearPersistedSessionState,
  persistSessionState,
  PREFLIGHT_RECORDER_SESSION,
} from '../agentBrowser/driver.js';
import { executePreflightStep, executePreflightSteps } from '../scenarios/preflightExecutor.js';


function activeByName(name: string) {
  return getDb()
    .prepare('SELECT id FROM preflights WHERE name = ? AND deleted_at IS NULL')
    .get(name) as { id: number } | undefined;
}

export async function preflightsRoutes(app: FastifyInstance) {
  // --- CRUD ----------------------------------------------------------------
  app.get('/api/preflights', async () => {
    return getDb()
      .prepare(
        `SELECT id, name, description, steps_json,
                retries, retry_wait_before_ms, retry_wait_after_ms, restart_on_failure,
                created_at, updated_at, deleted_at
         FROM preflights
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC`,
      )
      .all();
  });

  app.get<{ Params: { id: string } }>('/api/preflights/:id', async (req, reply) => {
    const row = getDb()
      .prepare('SELECT * FROM preflights WHERE id = ?')
      .get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.post('/api/preflights', async (req, reply) => {
    const body = PreflightCreate.parse(req.body);
    if (activeByName(body.name)) {
      return reply.code(409).send({ error: 'name_taken', name: body.name });
    }
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO preflights
           (name, description, steps_json,
            retries, retry_wait_before_ms, retry_wait_after_ms, restart_on_failure)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.description ?? '',
        JSON.stringify(body.steps ?? []),
        Math.max(0, body.retries ?? 0),
        Math.max(0, body.retry_wait_before_ms ?? 0),
        Math.max(0, body.retry_wait_after_ms ?? 0),
        Math.max(0, body.restart_on_failure ?? 0),
      );
    return reply.code(201).send(
      db.prepare('SELECT * FROM preflights WHERE id = ?').get(info.lastInsertRowid),
    );
  });

  app.put<{ Params: { id: string } }>('/api/preflights/:id', async (req, reply) => {
    const body = PreflightUpdate.parse(req.body);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM preflights WHERE id = ? AND deleted_at IS NULL')
      .get(Number(req.params.id)) as
      | {
          id: number;
          name: string;
          description: string;
          steps_json: string;
          retries: number;
          retry_wait_before_ms: number;
          retry_wait_after_ms: number;
          restart_on_failure: number;
        }
      | undefined;
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (body.name && body.name !== existing.name) {
      const clash = activeByName(body.name);
      if (clash && clash.id !== existing.id) {
        return reply.code(409).send({ error: 'name_taken', name: body.name });
      }
    }

    const nextName = body.name ?? existing.name;
    const clampOr = (v: number | undefined, fallback: number) =>
      v == null ? fallback : Math.max(0, v);
    db.prepare(
      `UPDATE preflights
       SET name = ?, description = ?, steps_json = ?,
           retries = ?, retry_wait_before_ms = ?, retry_wait_after_ms = ?, restart_on_failure = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(
      nextName,
      body.description ?? existing.description,
      body.steps ? JSON.stringify(body.steps) : existing.steps_json,
      clampOr(body.retries, existing.retries),
      clampOr(body.retry_wait_before_ms, existing.retry_wait_before_ms),
      clampOr(body.retry_wait_after_ms, existing.retry_wait_after_ms),
      clampOr(body.restart_on_failure, existing.restart_on_failure),
      existing.id,
    );

    // Save preflight = persist BOTH the step list (above) and the captured
    // auth state. The latter only makes sense when the live default daemon
    // is currently bound to this preflight's --session-name — i.e. the user
    // is editing the same preflight whose state is loaded in the browser. In
    // any other case the in-memory state belongs to a different preflight
    // and writing it to this file would corrupt the saved state. We check
    // the persisted session-name marker rather than trusting in-memory
    // tracking, so the gate holds across server hot-reloads too.
    try {
      const markerPath = path.join(
        os.homedir(),
        '.agent-browser',
        `${PREFLIGHT_RECORDER_SESSION}.session-name`,
      );
      const activeName = fs.existsSync(markerPath)
        ? fs.readFileSync(markerPath, 'utf-8').trim()
        : '';
      if (activeName && activeName === nextName) {
        await persistSessionState(PREFLIGHT_RECORDER_SESSION, nextName);
      }
    } catch {
      /* best-effort — DB row is already saved, state save is a bonus */
    }

    return db.prepare('SELECT * FROM preflights WHERE id = ?').get(existing.id);
  });

  // Soft delete: row stays in the table, just hidden from listings and from
  // scenarios' dropdowns. Scenarios that still reference it via preflight_id
  // gracefully degrade — the runner looks the row up `WHERE deleted_at IS NULL`
  // and treats a miss as "no preflight". The on-disk auth.json under
  // ~/.agent-browser/sessions/<name> is intentionally left alone so an
  // accidental delete is recoverable.
  app.delete<{ Params: { id: string } }>('/api/preflights/:id', async (req, reply) => {
    const info = getDb()
      .prepare(
        `UPDATE preflights SET deleted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(Number(req.params.id));
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // --- Recorder lifecycle --------------------------------------------------
  // The "recorder" is now just the default daemon bound to a specific
  // --session-name. Recording therefore reuses the same browser scenarios
  // use, which means the preview shows it for free whenever it's alive.
  const RecorderStartBody = z.object({ name: z.string().min(1) });
  app.post('/api/preflights/recorder/start', async (req, reply) => {
    const { name } = RecorderStartBody.parse(req.body);
    try {
      // ensureSession with a sessionName mismatch closes + respawns. A match
      // is free. So clicking "Start recording" when the default daemon is
      // already bound to this preflight is essentially a no-op.
      await ensureSession(PREFLIGHT_RECORDER_SESSION, { sessionName: name });
      return { ok: true, session: PREFLIGHT_RECORDER_SESSION, sessionName: name };
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // "Stop recording" is purely a UI state today — the daemon stays alive so
  // scenarios with this preflight can reuse it for free, and so navigating
  // off /preflight doesn't tear down the browser the user was working in.
  // The in-memory state will be flushed to disk on actual daemon shutdown
  // (server restart, or a Replay/scenario that needs a different
  // --session-name).
  app.post('/api/preflights/recorder/stop', async () => {
    return { ok: true };
  });

  // --- Live exec for the recorder -----------------------------------------
  const ExecStepBody = z.object({ step: PreflightStep });
  app.post('/api/preflights/recorder/exec-step', async (req, reply) => {
    const { step } = ExecStepBody.parse(req.body);
    try {
      await executePreflightStep(PREFLIGHT_RECORDER_SESSION, step);
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // --- Replay --------------------------------------------------------------
  // Restart the recorder bound to this preflight's name (so state is restored
  // on the new daemon), then run every step from scratch. State updates from
  // the replay are persisted under the same --session-name on shutdown.
  app.post<{ Params: { id: string } }>('/api/preflights/:id/replay', async (req, reply) => {
    const row = getDb()
      .prepare(
        `SELECT name, steps_json,
                retries, retry_wait_before_ms, retry_wait_after_ms, restart_on_failure
         FROM preflights WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(Number(req.params.id)) as
      | {
          name: string;
          steps_json: string;
          retries: number;
          retry_wait_before_ms: number;
          retry_wait_after_ms: number;
          restart_on_failure: number;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });

    let steps: z.infer<typeof PreflightStep>[] = [];
    try {
      steps = JSON.parse(row.steps_json);
    } catch {
      return reply.code(500).send({ error: 'bad_steps_json' });
    }

    const policy = {
      retries: Math.max(0, row.retries ?? 0),
      retryWaitBeforeMs: Math.max(0, row.retry_wait_before_ms ?? 0),
      retryWaitAfterMs: Math.max(0, row.retry_wait_after_ms ?? 0),
    };
    const maxRestarts = Math.max(0, row.restart_on_failure ?? 0);

    // Whole-run restart loop: each attempt resets to a truly blank browser
    // (wipe persisted state, fresh daemon) and re-runs every step. Per-step
    // retries are handled inside executePreflightSteps via `policy`.
    let lastErr: any = null;
    for (let attempt = 0; attempt <= maxRestarts; attempt++) {
      try {
        // Stop the recorder daemon first so agent-browser releases its lock on
        // the state file, then wipe the persisted state so the steps re-run
        // against a truly blank browser (no leftover cookies, localStorage, or
        // IndexedDB from a previous record/replay).
        await closeSession(PREFLIGHT_RECORDER_SESSION).catch(() => undefined);
        await flushSessionState();
        clearPersistedSessionState(row.name);

        await ensureSession(PREFLIGHT_RECORDER_SESSION, { sessionName: row.name });
        await executePreflightSteps(PREFLIGHT_RECORDER_SESSION, steps, undefined, policy);

        // Replay completed → persist the freshly-built state to disk. This is
        // the ONE place (along with the Save preflight handler) that's allowed
        // to mutate the canonical auth.json: closeSession no longer auto-flushes,
        // so anything we don't save here is gone the moment the daemon dies.
        await persistSessionState(PREFLIGHT_RECORDER_SESSION, row.name);
        return { ok: true };
      } catch (e: any) {
        lastErr = e;
        // Fall through to the next attempt (which resets at the top of the loop).
      }
    }
    return reply
      .code(400)
      .send({ ok: false, error: lastErr?.message ?? String(lastErr ?? 'replay failed') });
  });
}

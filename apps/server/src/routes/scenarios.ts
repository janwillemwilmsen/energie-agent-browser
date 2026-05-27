import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ScenarioCreate, ScenarioUpdate, ViewportPreset } from '@eab/shared';
import { getDb } from '../db/index.js';

function normalizeTag(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

export async function scenariosRoutes(app: FastifyInstance) {
  app.get('/api/scenarios', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM scenarios ORDER BY updated_at DESC').all();
  });

  // Homepage data: one row per scenario with the latest run's last screenshot.
  // The last screenshot in a run reflects the *final* state captured, which is
  // what the user wants as the card thumbnail.
  app.get('/api/scenarios/cards', async () => {
    const db = getDb();
    const scenarios = db
      .prepare('SELECT * FROM scenarios ORDER BY updated_at DESC')
      .all() as Array<{ id: number }>;

    const latestRunStmt = db.prepare(
      `SELECT id, started_at, status, screenshot_paths_json
       FROM runs
       WHERE scenario_id = ? AND status IN ('success', 'failed')
       ORDER BY started_at DESC
       LIMIT 1`,
    );

    return scenarios.map((s) => {
      const run = latestRunStmt.get(s.id) as
        | { id: number; started_at: string; status: string; screenshot_paths_json: string }
        | undefined;
      let lastShot: string | null = null;
      if (run) {
        try {
          const shots = JSON.parse(run.screenshot_paths_json) as string[];
          if (Array.isArray(shots) && shots.length > 0) lastShot = shots[shots.length - 1] ?? null;
        } catch {
          /* ignore */
        }
      }
      return {
        ...s,
        latest_run_id: run?.id ?? null,
        latest_run_started_at: run?.started_at ?? null,
        latest_run_status: run?.status ?? null,
        latest_screenshot: lastShot,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const steps = db
      .prepare('SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY position')
      .all(Number(req.params.id));
    return { ...row, steps };
  });

  // Timeline data: every run for a single scenario, oldest first so the UI can
  // render left-to-right without flipping. Screenshots stay as filenames; the
  // existing /api/runs/:id/screenshots/:name endpoint serves the PNG bytes.
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/runs', async (req, reply) => {
    const scenarioId = Number(req.params.id);
    const db = getDb();
    const scenario = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'not_found' });
    return db
      .prepare(
        'SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at ASC, id ASC',
      )
      .all(scenarioId);
  });

  app.post('/api/scenarios', async (req, reply) => {
    const body = ScenarioCreate.parse(req.body);
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO scenarios (name, url, viewport_preset, brand, type)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.url,
        body.viewport_preset ?? 'desktop',
        normalizeTag(body.brand),
        normalizeTag(body.type),
      );
    return reply.code(201).send(
      db.prepare('SELECT * FROM scenarios WHERE id = ?').get(info.lastInsertRowid),
    );
  });

  app.put<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const body = ScenarioUpdate.parse(req.body);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(Number(req.params.id));
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const next = { ...(existing as any), ...body };
    db.prepare(
      `UPDATE scenarios
       SET name = ?, url = ?, viewport_preset = ?, brand = ?, type = ?,
           retries = ?, retry_wait_before_ms = ?, retry_wait_after_ms = ?, restart_on_failure = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(
      next.name,
      next.url,
      next.viewport_preset,
      normalizeTag(next.brand),
      normalizeTag(next.type),
      Math.max(0, Number(next.retries ?? 0)),
      Math.max(0, Number(next.retry_wait_before_ms ?? 0)),
      Math.max(0, Number(next.retry_wait_after_ms ?? 0)),
      Math.max(0, Number(next.restart_on_failure ?? 0)),
      Number(req.params.id),
    );

    return db.prepare('SELECT * FROM scenarios WHERE id = ?').get(Number(req.params.id));
  });

  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const db = getDb();
    const info = db.prepare('DELETE FROM scenarios WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  const StepBody = z.object({
    position: z.number().int().nonnegative(),
    kind: z.string(),
    payload: z.unknown(),
  });

  app.post<{ Params: { id: string } }>('/api/scenarios/:id/steps', async (req, reply) => {
    const { position, kind, payload } = StepBody.parse(req.body);
    const db = getDb();
    const scenario = db
      .prepare('SELECT id FROM scenarios WHERE id = ?')
      .get(Number(req.params.id));
    if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
    const info = db
      .prepare(
        `INSERT INTO scenario_steps (scenario_id, position, kind, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(Number(req.params.id), position, kind, JSON.stringify(payload ?? {}));
    return reply
      .code(201)
      .send(db.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(info.lastInsertRowid));
  });

  app.put<{ Params: { id: string; stepId: string } }>(
    '/api/scenarios/:id/steps/:stepId',
    async (req, reply) => {
      const { position, kind, payload } = StepBody.parse(req.body);
      const db = getDb();
      const info = db
        .prepare(
          `UPDATE scenario_steps
           SET position = ?, kind = ?, payload_json = ?
           WHERE id = ? AND scenario_id = ?`,
        )
        .run(
          position,
          kind,
          JSON.stringify(payload ?? {}),
          Number(req.params.stepId),
          Number(req.params.id),
        );
      if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
      return db.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(Number(req.params.stepId));
    },
  );

  app.delete<{ Params: { id: string; stepId: string } }>(
    '/api/scenarios/:id/steps/:stepId',
    async (req, reply) => {
      const db = getDb();
      const info = db
        .prepare('DELETE FROM scenario_steps WHERE id = ? AND scenario_id = ?')
        .run(Number(req.params.stepId), Number(req.params.id));
      if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    },
  );

  // Atomically swap a step's position with the neighbour above (`up`) or
  // below (`down`). No-op when already at the edge.
  const MoveBody = z.object({ direction: z.enum(['up', 'down']) });
  app.post<{ Params: { id: string; stepId: string } }>(
    '/api/scenarios/:id/steps/:stepId/move',
    async (req, reply) => {
      const { direction } = MoveBody.parse(req.body);
      const scenarioId = Number(req.params.id);
      const stepId = Number(req.params.stepId);
      const db = getDb();
      const op = direction === 'up' ? '<' : '>';
      const ord = direction === 'up' ? 'DESC' : 'ASC';

      const tx = db.transaction(() => {
        const me = db
          .prepare('SELECT * FROM scenario_steps WHERE id = ? AND scenario_id = ?')
          .get(stepId, scenarioId) as { id: number; position: number } | undefined;
        if (!me) return { moved: false, reason: 'not_found' as const };
        const neighbor = db
          .prepare(
            `SELECT id, position FROM scenario_steps
             WHERE scenario_id = ? AND position ${op} ?
             ORDER BY position ${ord}
             LIMIT 1`,
          )
          .get(scenarioId, me.position) as { id: number; position: number } | undefined;
        if (!neighbor) return { moved: false, reason: 'at_edge' as const };
        db.prepare('UPDATE scenario_steps SET position = ? WHERE id = ?').run(neighbor.position, me.id);
        db.prepare('UPDATE scenario_steps SET position = ? WHERE id = ?').run(me.position, neighbor.id);
        return { moved: true, reason: 'ok' as const };
      });
      const result = tx();
      if (result.reason === 'not_found') return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );

  // Reorder all of a scenario's steps in one shot. Body is the step ids in the
  // desired order; positions are rewritten to match (0..n-1). Rejects unless the
  // ids are exactly the scenario's current step set.
  const ReorderBody = z.object({ order: z.array(z.number().int()).min(1) });
  app.post<{ Params: { id: string } }>(
    '/api/scenarios/:id/steps/reorder',
    async (req, reply) => {
      const { order } = ReorderBody.parse(req.body);
      const scenarioId = Number(req.params.id);
      const db = getDb();

      const tx = db.transaction(() => {
        const existing = db
          .prepare('SELECT id FROM scenario_steps WHERE scenario_id = ?')
          .all(scenarioId) as { id: number }[];
        const existingIds = new Set(existing.map((s) => s.id));
        const orderSet = new Set(order);
        if (
          order.length !== existingIds.size ||
          orderSet.size !== order.length ||
          !order.every((id) => existingIds.has(id))
        ) {
          return { ok: false as const };
        }
        // Two-phase to avoid transiently colliding on the UNIQUE-ish position
        // values: park everything in a high range first, then assign 0..n-1.
        const update = db.prepare(
          'UPDATE scenario_steps SET position = ? WHERE id = ? AND scenario_id = ?',
        );
        order.forEach((id, i) => update.run(i + 1000, id, scenarioId));
        order.forEach((id, i) => update.run(i, id, scenarioId));
        return { ok: true as const };
      });

      if (!tx().ok) {
        return reply.code(400).send({ error: 'order_mismatch' });
      }
      const steps = db
        .prepare('SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY position')
        .all(scenarioId);
      return { reordered: true, steps };
    },
  );
}

export { ViewportPreset };

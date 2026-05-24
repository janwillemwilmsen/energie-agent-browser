import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ScenarioCreate, ScenarioUpdate, ViewportPreset } from '@eab/shared';
import { getDb } from '../db/index.js';

export async function scenariosRoutes(app: FastifyInstance) {
  app.get('/api/scenarios', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM scenarios ORDER BY updated_at DESC').all();
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

  app.post('/api/scenarios', async (req, reply) => {
    const body = ScenarioCreate.parse(req.body);
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO scenarios (name, url, viewport_preset)
         VALUES (?, ?, ?)`,
      )
      .run(body.name, body.url, body.viewport_preset ?? 'desktop');
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
       SET name = ?, url = ?, viewport_preset = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(next.name, next.url, next.viewport_preset, Number(req.params.id));

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
}

export { ViewportPreset };

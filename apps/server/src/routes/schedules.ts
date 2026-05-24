import type { FastifyInstance } from 'fastify';
import cron from 'node-cron';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { registerSchedule, unregisterSchedule } from '../scheduler/index.js';

const ScheduleBody = z.object({
  scenario_id: z.number().int().positive(),
  cron_expr: z.string().min(9),
  enabled: z.boolean().default(true),
});

const ScheduleUpdate = ScheduleBody.partial();

export async function schedulesRoutes(app: FastifyInstance) {
  app.get('/api/schedules', async () => {
    return getDb().prepare('SELECT * FROM schedules ORDER BY id').all();
  });

  app.post('/api/schedules', async (req, reply) => {
    const body = ScheduleBody.parse(req.body);
    if (!cron.validate(body.cron_expr)) {
      return reply.code(400).send({ error: 'invalid_cron_expr' });
    }
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO schedules (scenario_id, cron_expr, enabled)
         VALUES (?, ?, ?)`,
      )
      .run(body.scenario_id, body.cron_expr, body.enabled ? 1 : 0);
    const row = db
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(info.lastInsertRowid) as any;
    registerSchedule(row);
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => {
    const body = ScheduleUpdate.parse(req.body);
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (body.cron_expr && !cron.validate(body.cron_expr)) {
      return reply.code(400).send({ error: 'invalid_cron_expr' });
    }
    const merged = { ...existing, ...body };
    db.prepare(
      `UPDATE schedules SET scenario_id = ?, cron_expr = ?, enabled = ? WHERE id = ?`,
    ).run(merged.scenario_id, merged.cron_expr, merged.enabled ? 1 : 0, id);
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as any;
    registerSchedule(row);
    return row;
  });

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const info = getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    unregisterSchedule(id);
    return reply.code(204).send();
  });
}

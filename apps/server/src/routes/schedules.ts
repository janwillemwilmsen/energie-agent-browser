import type { FastifyInstance } from 'fastify';
import cron from 'node-cron';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { registerSchedule, unregisterSchedule, scheduleScenarioIds } from '../scheduler/index.js';

// A schedule runs an ordered chain of one or more scenarios. `scenario_ids`
// is the canonical field; the legacy single `scenario_id` is still accepted
// and treated as a one-element chain.
const ScheduleBody = z
  .object({
    scenario_id: z.number().int().positive().optional(),
    scenario_ids: z.array(z.number().int().positive()).min(1).optional(),
    cron_expr: z.string().min(9),
    enabled: z.boolean().default(true),
  })
  .refine((b) => (b.scenario_ids?.length ?? 0) > 0 || b.scenario_id != null, {
    message: 'scenario_ids (or scenario_id) is required',
  });

const ScheduleUpdate = z.object({
  scenario_id: z.number().int().positive().optional(),
  scenario_ids: z.array(z.number().int().positive()).min(1).optional(),
  cron_expr: z.string().min(9).optional(),
  enabled: z.boolean().optional(),
});

function bodyIds(body: { scenario_id?: number; scenario_ids?: number[] }): number[] | null {
  if (body.scenario_ids?.length) return body.scenario_ids;
  if (body.scenario_id != null) return [body.scenario_id];
  return null;
}

function assertScenariosExist(ids: number[]): number | null {
  const db = getDb();
  for (const id of ids) {
    if (!db.prepare('SELECT 1 FROM scenarios WHERE id = ?').get(id)) return id;
  }
  return null;
}

// API shape: rows go out with the parsed ordered chain as `scenario_ids`.
function toApi(row: any) {
  return { ...row, scenario_ids: scheduleScenarioIds(row) };
}

export async function schedulesRoutes(app: FastifyInstance) {
  // Cron expressions fire in the server's local time zone, which may differ
  // from the browser's — the UI shows this next to the schedule builder.
  app.get('/api/time', async () => {
    const now = new Date();
    return {
      now: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Minutes east of UTC (e.g. Amsterdam summer = 120).
      offsetMinutes: -now.getTimezoneOffset(),
    };
  });

  app.get('/api/schedules', async () => {
    return (getDb().prepare('SELECT * FROM schedules ORDER BY id').all() as any[]).map(toApi);
  });

  app.post('/api/schedules', async (req, reply) => {
    const body = ScheduleBody.parse(req.body);
    if (!cron.validate(body.cron_expr)) {
      return reply.code(400).send({ error: 'invalid_cron_expr' });
    }
    const ids = bodyIds(body)!;
    const missing = assertScenariosExist(ids);
    if (missing != null) {
      return reply.code(400).send({ error: 'unknown_scenario', scenario_id: missing });
    }
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO schedules (scenario_id, scenario_ids_json, cron_expr, enabled)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ids[0], JSON.stringify(ids), body.cron_expr, body.enabled ? 1 : 0);
    const row = db
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(info.lastInsertRowid) as any;
    registerSchedule(row);
    return reply.code(201).send(toApi(row));
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
    const ids = bodyIds(body) ?? scheduleScenarioIds(existing);
    const missing = assertScenariosExist(ids);
    if (missing != null) {
      return reply.code(400).send({ error: 'unknown_scenario', scenario_id: missing });
    }
    const cronExpr = body.cron_expr ?? existing.cron_expr;
    const enabled = body.enabled ?? !!existing.enabled;
    db.prepare(
      `UPDATE schedules
       SET scenario_id = ?, scenario_ids_json = ?, cron_expr = ?, enabled = ?
       WHERE id = ?`,
    ).run(ids[0], JSON.stringify(ids), cronExpr, enabled ? 1 : 0, id);
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as any;
    registerSchedule(row);
    return toApi(row);
  });

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const info = getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    unregisterSchedule(id);
    return reply.code(204).send();
  });
}

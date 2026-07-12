import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { executeScenario } from '../scenarios/runner.js';

const RunBody = z.object({ reset: z.boolean().default(false) });

export async function runsRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/run', async (req, reply) => {
    const scenarioId = Number(req.params.id);
    const { reset } = RunBody.parse(req.body ?? {});
    const db = getDb();
    const scenario = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'not_found' });

    // No session gate here: the runner (via ensureSession) starts the browser
    // session itself when it isn't running.
    // Fire-and-forget; the runner inserts the row and updates it on completion.
    const promise = executeScenario(scenarioId, { freshSession: reset }).catch((e) => {
      app.log.error({ err: e }, `Scenario ${scenarioId} execution failed`);
    });
    // Wait a tick so the runs row is created before responding (better-sqlite3 is sync).
    await new Promise((r) => setTimeout(r, 50));
    void promise;

    const latest = db
      .prepare('SELECT * FROM runs WHERE scenario_id = ? ORDER BY id DESC LIMIT 1')
      .get(scenarioId);
    return reply.code(202).send(latest);
  });

  app.get('/api/runs', async () => {
    const db = getDb();
    return db
      .prepare(
        `SELECT runs.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
         FROM runs
         LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
         ORDER BY runs.id DESC LIMIT 100`,
      )
      .all();
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.get<{ Params: { id: string; name: string } }>(
    '/api/runs/:id/screenshots/:name',
    async (req, reply) => {
      const runId = Number(req.params.id);
      const name = path.basename(req.params.name); // prevent traversal
      const filepath = path.join(config.dataDir, 'screenshots', String(runId), name);
      if (!fs.existsSync(filepath)) return reply.code(404).send({ error: 'not_found' });
      const stream = fs.createReadStream(filepath);
      reply.type('image/png');
      return reply.send(stream);
    },
  );

  app.post('/api/runs/delete', async (req, reply) => {
    const Body = z.object({ ids: z.array(z.number().int()).min(1) });
    const { ids } = Body.parse(req.body);
    const db = getDb();
    const deleted = db.transaction((runIds: number[]) => {
      const del = db.prepare('DELETE FROM runs WHERE id = ?');
      let n = 0;
      for (const id of runIds) n += del.run(id).changes;
      return n;
    })(ids);
    for (const id of ids) {
      const dir = path.join(config.dataDir, 'screenshots', String(id));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { deleted };
  });

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const runId = Number(req.params.id);
    const db = getDb();
    const info = db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    const dir = path.join(config.dataDir, 'screenshots', String(runId));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return reply.code(204).send();
  });

  app.delete('/api/runs', async (req, reply) => {
    const db = getDb();
    const rows = db.prepare('SELECT id FROM runs').all() as { id: number }[];
    db.prepare('DELETE FROM runs').run();
    for (const r of rows) {
      const dir = path.join(config.dataDir, 'screenshots', String(r.id));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return reply.code(204).send();
  });
}

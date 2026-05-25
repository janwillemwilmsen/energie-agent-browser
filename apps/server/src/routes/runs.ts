import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { executeScenario } from '../scenarios/runner.js';

function defaultSessionAlive(): boolean {
  try {
    const pid = Number(
      fs.readFileSync(path.join(os.homedir(), '.agent-browser', 'default.pid'), 'utf-8').trim(),
    );
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch {
    return false;
  }
}

export async function runsRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/run', async (req, reply) => {
    const scenarioId = Number(req.params.id);
    const db = getDb();
    const scenario = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'not_found' });

    if (!defaultSessionAlive()) {
      return reply.code(409).send({
        error: 'session_not_ready',
        message:
          'The "default" agent-browser session is not running. Use the embedded terminal on this page and click "Bootstrap default session" first.',
      });
    }

    // Fire-and-forget; the runner inserts the row and updates it on completion.
    const promise = executeScenario(scenarioId).catch((e) => {
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

import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { runStore } from '../runs/index.js';
import { startRun } from '../scenarios/runner.js';
import { ensureThumb } from '../thumbs.js';

const RunBody = z.object({ reset: z.boolean().default(false) });

export async function runsRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/run', async (req, reply) => {
    const scenarioId = Number(req.params.id);
    const { reset } = RunBody.parse(req.body ?? {});
    const scenario = getDb().prepare('SELECT id FROM scenarios WHERE id = ?').get(scenarioId);
    if (!scenario) return reply.code(404).send({ error: 'not_found' });

    // No session gate here: the runner (via ensureSession) starts the browser
    // session itself when it isn't running. The Run row exists once startRun
    // returns; the run itself continues in the background.
    const { runId, finished } = startRun(scenarioId, { freshSession: reset });
    void finished;
    return reply.code(202).send(runStore().get(runId));
  });

  app.get('/api/runs', async () => runStore().list({ limit: 100 }));

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const row = runStore().get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  // ?w=480 (and optionally &h=300) serves a cached WebP thumbnail instead of
  // the original PNG — the dashboard cards and screenshot grids render at
  // ~350-500px, so shipping the multi-MB full-page originals into them was
  // most of the page weight.
  const ShotQuery = z.object({
    w: z.coerce.number().int().min(16).max(1600).optional(),
    h: z.coerce.number().int().min(16).max(1600).optional(),
  });
  app.get<{ Params: { id: string; name: string } }>(
    '/api/runs/:id/screenshots/:name',
    async (req, reply) => {
      const runId = Number(req.params.id);
      const filepath = runStore().screenshotPath(runId, req.params.name);
      if (!filepath || !fs.existsSync(filepath)) return reply.code(404).send({ error: 'not_found' });

      // A finished run's screenshots never change (the run dir is only ever
      // deleted wholesale), so let browsers cache them forever. While the run
      // is still going, restart attempts overwrite the same filenames — force
      // revalidation instead; the Last-Modified/304 below keeps that cheap.
      const run = runStore().get(runId);
      const finished = run != null && run.status !== 'running';
      reply.header(
        'Cache-Control',
        finished ? 'public, max-age=31536000, immutable' : 'no-cache',
      );

      const { w, h } = ShotQuery.parse(req.query);
      let servePath = filepath;
      // Screenshots may be png (default), jpg/jpeg, or webp per the step's
      // configured format — label the original accordingly.
      const srcExt = path.extname(filepath).toLowerCase();
      let type =
        srcExt === '.jpg' || srcExt === '.jpeg'
          ? 'image/jpeg'
          : srcExt === '.webp'
            ? 'image/webp'
            : 'image/png';
      if (w) {
        try {
          servePath = await ensureThumb(filepath, { width: w, height: h });
          type = 'image/webp';
        } catch (e) {
          // Corrupt/unreadable source — fall back to serving the original.
          req.log.warn({ err: e, filepath }, 'thumbnail generation failed');
        }
      }

      const stat = fs.statSync(servePath);
      reply.header('Last-Modified', stat.mtime.toUTCString());
      const ims = req.headers['if-modified-since'];
      // HTTP dates carry 1s granularity, so compare with the sub-second part
      // of the file mtime dropped.
      if (ims && !Number.isNaN(Date.parse(ims)) && stat.mtimeMs < Date.parse(ims) + 1000) {
        return reply.code(304).send();
      }
      reply.type(type);
      return reply.send(fs.createReadStream(servePath));
    },
  );

  // Deleting a Run removes its row and its screenshot directory together; a
  // Run that is still going is skipped (its screenshots are being written).
  app.post('/api/runs/delete', async (req) => {
    const Body = z.object({ ids: z.array(z.number().int()).min(1) });
    const { ids } = Body.parse(req.body);
    const res = runStore().deleteRuns(ids);
    return { deleted: res.deleted, skippedRunning: res.skipped.length };
  });

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const runId = Number(req.params.id);
    if (!runStore().get(runId)) return reply.code(404).send({ error: 'not_found' });
    const res = runStore().deleteRuns([runId]);
    if (res.skipped.length) return reply.code(409).send({ error: 'run_in_progress' });
    return reply.code(204).send();
  });

  app.delete('/api/runs', async (_req, reply) => {
    runStore().deleteAll();
    return reply.code(204).send();
  });
}

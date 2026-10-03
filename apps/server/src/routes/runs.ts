import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { runStore } from '../runs/index.js';
import { startRun } from '../scenarios/runner.js';
import { abortPausedRun, listPaused, pausedRun, resumeRun } from '../scenarios/pauseRegistry.js';
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

  // Runs parked at a `pause` step right now, for the Resume/Abort buttons.
  app.get('/api/runs/paused', async () => listPaused());

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const row = runStore().get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ...row, pause: pausedRun(row.id) };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/resume', async (req, reply) => {
    if (!resumeRun(Number(req.params.id))) return reply.code(409).send({ error: 'not_paused' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/abort', async (req, reply) => {
    if (!abortPausedRun(Number(req.params.id))) return reply.code(409).send({ error: 'not_paused' });
    return { ok: true };
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

  // Text files saved by save_text steps live beside the screenshots and are
  // served the same way (path-checked by the store). Unlike screenshots they
  // are editable (PUT below), so they revalidate instead of caching forever.
  const textPath = (runId: number, name: string): string | null => {
    if (!name.endsWith('.md')) return null;
    const p = runStore().screenshotPath(runId, name);
    return p && fs.existsSync(p) ? p : null;
  };
  app.get<{ Params: { id: string; name: string } }>('/api/runs/:id/texts/:name', async (req, reply) => {
    const filepath = textPath(Number(req.params.id), req.params.name);
    if (!filepath) return reply.code(404).send({ error: 'not_found' });
    const stat = fs.statSync(filepath);
    reply.header('Cache-Control', 'no-cache');
    reply.header('Last-Modified', stat.mtime.toUTCString());
    const ims = req.headers['if-modified-since'];
    if (ims && !Number.isNaN(Date.parse(ims)) && stat.mtimeMs < Date.parse(ims) + 1000) {
      return reply.code(304).send();
    }
    reply.type('text/markdown; charset=utf-8');
    return reply.send(fs.createReadStream(filepath));
  });

  // Overwrite a saved text — e.g. to strip navigation/footer noise before the
  // Ask page feeds it to the model. Only existing files can be written, so
  // this can't create arbitrary files in a run dir.
  const TextBody = z.object({ content: z.string().max(2_000_000) });
  app.put<{ Params: { id: string; name: string } }>('/api/runs/:id/texts/:name', async (req, reply) => {
    const filepath = textPath(Number(req.params.id), req.params.name);
    if (!filepath) return reply.code(404).send({ error: 'not_found' });
    const { content } = TextBody.parse(req.body);
    fs.writeFileSync(filepath, content.replace(/\r\n/g, '\n'), 'utf-8');
    return { file: req.params.name, bytes: fs.statSync(filepath).size };
  });

  // Every text a scenario's runs saved, newest run first — the per-scenario
  // texts page. Size comes from disk so a stale row can't claim a missing file.
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/texts', async (req) => {
    const scenarioId = Number(req.params.id);
    const out: Array<{ runId: number; startedAt: string; status: string; file: string; label: string; viewport: string; bytes: number }> = [];
    for (const run of [...runStore().listForScenario(scenarioId)].reverse()) {
      for (const file of runStore().texts(run.id) ?? []) {
        const p = runStore().screenshotPath(run.id, file);
        if (!p || !fs.existsSync(p)) continue;
        const m = /^\d+-\d{8}-\d{6}-(.+)-(desktop|mobile)\.md$/i.exec(file);
        out.push({
          runId: run.id, startedAt: run.started_at, status: run.status, file,
          label: m?.[1] ?? file, viewport: m?.[2] ?? '', bytes: fs.statSync(p).size,
        });
      }
    }
    return out;
  });

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

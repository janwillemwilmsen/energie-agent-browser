import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { scopeSql } from '../projects.js';

interface RecordingRow {
  id: number;
  scenario_id: number | null;
  run_id: number | null;
  file_path: string;
  size_bytes: number | null;
  created_at: string;
}

export async function recordingsRoutes(app: FastifyInstance) {
  // List recordings joined with their scenario's name/brand/type so the
  // Recordings page can reuse the same Brand/Type filters as the Runs page.
  // `runId` narrows it to one run's clips (the run panel), however old.
  app.get<{ Querystring: { runId?: string } }>('/api/recordings', async (req) => {
    const runId = Number(req.query?.runId);
    const db = getDb();
    if (Number.isInteger(runId) && runId > 0) {
      return db
        .prepare(
          `SELECT recordings.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
           FROM recordings
           LEFT JOIN scenarios ON scenarios.id = recordings.scenario_id
           WHERE recordings.run_id = ?
           ORDER BY recordings.id ASC`,
        )
        .all(runId);
    }
    // The list follows the request's project scope (X-Project-Id; none = all).
    const { cond, params } = scopeSql(req);
    return db
      .prepare(
        `SELECT recordings.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
         FROM recordings
         LEFT JOIN scenarios ON scenarios.id = recordings.scenario_id
         WHERE ${cond}
         ORDER BY recordings.id DESC LIMIT 200`,
      )
      .all(...params);
  });

  // Run ids that have at least one clip, with the count: the Runs list marks
  // those rows without fetching every recording row.
  app.get('/api/recordings/by-run', async () => {
    const rows = getDb()
      .prepare('SELECT run_id, COUNT(*) AS n FROM recordings WHERE run_id IS NOT NULL GROUP BY run_id')
      .all() as { run_id: number; n: number }[];
    return Object.fromEntries(rows.map((r) => [String(r.run_id), r.n]));
  });

  // Stream the webm with HTTP range support — required for seeking in a <video>
  // and for Mediabunny's UrlSource (which issues range requests).
  app.get<{ Params: { id: string } }>('/api/recordings/:id/video', async (req, reply) => {
    const rec = getDb()
      .prepare('SELECT * FROM recordings WHERE id = ?')
      .get(Number(req.params.id)) as RecordingRow | undefined;
    if (!rec) return reply.code(404).send({ error: 'not_found' });

    const abs = path.join(config.dataDir, rec.file_path);
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'file_missing' });

    const stat = fs.statSync(abs);
    reply.header('Accept-Ranges', 'bytes');
    // A recording row is only inserted after its webm is fully written, and
    // the file is never rewritten afterwards — safe to cache forever.
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type('video/webm');

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end)) end = stat.size - 1;
      end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) {
        reply.code(416).header('Content-Range', `bytes */${stat.size}`);
        return reply.send();
      }
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(abs, { start, end }));
    }

    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(abs));
  });

  app.delete<{ Params: { id: string } }>('/api/recordings/:id', async (req, reply) => {
    const db = getDb();
    const rec = db
      .prepare('SELECT * FROM recordings WHERE id = ?')
      .get(Number(req.params.id)) as RecordingRow | undefined;
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
    try {
      fs.rmSync(path.join(config.dataDir, rec.file_path), { force: true });
    } catch {
      /* file already gone — the row is what mattered */
    }
    return reply.code(204).send();
  });
}

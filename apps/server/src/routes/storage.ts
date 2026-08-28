import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

// Admin → Storage. Reports how much disk the SQLite database and the on-disk
// artifacts (run screenshots, video recordings, diff images, preview/thumb
// caches, daemon logs) take up, and offers the cleanup operations that reclaim
// it: deleting individual runs/recordings, pruning old runs in bulk, dropping
// regenerable caches, removing orphaned files, and VACUUMing the database.
//
// Everything lives under config.dataDir:
//   sqlite.db (+ -wal/-shm)     the database
//   screenshots/<run_id>/*.png  run screenshots (+ thumbs/ webp cache)
//   recordings/<scenario_id>/*.webm  run videos (rows in `recordings`)
//   diffs/<artifact_id>.png     visual-diff artifacts (rows in `artifacts`)
//   preview/                    live-preview jpeg scratch
//   agent-browser-logs/         per-session daemon logs

const DATA = config.dataDir;

interface DirStats {
  bytes: number;
  files: number;
}

// Recursive size of a directory. Missing dir → zeros. Per-file stat errors
// (file vanished mid-walk, permission) are skipped rather than failing the
// whole report.
function dirStats(abs: string, opts: { skipDirNames?: Set<string> } = {}): DirStats {
  const out: DirStats = { bytes: 0, files: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) {
      if (opts.skipDirNames?.has(e.name)) continue;
      const sub = dirStats(p, opts);
      out.bytes += sub.bytes;
      out.files += sub.files;
    } else if (e.isFile()) {
      try {
        out.bytes += fs.statSync(p).size;
        out.files += 1;
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function fileSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

function listSubdirs(abs: string): string[] {
  try {
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(abs: string): string[] {
  try {
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Resolve a dataDir-relative path and make sure it can't escape `root`
// (which is itself relative to dataDir). Returns null on traversal.
function safeAbs(rel: string, root: string): string | null {
  const rootAbs = path.resolve(DATA, root);
  const abs = path.resolve(DATA, rel);
  const relToRoot = path.relative(rootAbs, abs);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
  return abs;
}

function rmrf(abs: string): void {
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    /* ignore — best effort */
  }
}

// ---- Per-area summaries --------------------------------------------------

export interface StorageGroup {
  key: string;
  label: string;
  dir: string; // relative to dataDir
  bytes: number;
  files: number;
  // Regenerable cache / scratch — safe to delete any time.
  cache?: boolean;
}

interface TableInfo {
  name: string;
  rows: number | null;
  bytes: number | null; // from dbstat (table + its indexes), null if unavailable
}

function dbReport() {
  const db = getDb();
  const dbFile = path.join(DATA, 'sqlite.db');
  const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 4096;
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0;
  const freelist = (db.pragma('freelist_count', { simple: true }) as number) ?? 0;

  const tableNames = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);

  // Per-table on-disk bytes (table b-tree + its indexes) via the dbstat
  // virtual table; better-sqlite3 ships with SQLITE_ENABLE_DBSTAT_VTAB but
  // fall back gracefully if it ever doesn't.
  const bytesByTable = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT m.tbl_name AS tbl, SUM(d.pgsize) AS bytes
         FROM dbstat d JOIN sqlite_master m ON m.name = d.name
         GROUP BY m.tbl_name`,
      )
      .all() as { tbl: string; bytes: number }[];
    for (const r of rows) bytesByTable.set(r.tbl, r.bytes);
  } catch {
    /* dbstat unavailable */
  }

  const tables: TableInfo[] = tableNames.map((name) => {
    let rows: number | null = null;
    try {
      rows = (db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n;
    } catch {
      /* ignore */
    }
    return { name, rows, bytes: bytesByTable.get(name) ?? null };
  });
  tables.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name));

  // The run log text is usually the bulk of the database — surface it.
  const logBytes =
    (db.prepare('SELECT COALESCE(SUM(LENGTH(log_text)), 0) AS n FROM runs').get() as { n: number }).n;

  return {
    file: 'sqlite.db',
    fileBytes: fileSize(dbFile),
    walBytes: fileSize(`${dbFile}-wal`),
    shmBytes: fileSize(`${dbFile}-shm`),
    pageSize,
    pageCount,
    freePages: freelist,
    // Bytes VACUUM would give back (free pages) — an estimate.
    reclaimableBytes: freelist * pageSize,
    runLogBytes: logBytes,
    tables,
  };
}

function groupsReport(): StorageGroup[] {
  const shots = dirStats(path.join(DATA, 'screenshots'), { skipDirNames: new Set(['thumbs']) });
  // Thumb caches live in screenshots/<run>/thumbs — count them separately.
  let thumbs: DirStats = { bytes: 0, files: 0 };
  for (const run of listSubdirs(path.join(DATA, 'screenshots'))) {
    const t = dirStats(path.join(DATA, 'screenshots', run, 'thumbs'));
    thumbs = { bytes: thumbs.bytes + t.bytes, files: thumbs.files + t.files };
  }
  const rec = dirStats(path.join(DATA, 'recordings'));
  const diffs = dirStats(path.join(DATA, 'diffs'));
  const preview = dirStats(path.join(DATA, 'preview'));
  const logs = dirStats(path.join(DATA, 'agent-browser-logs'));

  return [
    { key: 'screenshots', label: 'Run screenshots', dir: 'screenshots', bytes: shots.bytes, files: shots.files },
    { key: 'recordings', label: 'Video recordings', dir: 'recordings', bytes: rec.bytes, files: rec.files },
    { key: 'diffs', label: 'Diff artifacts', dir: 'diffs', bytes: diffs.bytes, files: diffs.files },
    { key: 'thumbs', label: 'Thumbnail cache', dir: 'screenshots/*/thumbs', bytes: thumbs.bytes, files: thumbs.files, cache: true },
    { key: 'preview', label: 'Live-preview scratch', dir: 'preview', bytes: preview.bytes, files: preview.files, cache: true },
    { key: 'logs', label: 'agent-browser logs', dir: 'agent-browser-logs', bytes: logs.bytes, files: logs.files, cache: true },
  ];
}

// ---- Per-item listings ---------------------------------------------------

export interface RunStorageItem {
  runId: number;
  scenarioId: number | null;
  scenarioName: string | null;
  brand: string | null;
  type: string | null;
  status: string | null; // null → orphan dir (no runs row)
  startedAt: string | null;
  bytes: number; // screenshots (excluding thumbs)
  files: number;
  thumbBytes: number;
  logBytes: number;
  recordingBytes: number; // recordings rows pointing at this run
  orphan: boolean;
}

function runsReport(): RunStorageItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT runs.id, runs.scenario_id, runs.status, runs.started_at,
              LENGTH(runs.log_text) AS log_bytes,
              scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id`,
    )
    .all() as {
    id: number;
    scenario_id: number;
    status: string;
    started_at: string;
    log_bytes: number | null;
    scenario_name: string | null;
    brand: string | null;
    type: string | null;
  }[];

  const recBytesByRun = new Map<number, number>();
  for (const r of db
    .prepare('SELECT run_id, COALESCE(SUM(size_bytes), 0) AS b FROM recordings WHERE run_id IS NOT NULL GROUP BY run_id')
    .all() as { run_id: number; b: number }[]) {
    recBytesByRun.set(r.run_id, r.b);
  }

  const shotsRoot = path.join(DATA, 'screenshots');
  const dirs = new Set(listSubdirs(shotsRoot));
  const out: RunStorageItem[] = [];

  for (const r of rows) {
    const dir = path.join(shotsRoot, String(r.id));
    const s = dirStats(dir, { skipDirNames: new Set(['thumbs']) });
    const t = dirStats(path.join(dir, 'thumbs'));
    dirs.delete(String(r.id));
    out.push({
      runId: r.id,
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name,
      brand: r.brand,
      type: r.type,
      status: r.status,
      startedAt: r.started_at,
      bytes: s.bytes,
      files: s.files,
      thumbBytes: t.bytes,
      logBytes: r.log_bytes ?? 0,
      recordingBytes: recBytesByRun.get(r.id) ?? 0,
      orphan: false,
    });
  }
  // Screenshot dirs with no matching runs row (run deleted while the rm
  // failed, or a crash mid-run before the row existed).
  for (const name of dirs) {
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(shotsRoot, name);
    const s = dirStats(dir, { skipDirNames: new Set(['thumbs']) });
    const t = dirStats(path.join(dir, 'thumbs'));
    out.push({
      runId: Number(name),
      scenarioId: null,
      scenarioName: null,
      brand: null,
      type: null,
      status: null,
      startedAt: null,
      bytes: s.bytes,
      files: s.files,
      thumbBytes: t.bytes,
      logBytes: 0,
      recordingBytes: 0,
      orphan: true,
    });
  }
  out.sort((a, b) => b.bytes + b.thumbBytes - (a.bytes + a.thumbBytes) || b.runId - a.runId);
  return out;
}

export interface RecordingStorageItem {
  id: number | null; // null → orphan file (no recordings row)
  scenarioId: number | null;
  scenarioName: string | null;
  brand: string | null;
  type: string | null;
  runId: number | null;
  filePath: string; // relative to dataDir
  bytes: number;
  createdAt: string | null;
  missing: boolean; // row exists but file is gone
  orphan: boolean;
}

function recordingsReport(): RecordingStorageItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT recordings.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM recordings LEFT JOIN scenarios ON scenarios.id = recordings.scenario_id`,
    )
    .all() as {
    id: number;
    scenario_id: number | null;
    run_id: number | null;
    file_path: string;
    size_bytes: number | null;
    created_at: string;
    scenario_name: string | null;
    brand: string | null;
    type: string | null;
  }[];

  const known = new Set<string>();
  const out: RecordingStorageItem[] = [];
  for (const r of rows) {
    const abs = path.join(DATA, r.file_path);
    known.add(path.normalize(abs));
    const exists = fs.existsSync(abs);
    out.push({
      id: r.id,
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name,
      brand: r.brand,
      type: r.type,
      runId: r.run_id,
      filePath: r.file_path,
      bytes: exists ? fileSize(abs) : 0,
      createdAt: r.created_at,
      missing: !exists,
      orphan: false,
    });
  }
  // Files on disk under recordings/ that no row points at.
  const recRoot = path.join(DATA, 'recordings');
  for (const sub of listSubdirs(recRoot)) {
    for (const f of listFiles(path.join(recRoot, sub))) {
      const abs = path.join(recRoot, sub, f);
      if (known.has(path.normalize(abs))) continue;
      let mtime: string | null = null;
      try { mtime = fs.statSync(abs).mtime.toISOString(); } catch { /* ignore */ }
      out.push({
        id: null,
        scenarioId: /^\d+$/.test(sub) ? Number(sub) : null,
        scenarioName: null,
        brand: null,
        type: null,
        runId: null,
        filePath: `recordings/${sub}/${f}`,
        bytes: fileSize(abs),
        createdAt: mtime,
        missing: false,
        orphan: true,
      });
    }
  }
  for (const f of listFiles(recRoot)) {
    const abs = path.join(recRoot, f);
    if (known.has(path.normalize(abs))) continue;
    out.push({
      id: null, scenarioId: null, scenarioName: null, brand: null, type: null, runId: null,
      filePath: `recordings/${f}`, bytes: fileSize(abs), createdAt: null, missing: false, orphan: true,
    });
  }
  out.sort((a, b) => b.bytes - a.bytes || (b.id ?? 0) - (a.id ?? 0));
  return out;
}

// Orphan diff files: PNGs under diffs/ not referenced by any artifacts row.
function orphanDiffFiles(): { abs: string; rel: string; bytes: number }[] {
  const db = getDb();
  const known = new Set(
    (db.prepare('SELECT file_path FROM artifacts').all() as { file_path: string }[]).map((r) =>
      path.normalize(path.join(DATA, r.file_path)),
    ),
  );
  const root = path.join(DATA, 'diffs');
  const out: { abs: string; rel: string; bytes: number }[] = [];
  for (const f of listFiles(root)) {
    const abs = path.join(root, f);
    if (known.has(path.normalize(abs))) continue;
    out.push({ abs, rel: `diffs/${f}`, bytes: fileSize(abs) });
  }
  return out;
}

function orphanScreenshotDirs(): { abs: string; runId: number; bytes: number }[] {
  const db = getDb();
  const ids = new Set((db.prepare('SELECT id FROM runs').all() as { id: number }[]).map((r) => r.id));
  const root = path.join(DATA, 'screenshots');
  const out: { abs: string; runId: number; bytes: number }[] = [];
  for (const name of listSubdirs(root)) {
    if (!/^\d+$/.test(name)) continue;
    const id = Number(name);
    if (ids.has(id)) continue;
    const abs = path.join(root, name);
    out.push({ abs, runId: id, bytes: dirStats(abs).bytes });
  }
  return out;
}

// Delete a set of runs: DB rows + screenshot dirs. Orphan dirs (no row) are
// removed too. Recordings deliberately survive (same as DELETE /api/runs/:id)
// unless `withRecordings` is set.
function deleteRuns(ids: number[], withRecordings: boolean): { deletedRows: number; freedBytes: number } {
  const db = getDb();
  let freed = 0;
  let deletedRows = 0;
  for (const id of ids) {
    const dir = path.join(DATA, 'screenshots', String(id));
    freed += dirStats(dir).bytes;
    if (withRecordings) {
      const recs = db
        .prepare('SELECT id, file_path FROM recordings WHERE run_id = ?')
        .all(id) as { id: number; file_path: string }[];
      for (const r of recs) {
        const abs = safeAbs(r.file_path, 'recordings');
        if (abs) {
          freed += fileSize(abs);
          rmrf(abs);
        }
        db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
      }
    }
    deletedRows += db.prepare('DELETE FROM runs WHERE id = ?').run(id).changes;
    rmrf(dir);
  }
  return { deletedRows, freedBytes: freed };
}

// ---- Routes ----------------------------------------------------------------

export async function storageRoutes(app: FastifyInstance) {
  app.get('/api/storage', async () => {
    const db = dbReport();
    const groups = groupsReport();
    const dbTotal = db.fileBytes + db.walBytes + db.shmBytes;
    const filesTotal = groups.reduce((n, g) => n + g.bytes, 0);
    const orphanDiffs = orphanDiffFiles();
    const orphanShots = orphanScreenshotDirs();
    const missingRecordings = recordingsReport().filter((r) => r.missing).length;
    return {
      dataDir: DATA,
      totalBytes: dbTotal + filesTotal,
      db,
      groups,
      orphans: {
        screenshotDirs: orphanShots.length,
        screenshotBytes: orphanShots.reduce((n, o) => n + o.bytes, 0),
        diffFiles: orphanDiffs.length,
        diffBytes: orphanDiffs.reduce((n, o) => n + o.bytes, 0),
        missingRecordingRows: missingRecordings,
      },
      generatedAt: new Date().toISOString(),
    };
  });

  app.get('/api/storage/runs', async () => runsReport());
  app.get('/api/storage/recordings', async () => recordingsReport());

  // Delete specific runs (rows + screenshot dirs; orphan dirs allowed).
  app.post('/api/storage/runs/delete', async (req) => {
    const Body = z.object({
      ids: z.array(z.number().int().positive()).min(1),
      withRecordings: z.boolean().default(false),
    });
    const { ids, withRecordings } = Body.parse(req.body);
    // Never delete a run that's still going — its screenshots are being written.
    const running = new Set(
      (getDb().prepare("SELECT id FROM runs WHERE status IN ('running','queued')").all() as { id: number }[]).map(
        (r) => r.id,
      ),
    );
    const target = ids.filter((id) => !running.has(id));
    const res = deleteRuns(target, withRecordings);
    return { ...res, skippedRunning: ids.length - target.length };
  });

  // Delete recordings by row id and/or orphan file path.
  app.post('/api/storage/recordings/delete', async (req, reply) => {
    const Body = z.object({
      ids: z.array(z.number().int().positive()).default([]),
      files: z.array(z.string().min(1)).default([]),
    });
    const { ids, files } = Body.parse(req.body);
    if (!ids.length && !files.length) return reply.code(400).send({ error: 'nothing_to_delete' });
    const db = getDb();
    let freed = 0;
    let deleted = 0;
    for (const id of ids) {
      const rec = db.prepare('SELECT id, file_path FROM recordings WHERE id = ?').get(id) as
        | { id: number; file_path: string }
        | undefined;
      if (!rec) continue;
      const abs = safeAbs(rec.file_path, 'recordings');
      if (abs) {
        freed += fileSize(abs);
        rmrf(abs);
      }
      db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
      deleted += 1;
    }
    for (const rel of files) {
      const abs = safeAbs(rel, 'recordings');
      if (!abs) return reply.code(400).send({ error: 'invalid_path', path: rel });
      // Only orphan files may be removed by path; rows go through `ids`.
      const owned = db.prepare('SELECT 1 FROM recordings WHERE file_path = ?').get(rel);
      if (owned) continue;
      freed += fileSize(abs);
      rmrf(abs);
      deleted += 1;
    }
    return { deleted, freedBytes: freed };
  });

  // Auth & session files: agent-browser's encrypted auth vault
  // (~/.agent-browser/auth/<name>.json), its persisted session states
  // (~/.agent-browser/sessions/<name>.json), and the app's own auth files in
  // dataDir. Listing only — deletion goes through the existing endpoints
  // (DELETE /api/auth-profiles/:name via the agent-browser CLI, and
  // DELETE /api/session-states/:name), so vault encryption bookkeeping and
  // selector overrides stay consistent.
  app.get('/api/storage/auth', async () => {
    const abDir = path.join(os.homedir(), '.agent-browser');

    const listJsonFiles = (dir: string) => {
      const out: { name: string; file: string; bytes: number; modifiedAt: string }[] = [];
      for (const f of listFiles(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const st = fs.statSync(path.join(dir, f));
          if (!st.isFile()) continue;
          out.push({
            name: f.slice(0, -'.json'.length),
            file: f,
            bytes: st.size,
            modifiedAt: st.mtime.toISOString(),
          });
        } catch {
          /* skip */
        }
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    };

    // Session names currently bound to a live daemon (mirror of the
    // session-states route): deleting an in-use state only takes effect after
    // that daemon restarts.
    const bound = new Set<string>();
    for (const f of listFiles(abDir)) {
      if (!f.endsWith('.session-name')) continue;
      try {
        const v = fs.readFileSync(path.join(abDir, f), 'utf-8').trim();
        if (v) bound.add(v);
      } catch {
        /* ignore */
      }
    }

    const encryptionKeyExists = fs.existsSync(path.join(abDir, '.encryption-key'));

    return {
      dir: abDir,
      profiles: listJsonFiles(path.join(abDir, 'auth')),
      sessionStates: listJsonFiles(path.join(abDir, 'sessions')).map((s) => ({
        ...s,
        inUse: bound.has(s.name),
      })),
      encryptionKeyExists,
    };
  });

  // Maintenance actions.
  app.post('/api/storage/cleanup', async (req, reply) => {
    const Body = z.object({
      action: z.enum(['thumbs', 'preview', 'logs', 'orphan-screenshots', 'orphan-diffs', 'missing-recordings', 'vacuum']),
    });
    const { action } = Body.parse(req.body);
    const db = getDb();
    let freed = 0;
    let count = 0;

    switch (action) {
      case 'thumbs': {
        const root = path.join(DATA, 'screenshots');
        for (const run of listSubdirs(root)) {
          const t = path.join(root, run, 'thumbs');
          const s = dirStats(t);
          if (!s.files) continue;
          freed += s.bytes;
          count += s.files;
          rmrf(t);
        }
        break;
      }
      case 'preview': {
        const root = path.join(DATA, 'preview');
        for (const f of listFiles(root)) {
          const abs = path.join(root, f);
          freed += fileSize(abs);
          count += 1;
          rmrf(abs);
        }
        break;
      }
      case 'logs': {
        // Live daemons may hold their log open (Windows refuses the unlink);
        // those are skipped by rmrf's force/try and simply not counted.
        const root = path.join(DATA, 'agent-browser-logs');
        for (const f of listFiles(root)) {
          const abs = path.join(root, f);
          const size = fileSize(abs);
          try {
            fs.rmSync(abs, { force: true });
            freed += size;
            count += 1;
          } catch {
            /* in use */
          }
        }
        break;
      }
      case 'orphan-screenshots': {
        for (const o of orphanScreenshotDirs()) {
          freed += o.bytes;
          count += 1;
          rmrf(o.abs);
        }
        break;
      }
      case 'orphan-diffs': {
        for (const o of orphanDiffFiles()) {
          freed += o.bytes;
          count += 1;
          rmrf(o.abs);
        }
        break;
      }
      case 'missing-recordings': {
        // Rows whose webm is gone — drop them so the Recordings page stops
        // showing dead entries.
        const rows = db.prepare('SELECT id, file_path FROM recordings').all() as { id: number; file_path: string }[];
        for (const r of rows) {
          if (fs.existsSync(path.join(DATA, r.file_path))) continue;
          db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
          count += 1;
        }
        break;
      }
      case 'vacuum': {
        const before = fileSize(path.join(DATA, 'sqlite.db')) + fileSize(path.join(DATA, 'sqlite.db-wal'));
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
          db.exec('VACUUM');
          db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (e) {
          req.log.warn({ err: e }, 'vacuum failed');
          return reply.code(500).send({ error: 'vacuum_failed', message: (e as Error).message });
        }
        const after = fileSize(path.join(DATA, 'sqlite.db')) + fileSize(path.join(DATA, 'sqlite.db-wal'));
        freed = Math.max(0, before - after);
        count = 1;
        break;
      }
    }
    return { action, count, freedBytes: freed };
  });
}

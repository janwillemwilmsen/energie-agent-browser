import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { RunStatus, ScreenshotMeta } from '@eab/shared';

// The Run module: owns the `runs` table, the per-Run screenshot directory
// (data/screenshots/<run_id>/) and the invariant that binds them — a Run and
// its directory are created together and deleted together. Routes, the
// runner, diffs, the zip export, the storage admin and the email digest are
// callers; none of them build a screenshot path or write runs SQL themselves.
//
// The seam is createRunStore({ db, dataDir }): the app builds one over its
// sqlite file; tests build one over an in-memory database and a temp dir.

export type { RunStatus };

export interface RunRow {
  id: number;
  scenario_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  log_text: string;
  screenshot_paths_json: string;
  /** Text files saved by save_text steps (filenames under the run's artifact dir). */
  text_paths_json: string;
  /** Capture metadata per screenshot (JSON array of ScreenshotMeta). */
  screenshot_meta_json: string;
}

/** A Run joined with the Scenario it belongs to (null when the Scenario is gone). */
export interface RunListRow extends RunRow {
  scenario_name: string | null;
  brand: string | null;
  type: string | null;
}

/**
 * The latest Run of one Scenario on one day, for galleries that show a day
 * per Scenario. The log is left out: it is the bulk of a Run row and no
 * gallery reads it.
 */
export type RunDayRow = Omit<RunListRow, 'log_text'> & {
  /** The UTC day the Run started, 'YYYY-MM-DD' (the date prefix of started_at). */
  day: string;
};

/**
 * What the Runs page filters on. Brands and types are the Scenario's tags;
 * an empty list means "any". All conditions combine with AND.
 */
export interface RunFilter {
  scenarioId?: number;
  brands?: string[];
  types?: string[];
  statuses?: string[];
}

export interface LatestRun {
  id: number;
  started_at: string;
  status: RunStatus;
  /** The last screenshot captured, i.e. the final state of the Run. */
  lastScreenshot: string | null;
}

export interface DeleteResult {
  /** Rows removed. Directories are removed for every id not skipped. */
  deleted: number;
  /** Ids still running; their rows and directories were left alone. */
  skipped: number[];
}

export interface RunStore {
  /** Create a running Run and its screenshot directory. */
  create(scenarioId: number): { runId: number; screenshotDir: string };
  /** Persist the whole log so far (the log is small and rewritten per line). */
  appendLog(runId: number, logText: string): void;
  finish(
    runId: number,
    status: 'success' | 'failed',
    logText: string,
    screenshots: string[],
    texts?: string[],
    screenshotMetas?: ScreenshotMeta[],
  ): void;

  get(id: number): RunRow | undefined;
  getWithScenario(id: number): RunListRow | undefined;
  /**
   * Newest first, joined with the Scenario. The filter applies BEFORE the
   * window, so `limit` is "this many of the matching runs".
   */
  list(opts?: RunFilter & { limit?: number }): RunListRow[];
  /** Every Run of one Scenario, oldest first. */
  listForScenario(scenarioId: number): RunRow[];
  /**
   * The latest Run per (Scenario, day) over the whole history, newest first —
   * every Scenario that ever ran is in here, however old its Runs. One row per
   * day a Scenario ran, so it stays small where list() would carry every Run.
   */
  listLatestPerDay(): RunDayRow[];
  /** How many Runs match the filter (all of them when none), however old. */
  count(opts?: RunFilter): number;
  /** Runs started within a sqlite datetime window such as '-1 day', newest first. */
  listStartedSince(window: string): RunListRow[];
  latestFinishedForScenario(scenarioId: number): LatestRun | undefined;
  /** Parsed screenshot filenames; [] when malformed; null when the Run does not exist. */
  screenshots(runId: number): string[] | null;
  /** The run's saved text files in capture order; null when the run doesn't exist. */
  texts(runId: number): string[] | null;
  existingIds(): Set<number>;
  inFlightIds(): Set<number>;

  screenshotsRoot(): string;
  screenshotDir(runId: number): string;
  /** Absolute path of one screenshot; null if `name` is not a plain filename. Existence is not checked. */
  screenshotPath(runId: number, name: string): string | null;

  /**
   * Delete rows and directories together, and the Runs' video recordings
   * (rows + files). Orphan directories (no row) go too. In-flight Runs are skipped.
   */
  deleteRuns(ids: number[]): DeleteResult;
  deleteAll(): DeleteResult;
}

export function parseScreenshots(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// The WHERE clause for a RunFilter, with its positional params. Lists become
// `IN (?, ?, …)`; an empty list adds no condition.
function filterSql(f: RunFilter): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const inList = (column: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return;
    conds.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  };
  if (f.scenarioId != null) {
    conds.push('runs.scenario_id = ?');
    params.push(f.scenarioId);
  }
  inList('scenarios.brand', f.brands);
  inList('scenarios.type', f.types);
  inList('runs.status', f.statuses);
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export function createRunStore(deps: { db: Database; dataDir: string }): RunStore {
  const { db, dataDir } = deps;
  const root = path.join(dataDir, 'screenshots');

  const q = {
    insert: db.prepare(
      `INSERT INTO runs (scenario_id, status, started_at) VALUES (?, 'running', CURRENT_TIMESTAMP)`,
    ),
    log: db.prepare('UPDATE runs SET log_text = ? WHERE id = ?'),
    finish: db.prepare(
      `UPDATE runs
       SET status = ?, finished_at = CURRENT_TIMESTAMP, log_text = ?, screenshot_paths_json = ?, text_paths_json = ?,
           screenshot_meta_json = ?
       WHERE id = ?`,
    ),
    get: db.prepare('SELECT * FROM runs WHERE id = ?'),
    getWithScenario: db.prepare(
      `SELECT runs.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       WHERE runs.id = ?`,
    ),
    listForScenario: db.prepare(
      'SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at ASC, id ASC',
    ),
    // started_at is a UTC 'YYYY-MM-DD HH:MM:SS' string, so date() is its day
    // prefix; the highest id on a day is that day's latest Run.
    listLatestPerDay: db.prepare(
      `SELECT runs.id, runs.scenario_id, runs.started_at, runs.finished_at, runs.status,
              runs.screenshot_paths_json, runs.text_paths_json, runs.screenshot_meta_json, date(runs.started_at) AS day,
              scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       WHERE runs.id IN (SELECT MAX(id) FROM runs GROUP BY scenario_id, date(started_at))
       ORDER BY runs.started_at DESC, runs.id DESC`,
    ),
    listSince: db.prepare(
      `SELECT runs.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       WHERE runs.started_at >= datetime('now', ?)
       ORDER BY runs.id DESC`,
    ),
    latestFinished: db.prepare(
      `SELECT id, started_at, status, screenshot_paths_json
       FROM runs
       WHERE scenario_id = ? AND status IN ('success', 'failed')
       ORDER BY started_at DESC
       LIMIT 1`,
    ),
    ids: db.prepare('SELECT id FROM runs'),
    // A run's video recordings go with the run (soft reference: no FK, so
    // this is the one place that keeps rows and files in step).
    recordingsOf: db.prepare('SELECT id, file_path FROM recordings WHERE run_id = ?'),
    deleteRecording: db.prepare('DELETE FROM recordings WHERE id = ?'),
    inFlight: db.prepare("SELECT id FROM runs WHERE status IN ('running', 'queued')"),
    delete: db.prepare('DELETE FROM runs WHERE id = ?'),
  };

  const screenshotDir = (runId: number) => path.join(root, String(runId));

  function removeDir(runId: number): void {
    try {
      fs.rmSync(screenshotDir(runId), { recursive: true, force: true });
    } catch {
      /* best effort: the storage admin reports leftovers as orphans */
    }
  }

  // Rows first (runs and their recordings, one transaction), files after:
  // a file that fails to go is an orphan the storage admin can sweep, a row
  // that outlives its file is a broken link on a page.
  const deleteIds = db.transaction((ids: number[]): { deleted: number; recordingFiles: string[] } => {
    let deleted = 0;
    const recordingFiles: string[] = [];
    for (const id of ids) {
      for (const rec of q.recordingsOf.all(id) as { id: number; file_path: string }[]) {
        q.deleteRecording.run(rec.id);
        recordingFiles.push(rec.file_path);
      }
      deleted += q.delete.run(id).changes;
    }
    return { deleted, recordingFiles };
  });

  function deleteRuns(ids: number[]): DeleteResult {
    const inFlight = inFlightIds();
    const skipped = ids.filter((id) => inFlight.has(id));
    const target = ids.filter((id) => !inFlight.has(id));
    const { deleted, recordingFiles } = deleteIds(target);
    for (const id of target) removeDir(id);
    for (const rel of recordingFiles) {
      try { fs.rmSync(path.join(dataDir, rel), { force: true }); } catch { /* orphan, swept by the storage admin */ }
    }
    return { deleted, skipped };
  }

  function inFlightIds(): Set<number> {
    return new Set((q.inFlight.all() as { id: number }[]).map((r) => r.id));
  }

  return {
    create(scenarioId) {
      const runId = Number(q.insert.run(scenarioId).lastInsertRowid);
      const dir = screenshotDir(runId);
      fs.mkdirSync(dir, { recursive: true });
      return { runId, screenshotDir: dir };
    },
    appendLog(runId, logText) {
      q.log.run(logText, runId);
    },
    finish(runId, status, logText, screenshots, texts = [], screenshotMetas = []) {
      q.finish.run(status, logText, JSON.stringify(screenshots), JSON.stringify(texts), JSON.stringify(screenshotMetas), runId);
    },

    get: (id) => q.get.get(id) as RunRow | undefined,
    getWithScenario: (id) => q.getWithScenario.get(id) as RunListRow | undefined,
    list: (opts = {}) => {
      const { where, params } = filterSql(opts);
      return db
        .prepare(
          `SELECT runs.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
           FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
           ${where}
           ORDER BY runs.id DESC LIMIT ?`,
        )
        .all(...params, opts.limit ?? 100) as RunListRow[];
    },
    count: (opts = {}) => {
      const { where, params } = filterSql(opts);
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id ${where}`)
        .get(...params) as { n: number };
      return row.n;
    },
    listForScenario: (scenarioId) => q.listForScenario.all(scenarioId) as RunRow[],
    listLatestPerDay: () => q.listLatestPerDay.all() as RunDayRow[],
    listStartedSince: (window) => q.listSince.all(window) as RunListRow[],
    latestFinishedForScenario(scenarioId) {
      const row = q.latestFinished.get(scenarioId) as
        | { id: number; started_at: string; status: RunStatus; screenshot_paths_json: string }
        | undefined;
      if (!row) return undefined;
      const shots = parseScreenshots(row.screenshot_paths_json);
      return {
        id: row.id,
        started_at: row.started_at,
        status: row.status,
        lastScreenshot: shots.length ? shots[shots.length - 1]! : null,
      };
    },
    screenshots(runId) {
      const row = q.get.get(runId) as RunRow | undefined;
      return row ? parseScreenshots(row.screenshot_paths_json) : null;
    },
    texts(runId) {
      const row = q.get.get(runId) as RunRow | undefined;
      return row ? parseScreenshots(row.text_paths_json) : null;
    },
    existingIds: () => new Set((q.ids.all() as { id: number }[]).map((r) => r.id)),
    inFlightIds,

    screenshotsRoot: () => root,
    screenshotDir,
    screenshotPath(runId, name) {
      const base = path.basename(name);
      if (!base || base !== name || base === '.' || base === '..') return null;
      return path.join(screenshotDir(runId), base);
    },

    deleteRuns,
    deleteAll() {
      const ids = (q.ids.all() as { id: number }[]).map((r) => r.id);
      return deleteRuns(ids);
    },
  };
}

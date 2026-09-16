import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

// The Run module: owns the `runs` table, the per-Run screenshot directory
// (data/screenshots/<run_id>/) and the invariant that binds them — a Run and
// its directory are created together and deleted together. Routes, the
// runner, diffs, the zip export, the storage admin and the email digest are
// callers; none of them build a screenshot path or write runs SQL themselves.
//
// The seam is createRunStore({ db, dataDir }): the app builds one over its
// sqlite file; tests build one over an in-memory database and a temp dir.

export type RunStatus = 'queued' | 'running' | 'success' | 'failed';

export interface RunRow {
  id: number;
  scenario_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  log_text: string;
  screenshot_paths_json: string;
}

/** A Run joined with the Scenario it belongs to (null when the Scenario is gone). */
export interface RunListRow extends RunRow {
  scenario_name: string | null;
  brand: string | null;
  type: string | null;
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
  finish(runId: number, status: 'success' | 'failed', logText: string, screenshots: string[]): void;

  get(id: number): RunRow | undefined;
  getWithScenario(id: number): RunListRow | undefined;
  /** Newest first, joined with the Scenario. */
  list(opts?: { limit?: number }): RunListRow[];
  /** Every Run of one Scenario, oldest first. */
  listForScenario(scenarioId: number): RunRow[];
  /** Runs started within a sqlite datetime window such as '-1 day', newest first. */
  listStartedSince(window: string): RunListRow[];
  latestFinishedForScenario(scenarioId: number): LatestRun | undefined;
  /** Parsed screenshot filenames; [] when malformed; null when the Run does not exist. */
  screenshots(runId: number): string[] | null;
  existingIds(): Set<number>;
  inFlightIds(): Set<number>;

  screenshotsRoot(): string;
  screenshotDir(runId: number): string;
  /** Absolute path of one screenshot; null if `name` is not a plain filename. Existence is not checked. */
  screenshotPath(runId: number, name: string): string | null;

  /** Delete rows and directories together. Orphan directories (no row) go too. In-flight Runs are skipped. */
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
       SET status = ?, finished_at = CURRENT_TIMESTAMP, log_text = ?, screenshot_paths_json = ?
       WHERE id = ?`,
    ),
    get: db.prepare('SELECT * FROM runs WHERE id = ?'),
    getWithScenario: db.prepare(
      `SELECT runs.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       WHERE runs.id = ?`,
    ),
    list: db.prepare(
      `SELECT runs.*, scenarios.name AS scenario_name, scenarios.brand, scenarios.type
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       ORDER BY runs.id DESC LIMIT ?`,
    ),
    listForScenario: db.prepare(
      'SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at ASC, id ASC',
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

  const deleteIds = db.transaction((ids: number[]): number => {
    let n = 0;
    for (const id of ids) n += q.delete.run(id).changes;
    return n;
  });

  function deleteRuns(ids: number[]): DeleteResult {
    const inFlight = inFlightIds();
    const skipped = ids.filter((id) => inFlight.has(id));
    const target = ids.filter((id) => !inFlight.has(id));
    const deleted = deleteIds(target);
    for (const id of target) removeDir(id);
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
    finish(runId, status, logText, screenshots) {
      q.finish.run(status, logText, JSON.stringify(screenshots), runId);
    },

    get: (id) => q.get.get(id) as RunRow | undefined,
    getWithScenario: (id) => q.getWithScenario.get(id) as RunListRow | undefined,
    list: (opts = {}) => q.list.all(opts.limit ?? 100) as RunListRow[],
    listForScenario: (scenarioId) => q.listForScenario.all(scenarioId) as RunRow[],
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

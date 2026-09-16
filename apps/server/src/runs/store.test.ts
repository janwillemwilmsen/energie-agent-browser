import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createRunStore, parseScreenshots, type RunStore } from './store.js';

// The second adapter at the Run store's seam: an in-memory database with the
// real migrations applied, and a temp data directory.
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../migrations');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf-8'));
  }
  return db;
}

let db: Database.Database;
let dataDir: string;
let store: RunStore;
let scenarioId: number;

beforeEach(() => {
  db = freshDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eab-runs-'));
  store = createRunStore({ db, dataDir });
  scenarioId = Number(
    db.prepare(`INSERT INTO scenarios (name, url, brand) VALUES ('Shop', 'https://shop.test/', 'acme')`).run().lastInsertRowid,
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Run store', () => {
  it('creates a running Run together with its screenshot directory', () => {
    const { runId, screenshotDir } = store.create(scenarioId);
    expect(screenshotDir).toBe(path.join(dataDir, 'screenshots', String(runId)));
    expect(fs.existsSync(screenshotDir)).toBe(true);
    expect(store.get(runId)?.status).toBe('running');
    expect(store.inFlightIds().has(runId)).toBe(true);
    expect(store.screenshots(runId)).toEqual([]);
  });

  it('records the log and finishes with status and screenshots', () => {
    const { runId } = store.create(scenarioId);
    store.appendLog(runId, 'line 1\nline 2');
    expect(store.get(runId)?.log_text).toBe('line 1\nline 2');
    store.finish(runId, 'success', 'line 1\nline 2\ndone', ['001-20260606-143025-home-desktop.png']);
    const row = store.get(runId)!;
    expect(row.status).toBe('success');
    expect(row.finished_at).not.toBeNull();
    expect(store.screenshots(runId)).toEqual(['001-20260606-143025-home-desktop.png']);
    expect(store.inFlightIds().has(runId)).toBe(false);
  });

  it('lists newest first, joined with the Scenario, and per Scenario oldest first', () => {
    const a = store.create(scenarioId).runId;
    const b = store.create(scenarioId).runId;
    const list = store.list();
    expect(list.map((r) => r.id)).toEqual([b, a]);
    expect(list[0]).toMatchObject({ scenario_name: 'Shop', brand: 'acme' });
    expect(store.listForScenario(scenarioId).map((r) => r.id)).toEqual([a, b]);
    expect(store.list({ limit: 1 })).toHaveLength(1);
    expect(store.listStartedSince('-1 day')).toHaveLength(2);
  });

  it('reports the latest finished Run with its final screenshot', () => {
    const a = store.create(scenarioId).runId;
    store.finish(a, 'failed', '', ['001-x-home-desktop.png', '002-x-cart-desktop.png']);
    store.create(scenarioId); // still running: not the latest *finished*
    expect(store.latestFinishedForScenario(scenarioId)).toEqual({
      id: a, started_at: expect.any(String), status: 'failed', lastScreenshot: '002-x-cart-desktop.png',
    });
    expect(store.latestFinishedForScenario(999)).toBeUndefined();
  });

  it('deletes rows and directories together, skipping in-flight Runs and sweeping orphan dirs', () => {
    const done = store.create(scenarioId).runId;
    store.finish(done, 'success', '', []);
    const running = store.create(scenarioId).runId;
    fs.mkdirSync(path.join(dataDir, 'screenshots', '777'), { recursive: true }); // orphan: no row

    const res = store.deleteRuns([done, running, 777]);
    expect(res).toEqual({ deleted: 1, skipped: [running] });
    expect(store.get(done)).toBeUndefined();
    expect(fs.existsSync(store.screenshotDir(done))).toBe(false);
    expect(store.get(running)?.status).toBe('running');
    expect(fs.existsSync(store.screenshotDir(running))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'screenshots', '777'))).toBe(false);
  });

  it('deleteAll leaves only in-flight Runs', () => {
    const a = store.create(scenarioId).runId;
    store.finish(a, 'success', '', []);
    const b = store.create(scenarioId).runId;
    expect(store.deleteAll()).toEqual({ deleted: 1, skipped: [b] });
    expect([...store.existingIds()]).toEqual([b]);
  });

  it('only resolves plain filenames inside the Run directory', () => {
    const { runId } = store.create(scenarioId);
    expect(store.screenshotPath(runId, '001-home-desktop.png')).toBe(
      path.join(dataDir, 'screenshots', String(runId), '001-home-desktop.png'),
    );
    expect(store.screenshotPath(runId, '../secret.png')).toBeNull();
    expect(store.screenshotPath(runId, 'sub/x.png')).toBeNull();
    expect(store.screenshotPath(runId, '')).toBeNull();
  });

  it('parses screenshot JSON leniently', () => {
    expect(parseScreenshots('["a.png","b.png"]')).toEqual(['a.png', 'b.png']);
    expect(parseScreenshots('not json')).toEqual([]);
    expect(parseScreenshots('{"a":1}')).toEqual([]);
    expect(parseScreenshots(null)).toEqual([]);
  });
});

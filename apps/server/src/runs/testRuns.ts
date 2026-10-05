import type { RunRow, RunStatus } from './store.js';

// Test runs: a scenario played for a look at the log only. Nothing reaches the
// database or the data directory — no `runs` row, no screenshot directory, no
// screenshots/texts/recordings (the runner skips those steps), no notification.
//
// They live in this in-memory registry under NEGATIVE ids, so the pause
// registry and the GET /api/runs/:id poll work unchanged and the ids can never
// collide with real Run rows. Only the most recent few are kept; a test run
// cannot outlive the server process, just like a paused run.

const KEEP = 20;

const runs = new Map<number, RunRow>();
let nextId = -1;

function nowSqlite(): string {
  // Same shape as sqlite's CURRENT_TIMESTAMP so the UI formats both alike.
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function isTestRunId(id: number): boolean {
  return Number.isInteger(id) && id < 0;
}

export const testRuns = {
  create(scenarioId: number): { runId: number } {
    const runId = nextId--;
    runs.set(runId, {
      id: runId,
      scenario_id: scenarioId,
      started_at: nowSqlite(),
      finished_at: null,
      status: 'running',
      log_text: '',
      screenshot_paths_json: '[]',
      text_paths_json: '[]',
    });
    for (const id of [...runs.keys()].slice(0, Math.max(0, runs.size - KEEP))) runs.delete(id);
    return { runId };
  },
  appendLog(runId: number, logText: string): void {
    const row = runs.get(runId);
    if (row) row.log_text = logText;
  },
  finish(runId: number, status: Extract<RunStatus, 'success' | 'failed'>, logText: string): void {
    const row = runs.get(runId);
    if (!row) return;
    row.status = status;
    row.finished_at = nowSqlite();
    row.log_text = logText;
  },
  get: (runId: number): RunRow | undefined => runs.get(runId),
  /** Tests only. */
  clear(): void {
    runs.clear();
    nextId = -1;
  },
};

import cron from 'node-cron';
import PQueue from 'p-queue';
import { getDb } from '../db/index.js';
import { executeScenario } from '../scenarios/runner.js';

interface ScheduleRow {
  id: number;
  scenario_id: number;
  cron_expr: string;
  enabled: number;
}

const registered = new Map<number, cron.ScheduledTask>();
const queue = new PQueue({ concurrency: 1 });

function enqueueRun(scenarioId: number, scheduleId: number): void {
  const db = getDb();
  void queue.add(async () => {
    let status: 'success' | 'failed' = 'success';
    try {
      await executeScenario(scenarioId);
    } catch (e: any) {
      status = 'failed';
      // eslint-disable-next-line no-console
      console.error(`scheduled run for scenario ${scenarioId} failed:`, e.message);
    }
    db.prepare(
      `UPDATE schedules
       SET last_run_at = CURRENT_TIMESTAMP, last_status = ?
       WHERE id = ?`,
    ).run(status, scheduleId);
  });
}

export function registerSchedule(row: ScheduleRow): void {
  unregisterSchedule(row.id);
  if (!row.enabled || !cron.validate(row.cron_expr)) return;
  const task = cron.schedule(row.cron_expr, () => enqueueRun(row.scenario_id, row.id), {
    scheduled: true,
  });
  registered.set(row.id, task);
}

export function unregisterSchedule(id: number): void {
  const t = registered.get(id);
  if (t) {
    t.stop();
    registered.delete(id);
  }
}

export function startScheduler(): void {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as ScheduleRow[];
  for (const row of rows) registerSchedule(row);
  // eslint-disable-next-line no-console
  console.log(`scheduler: registered ${rows.length} schedule(s)`);
}

export function getQueueSize(): number {
  return queue.size + queue.pending;
}

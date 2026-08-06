import cron from 'node-cron';
import PQueue from 'p-queue';
import { getDb } from '../db/index.js';
import { executeScenario } from '../scenarios/runner.js';

interface ScheduleRow {
  id: number;
  scenario_id: number;
  scenario_ids_json: string;
  cron_expr: string;
  enabled: number;
}

const registered = new Map<number, cron.ScheduledTask>();
const queue = new PQueue({ concurrency: 1 });

// Ordered chain of scenarios for a schedule. Falls back to the legacy
// scenario_id column for rows written before scenario_ids_json existed.
export function scheduleScenarioIds(row: Pick<ScheduleRow, 'scenario_id' | 'scenario_ids_json'>): number[] {
  try {
    const parsed = JSON.parse(row.scenario_ids_json);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter((n) => Number.isInteger(n) && n > 0);
    }
  } catch {
    // fall through to legacy column
  }
  return [row.scenario_id];
}

// The whole chain runs inside one queue task so its scenarios execute
// back-to-back — another schedule firing at the same moment queues up after
// the entire chain, never between two of its steps. A failing step does not
// stop the chain: the scenarios are independent checks, and one site being
// down shouldn't hide the others' results.
function enqueueChain(scenarioIds: number[], scheduleId: number): void {
  const db = getDb();
  void queue.add(async () => {
    let failed = 0;
    for (const scenarioId of scenarioIds) {
      // Scenarios can be deleted after the schedule was created; skip quietly.
      if (!db.prepare('SELECT 1 FROM scenarios WHERE id = ?').get(scenarioId)) continue;
      try {
        await executeScenario(scenarioId);
      } catch (e: any) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.error(`scheduled run for scenario ${scenarioId} failed:`, e.message);
      }
    }
    db.prepare(
      `UPDATE schedules
       SET last_run_at = CURRENT_TIMESTAMP, last_status = ?
       WHERE id = ?`,
    ).run(failed > 0 ? 'failed' : 'success', scheduleId);
  });
}

export function registerSchedule(row: ScheduleRow): void {
  unregisterSchedule(row.id);
  if (!row.enabled || !cron.validate(row.cron_expr)) return;
  const ids = scheduleScenarioIds(row);
  if (ids.length === 0) return;
  const task = cron.schedule(row.cron_expr, () => enqueueChain(ids, row.id), {
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

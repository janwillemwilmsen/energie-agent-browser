import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from './db/index.js';

// Projects: the top-level container that separates topics and brands. A
// scenario belongs to exactly one project; everything that hangs off a
// scenario (runs, screenshots, diffs, recordings, …) is scoped through it.
//
// The scope of a request is the `X-Project-Id` header: a project id narrows
// every list endpoint to that project and is the default owner of what the
// request creates; absent (or `all`) means every project — what scripts,
// curl and the admin pages get. By-id endpoints never check the header, so
// a deep link into another project still opens.

export const DEFAULT_PROJECT_ID = 1;
export const PROJECT_HEADER = 'x-project-id';

declare module 'fastify' {
  interface FastifyRequest {
    /** The project the request is scoped to, or null for all projects. */
    projectId: number | null;
  }
}

export interface ProjectRow {
  id: number;
  name: string;
  color: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Install `req.projectId` from the X-Project-Id header. */
export function projectScope(app: FastifyInstance): void {
  app.decorateRequest('projectId', null);
  app.addHook('onRequest', async (req) => {
    const raw = req.headers[PROJECT_HEADER];
    const v = Array.isArray(raw) ? raw[0] : raw;
    const n = v == null || v === '' || v === 'all' ? NaN : Number(v);
    req.projectId = Number.isInteger(n) && n > 0 ? n : null;
  });
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

/**
 * The project a create should land in: the body's explicit choice, else the
 * request's scope, else the default. An unknown id is a 400 for the caller
 * to raise (returns null).
 */
export function resolveProjectId(req: FastifyRequest, explicit: number | null | undefined): number | null {
  const id = explicit ?? req.projectId ?? DEFAULT_PROJECT_ID;
  return getProject(id) ? id : null;
}

/**
 * The `WHERE` fragment that scopes a scenario-rooted query, with its param.
 * `column` is the scenarios table's project column as visible in the query
 * (`scenarios.project_id` after a join, `project_id` on the table itself).
 */
export function scopeSql(req: FastifyRequest, column = 'scenarios.project_id'): { cond: string; params: number[] } {
  return req.projectId == null ? { cond: '1 = 1', params: [] } : { cond: `${column} = ?`, params: [req.projectId] };
}

/**
 * Keep schedules in step with their scenarios after scenarios moved: a chain
 * whose members all sit in one project takes that project; a chain that now
 * spans projects is left as it was and reported so the caller can say so.
 */
export function syncScheduleProjects(scenarioIds: number[]): { updated: number[]; mixed: number[] } {
  const db = getDb();
  const updated: number[] = [];
  const mixed: number[] = [];
  const rows = db.prepare('SELECT id, scenario_id, scenario_ids_json, project_id FROM schedules').all() as
    { id: number; scenario_id: number; scenario_ids_json: string; project_id: number }[];
  const projectOf = db.prepare('SELECT project_id FROM scenarios WHERE id = ?');
  const set = new Set(scenarioIds);
  for (const s of rows) {
    let ids: number[] = [];
    try { ids = JSON.parse(s.scenario_ids_json); } catch { /* legacy */ }
    if (!ids.length) ids = [s.scenario_id];
    if (!ids.some((id) => set.has(id))) continue;
    const projects = new Set(
      ids.map((id) => (projectOf.get(id) as { project_id: number } | undefined)?.project_id).filter((p): p is number => p != null),
    );
    if (projects.size === 1) {
      const [p] = projects;
      if (p !== s.project_id) {
        db.prepare('UPDATE schedules SET project_id = ? WHERE id = ?').run(p, s.id);
        updated.push(s.id);
      }
    } else if (projects.size > 1) {
      mixed.push(s.id);
    }
  }
  return { updated, mixed };
}

/** The distinct projects of a set of scenarios (for the "one project per chain" rule). */
export function projectsOfScenarios(ids: number[]): Set<number> {
  const q = getDb().prepare('SELECT project_id FROM scenarios WHERE id = ?');
  const out = new Set<number>();
  for (const id of ids) {
    const row = q.get(id) as { project_id: number } | undefined;
    if (row) out.add(row.project_id);
  }
  return out;
}

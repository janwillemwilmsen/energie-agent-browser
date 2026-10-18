import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { DEFAULT_PROJECT_ID, getProject, syncScheduleProjects, type ProjectRow } from '../projects.js';

// Projects CRUD (admin Projects page, the switcher) and the bulk move that
// splits an existing instance into projects by brand or type.

const Color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour').nullable().optional();
const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  color: Color,
});
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: Color,
  position: z.number().int().min(0).optional(),
});
const ReorderBody = z.object({ order: z.array(z.number().int().positive()).min(1) });
const MoveBody = z
  .object({
    scenario_ids: z.array(z.number().int().positive()).optional(),
    brand: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1).optional(),
    /** Narrow brand/type to scenarios currently in this project (default: any project). */
    from_project_id: z.number().int().positive().optional(),
  })
  .refine((b) => (b.scenario_ids?.length ?? 0) > 0 || b.brand != null || b.type != null, {
    message: 'scenario_ids, brand or type is required',
  });

function nameTaken(name: string, exceptId?: number): boolean {
  const row = getDb().prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
  return !!row && row.id !== exceptId;
}

/** Projects with what they hold, in switcher order. */
function listProjects() {
  return getDb()
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM scenarios s WHERE s.project_id = p.id) AS scenario_count,
              (SELECT COUNT(*) FROM schedules sc WHERE sc.project_id = p.id) AS schedule_count,
              (SELECT COUNT(*) FROM preflights pf WHERE pf.project_id = p.id AND pf.deleted_at IS NULL) AS preflight_count,
              (SELECT MAX(r.started_at) FROM runs r JOIN scenarios s ON s.id = r.scenario_id WHERE s.project_id = p.id) AS last_run_at
       FROM projects p
       ORDER BY p.position, p.name COLLATE NOCASE`,
    )
    .all() as (ProjectRow & { scenario_count: number; schedule_count: number; preflight_count: number; last_run_at: string | null })[];
}

export async function projectsRoutes(app: FastifyInstance) {
  app.get('/api/projects', async () => listProjects());

  app.post('/api/projects', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    if (nameTaken(body.name)) return reply.code(409).send({ error: 'name_taken', name: body.name });
    const db = getDb();
    const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM projects').get() as { n: number }).n;
    const info = db
      .prepare('INSERT INTO projects (name, color, position) VALUES (?, ?, ?)')
      .run(body.name, body.color ?? null, pos);
    return reply.code(201).send(getProject(Number(info.lastInsertRowid)));
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const body = UpdateBody.parse(req.body ?? {});
    const existing = getProject(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (body.name && nameTaken(body.name, id)) return reply.code(409).send({ error: 'name_taken', name: body.name });
    getDb()
      .prepare('UPDATE projects SET name = ?, color = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(body.name ?? existing.name, body.color === undefined ? existing.color : body.color, body.position ?? existing.position, id);
    return getProject(id);
  });

  app.post('/api/projects/reorder', async (req) => {
    const { order } = ReorderBody.parse(req.body);
    const db = getDb();
    const update = db.prepare('UPDATE projects SET position = ? WHERE id = ?');
    db.transaction(() => order.forEach((id, i) => update.run(i, id)))();
    return listProjects();
  });

  // A project goes only when empty; the Default project never goes.
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === DEFAULT_PROJECT_ID) return reply.code(409).send({ error: 'default_project' });
    const db = getDb();
    if (!getProject(id)) return reply.code(404).send({ error: 'not_found' });
    const count = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
    const holds = {
      scenarios: count('SELECT COUNT(*) AS n FROM scenarios WHERE project_id = ?'),
      schedules: count('SELECT COUNT(*) AS n FROM schedules WHERE project_id = ?'),
      threads: count('SELECT COUNT(*) AS n FROM ask_threads WHERE project_id = ?'),
    };
    if (holds.scenarios || holds.schedules || holds.threads) {
      return reply.code(409).send({ error: 'not_empty', ...holds });
    }
    // Preflights scoped to it become shared (the FK's SET NULL).
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return reply.code(204).send();
  });

  // Move scenarios here — by explicit ids, or every scenario with a brand
  // and/or type (the way an existing instance gets split up). Their runs,
  // screenshots, diffs and recordings follow by construction; schedules whose
  // whole chain moved follow too, chains that now span projects are reported.
  app.post<{ Params: { id: string } }>('/api/projects/:id/move-scenarios', async (req, reply) => {
    const target = Number(req.params.id);
    if (!getProject(target)) return reply.code(404).send({ error: 'not_found' });
    const body = MoveBody.parse(req.body);
    const db = getDb();
    let ids: number[];
    if (body.scenario_ids?.length) {
      ids = body.scenario_ids;
    } else {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (body.brand != null) { conds.push('brand = ? COLLATE NOCASE'); params.push(body.brand); }
      if (body.type != null) { conds.push('type = ? COLLATE NOCASE'); params.push(body.type); }
      if (body.from_project_id != null) { conds.push('project_id = ?'); params.push(body.from_project_id); }
      ids = (db.prepare(`SELECT id FROM scenarios WHERE ${conds.join(' AND ')}`).all(...params) as { id: number }[]).map((r) => r.id);
    }
    const update = db.prepare('UPDATE scenarios SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id <> ?');
    const moved = db.transaction(() => ids.reduce((n, id) => n + update.run(target, id, target).changes, 0))();
    const schedules = syncScheduleProjects(ids);
    return { moved, scenario_ids: ids, schedules };
  });
}

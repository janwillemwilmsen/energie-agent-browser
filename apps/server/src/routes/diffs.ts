import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { diffPngFiles, readPngSize } from '../diff/pixelDiff.js';

interface ArtifactRow {
  id: number;
  kind: 'run_screenshot' | 'diff';
  file_path: string;
  scenario_id: number | null;
  source_run_id: number | null;
  label: string | null;
  viewport: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

interface ComparisonRow {
  id: number;
  scenario_id: number | null;
  baseline_artifact_id: number;
  target_artifact_id: number;
  diff_artifact_id: number | null;
  threshold: number;
  mismatch_ratio: number | null;
  status: string;
  note: string | null;
  created_at: string;
}

const ArtifactRef = z.union([
  z.object({ artifactId: z.number().int().positive() }),
  z.object({ runId: z.number().int().positive(), slot: z.string().min(1) }),
]);

const CreateComparison = z.object({
  scenarioId: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).default(0.1),
  baseline: ArtifactRef,
  target: ArtifactRef,
});

const CompareRuns = z.object({
  baselineRunId: z.number().int().positive(),
  targetRunId: z.number().int().positive(),
  threshold: z.number().min(0).max(1).default(0.1),
});

const DATA = config.dataDir;
const DIFF_DIR = 'diffs'; // relative to dataDir

function absPath(rel: string): string {
  return path.join(DATA, rel);
}

function viewportFromSlot(slot: string): string | null {
  const base = slot.replace(/\.png$/i, '');
  const idx = base.lastIndexOf('-');
  return idx >= 0 ? base.slice(idx + 1) : null;
}

function getArtifact(id: number): ArtifactRow | undefined {
  return getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
}

// Copy a run screenshot into artifact-owned storage so the comparison survives
// deletion of the source run. Deduped by (source_run_id, label) so repeated
// comparisons reuse the same copy.
function materializeRunScreenshot(runId: number, slot: string, scenarioId: number | null): ArtifactRow {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM artifacts WHERE kind='run_screenshot' AND source_run_id = ? AND label = ?")
    .get(runId, slot) as ArtifactRow | undefined;
  if (existing && fs.existsSync(absPath(existing.file_path))) return existing;

  const safeSlot = path.basename(slot);
  const src = path.join(DATA, 'screenshots', String(runId), safeSlot);
  if (!fs.existsSync(src)) {
    throw Object.assign(new Error(`screenshot not found: run ${runId} / ${safeSlot}`), { statusCode: 404 });
  }
  const size = readPngSize(src);
  const info = db
    .prepare(
      `INSERT INTO artifacts (kind, file_path, scenario_id, source_run_id, label, viewport, width, height)
       VALUES ('run_screenshot', '', ?, ?, ?, ?, ?, ?)`,
    )
    .run(scenarioId, runId, safeSlot, viewportFromSlot(safeSlot), size.width, size.height);
  const id = Number(info.lastInsertRowid);
  const rel = `${DIFF_DIR}/${id}.png`;
  fs.mkdirSync(absPath(DIFF_DIR), { recursive: true });
  fs.copyFileSync(src, absPath(rel));
  db.prepare('UPDATE artifacts SET file_path = ? WHERE id = ?').run(rel, id);
  return getArtifact(id)!;
}

function resolveRef(ref: z.infer<typeof ArtifactRef>, scenarioId: number | null): ArtifactRow {
  if ('artifactId' in ref) {
    const a = getArtifact(ref.artifactId);
    if (!a) throw Object.assign(new Error(`artifact ${ref.artifactId} not found`), { statusCode: 404 });
    if (!fs.existsSync(absPath(a.file_path))) {
      throw Object.assign(new Error(`artifact ${ref.artifactId} image missing on disk`), { statusCode: 410 });
    }
    return a;
  }
  return materializeRunScreenshot(ref.runId, ref.slot, scenarioId);
}

// Run the pixel diff for two resolved artifacts, persist the diff image as a
// new artifact, and insert the comparison row. Returns the comparison id.
function createComparison(
  baseline: ArtifactRow,
  target: ArtifactRow,
  scenarioId: number | null,
  threshold: number,
): number {
  const db = getDb();
  // Insert diff artifact row first to get its id (→ stable file path).
  const diffInfo = db
    .prepare(
      `INSERT INTO artifacts (kind, file_path, scenario_id, source_run_id, label, viewport)
       VALUES ('diff', '', ?, NULL, ?, ?)`,
    )
    .run(scenarioId, baseline.label ?? null, baseline.viewport ?? null);
  const diffArtifactId = Number(diffInfo.lastInsertRowid);
  const diffRel = `${DIFF_DIR}/${diffArtifactId}.png`;
  fs.mkdirSync(absPath(DIFF_DIR), { recursive: true });

  const result = diffPngFiles(
    absPath(baseline.file_path),
    absPath(target.file_path),
    absPath(diffRel),
    threshold,
  );

  db.prepare('UPDATE artifacts SET file_path = ?, width = ?, height = ? WHERE id = ?').run(
    diffRel,
    result.baselineWidth,
    result.baselineHeight,
    diffArtifactId,
  );

  const cmpInfo = db
    .prepare(
      `INSERT INTO comparisons
         (scenario_id, baseline_artifact_id, target_artifact_id, diff_artifact_id, threshold, mismatch_ratio, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scenarioId,
      baseline.id,
      target.id,
      diffArtifactId,
      threshold,
      result.ratio,
      result.status,
      result.note ?? null,
    );
  return Number(cmpInfo.lastInsertRowid);
}

function enrichComparison(c: ComparisonRow) {
  return {
    ...c,
    baseline: getArtifact(c.baseline_artifact_id) ?? null,
    target: getArtifact(c.target_artifact_id) ?? null,
    diff: c.diff_artifact_id != null ? getArtifact(c.diff_artifact_id) ?? null : null,
  };
}

// Delete an artifact's row + file only if no comparison still references it.
// (FKs would otherwise cascade-delete those comparisons.)
function tryDeleteArtifact(id: number): void {
  const db = getDb();
  const refs = db
    .prepare(
      'SELECT COUNT(*) AS n FROM comparisons WHERE baseline_artifact_id = ? OR target_artifact_id = ? OR diff_artifact_id = ?',
    )
    .get(id, id, id) as { n: number };
  if (refs.n > 0) return;
  const a = getArtifact(id);
  if (!a) return;
  try { fs.rmSync(absPath(a.file_path), { force: true }); } catch { /* ignore */ }
  db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
}

export async function diffsRoutes(app: FastifyInstance) {
  // Serve any artifact image (run-screenshot copy or diff output).
  app.get<{ Params: { id: string } }>('/api/artifacts/:id/image', async (req, reply) => {
    const a = getArtifact(Number(req.params.id));
    if (!a) return reply.code(404).send({ error: 'not_found' });
    const abs = absPath(a.file_path);
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'file_missing' });
    reply.type('image/png');
    return reply.send(fs.createReadStream(abs));
  });

  app.get<{ Querystring: { scenario_id?: string } }>('/api/comparisons', async (req) => {
    const db = getDb();
    const sid = req.query.scenario_id ? Number(req.query.scenario_id) : null;
    const rows = (
      sid != null
        ? db.prepare('SELECT * FROM comparisons WHERE scenario_id = ? ORDER BY id DESC LIMIT 200').all(sid)
        : db.prepare('SELECT * FROM comparisons ORDER BY id DESC LIMIT 200').all()
    ) as ComparisonRow[];
    return rows.map(enrichComparison);
  });

  app.get<{ Params: { id: string } }>('/api/comparisons/:id', async (req, reply) => {
    const row = getDb().prepare('SELECT * FROM comparisons WHERE id = ?').get(Number(req.params.id)) as
      | ComparisonRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return enrichComparison(row);
  });

  app.post('/api/comparisons', async (req, reply) => {
    const body = CreateComparison.parse(req.body);
    try {
      const baseline = resolveRef(body.baseline, body.scenarioId ?? null);
      const target = resolveRef(body.target, body.scenarioId ?? null);
      const id = createComparison(baseline, target, body.scenarioId ?? null, body.threshold);
      const row = getDb().prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow;
      return reply.code(201).send(enrichComparison(row));
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: 'comparison_failed', message: e.message });
    }
  });

  // Batch: pair two runs by slot key (the screenshot filename) and diff each
  // matching pair. Returns created comparisons plus the unmatched slots.
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/compare-runs', async (req, reply) => {
    const scenarioId = Number(req.params.id);
    const body = CompareRuns.parse(req.body);
    const db = getDb();

    const baseRun = db.prepare('SELECT screenshot_paths_json FROM runs WHERE id = ?').get(body.baselineRunId) as
      | { screenshot_paths_json: string }
      | undefined;
    const targetRun = db.prepare('SELECT screenshot_paths_json FROM runs WHERE id = ?').get(body.targetRunId) as
      | { screenshot_paths_json: string }
      | undefined;
    if (!baseRun || !targetRun) return reply.code(404).send({ error: 'run_not_found' });

    const parse = (s: string): string[] => {
      try { return JSON.parse(s) as string[]; } catch { return []; }
    };
    const baseSlots = parse(baseRun.screenshot_paths_json);
    const targetSlots = parse(targetRun.screenshot_paths_json);

    // The leading NNN- prefix is `step.position`, which shifts whenever the
    // scenario is edited (inserting a step bumps every later position), and the
    // optional YYYYMMDD-HHMMSS block is the per-run creation stamp. Strip both
    // and pair on the stable suffix — `<label>-<viewport>.png` — so the same
    // logical screenshot still matches across runs (incl. older, un-stamped ones).
    const canonical = (slot: string): string => slot.replace(/^\d+-(?:\d{8}-\d{6}-)?/, '');
    const targetByKey = new Map<string, string>();
    for (const t of targetSlots) {
      const k = canonical(t);
      if (!targetByKey.has(k)) targetByKey.set(k, t);
    }

    const created: unknown[] = [];
    const matched: string[] = [];
    const matchedKeys = new Set<string>();
    for (const slot of baseSlots) {
      const key = canonical(slot);
      const targetSlot = targetByKey.get(key);
      if (!targetSlot) continue;
      try {
        const baseline = materializeRunScreenshot(body.baselineRunId, slot, scenarioId);
        const target = materializeRunScreenshot(body.targetRunId, targetSlot, scenarioId);
        const id = createComparison(baseline, target, scenarioId, body.threshold);
        const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow;
        created.push(enrichComparison(row));
        matched.push(slot);
        matchedKeys.add(key);
      } catch (e: any) {
        app.log.error({ err: e, slot }, 'compare-runs slot failed');
      }
    }

    const onlyBaseline = baseSlots.filter((s) => !matchedKeys.has(canonical(s)));
    const onlyTarget = targetSlots.filter((s) => !matchedKeys.has(canonical(s)));
    return reply.code(201).send({ created, matched, onlyBaseline, onlyTarget });
  });

  app.delete<{ Params: { id: string } }>('/api/comparisons/:id', async (req, reply) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM comparisons WHERE id = ?').run(id);
    // Clean up artifacts that are now unreferenced (won't touch ones still in
    // use as inputs to other comparisons — e.g. a diff being re-diffed).
    if (row.diff_artifact_id != null) tryDeleteArtifact(row.diff_artifact_id);
    tryDeleteArtifact(row.baseline_artifact_id);
    tryDeleteArtifact(row.target_artifact_id);
    return reply.code(204).send();
  });
}

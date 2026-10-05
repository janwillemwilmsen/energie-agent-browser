import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { runStore } from '../runs/index.js';
import { askModel, listGatewayModelsDetailed, streamChat, type ChatMessage, type Usage } from '../ask/llm.js';
import { ASK_SYSTEM_PROMPT, assetKey, buildPacks, packToContent, pickRun, screenshotUrl } from '../ask/context.js';
import { createPreset, deletePreset, listPresets, updatePreset } from '../ask/presets.js';

// Ask: chat threads that review one or more scenarios with the LLM.
//
// GET    /api/ask/scenarios              scenarios with their reviewable run, for the picker
// GET    /api/ask/models                 gateway models for the picker (vision flag), + the default
// GET/POST/PUT/DELETE /api/ask/presets   editable preset prompts
// GET    /api/ask/threads                thread list
// POST   /api/ask/threads                { title?, scenarioIds, runIds?, model? } → thread
// GET    /api/ask/threads/:id            thread + messages + context preview (no images)
// PUT    /api/ask/threads/:id            { title?, model? } (model '' → follow the admin default)
// DELETE /api/ask/threads/:id
// POST   /api/ask/threads/:id/messages   { text } → SSE stream of the assistant reply
//
// The context pack (step narrative + tiled screenshots) rides on the FIRST
// user turn only; later turns are text against the same conversation. The
// images are re-derived from the pinned runs on every call rather than
// stored, so a thread costs a few KB in the DB.

interface ThreadRow {
  id: number; title: string; scenario_ids_json: string; run_ids_json: string; model: string;
  excluded_json: string; created_at: string; updated_at: string;
}
interface MessageRow {
  id: number; thread_id: number; role: 'user' | 'assistant'; text: string; with_context: number;
  usage_json: string | null; error: string | null; created_at: string;
  /** The model that generated an assistant turn; '' on user turns and pre-026 rows. */
  model: string;
}

const CreateBody = z.object({
  title: z.string().trim().max(200).optional(),
  scenarioIds: z.array(z.number().int().positive()).min(1).max(6),
  runIds: z.array(z.number().int().positive().nullable()).optional(),
  model: z.string().trim().max(200).optional(),
});
const UpdateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().max(200).optional(),
  // "<runId>/<file>" keys of assets removed from the context.
  excluded: z.array(z.string().max(300)).max(500).optional(),
});
const MessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });
const PresetBody = z.object({
  label: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8_000),
});
const PresetPatch = PresetBody.partial().extend({ position: z.number().int().min(0).optional() });

/** The model a thread runs on: its own choice, else the admin default at call time. */
function threadModel(t: ThreadRow): string {
  return t.model || askModel().model;
}

function threadOut(t: ThreadRow) {
  return {
    id: t.id,
    title: t.title,
    scenarioIds: JSON.parse(t.scenario_ids_json) as number[],
    runIds: JSON.parse(t.run_ids_json) as (number | null)[],
    // '' = follows the admin default; effectiveModel is what a message would use now.
    model: t.model,
    effectiveModel: t.model || askModel().model,
    excluded: JSON.parse(t.excluded_json || '[]') as string[],
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function messageOut(m: MessageRow) {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    withContext: !!m.with_context,
    usage: m.usage_json ? (JSON.parse(m.usage_json) as Usage) : null,
    model: m.model || null,
    error: m.error,
    createdAt: m.created_at,
  };
}

export async function askRoutes(app: FastifyInstance) {
  app.get('/api/ask/scenarios', async () => {
    const rows = getDb()
      .prepare('SELECT id, name, url, brand, type, viewport_preset FROM scenarios ORDER BY name COLLATE NOCASE')
      .all() as { id: number; name: string; url: string; brand: string | null; type: string | null; viewport_preset: string }[];
    return rows.map((s) => {
      const runId = pickRun(s.id);
      const run = runId ? runStore().get(runId) : undefined;
      const shots = runId ? (runStore().screenshots(runId) ?? []) : [];
      return {
        ...s,
        run: run
          ? { id: run.id, status: run.status, startedAt: run.started_at, screenshots: shots.length,
              thumb: shots.length ? screenshotUrl(run.id, shots[shots.length - 1]!, 320) : null }
          : null,
      };
    });
  });

  app.get('/api/ask/models', async () => {
    const def = askModel();
    try {
      return { models: await listGatewayModelsDetailed(), default: def.model, defaultSource: def.source };
    } catch {
      return { models: [], default: def.model, defaultSource: def.source };
    }
  });

  app.get('/api/ask/presets', async () => listPresets());
  app.post('/api/ask/presets', async (req, reply) => {
    const b = PresetBody.parse(req.body);
    return reply.code(201).send(createPreset(b.label, b.prompt));
  });
  app.put<{ Params: { id: string } }>('/api/ask/presets/:id', async (req, reply) => {
    const p = updatePreset(Number(req.params.id), PresetPatch.parse(req.body));
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return p;
  });
  app.delete<{ Params: { id: string } }>('/api/ask/presets/:id', async (req, reply) => {
    if (!deletePreset(Number(req.params.id))) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.get('/api/ask/threads', async () => {
    const rows = getDb()
      .prepare(
        `SELECT t.*, (SELECT count(*) FROM ask_messages m WHERE m.thread_id = t.id) AS message_count,
                (SELECT text FROM ask_messages m WHERE m.thread_id = t.id AND m.role = 'assistant' ORDER BY id DESC LIMIT 1) AS last_reply
         FROM ask_threads t ORDER BY t.updated_at DESC, t.id DESC`,
      )
      .all() as (ThreadRow & { message_count: number; last_reply: string | null })[];
    return rows.map((t) => ({ ...threadOut(t), messageCount: t.message_count, lastReply: (t.last_reply ?? '').slice(0, 160) }));
  });

  app.post('/api/ask/threads', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const db = getDb();
    const names = body.scenarioIds
      .map((id) => (db.prepare('SELECT name FROM scenarios WHERE id = ?').get(id) as { name: string } | undefined)?.name)
      .filter((n): n is string => !!n);
    if (names.length !== body.scenarioIds.length) return reply.code(404).send({ error: 'scenario_not_found' });
    const runIds = body.scenarioIds.map((sid, i) => pickRun(sid, body.runIds?.[i] ?? null));
    const info = db
      .prepare('INSERT INTO ask_threads (title, scenario_ids_json, run_ids_json, model) VALUES (?, ?, ?, ?)')
      .run(body.title || names.join(' vs '), JSON.stringify(body.scenarioIds), JSON.stringify(runIds), body.model ?? '');
    const row = db.prepare('SELECT * FROM ask_threads WHERE id = ?').get(info.lastInsertRowid) as ThreadRow;
    return reply.code(201).send(threadOut(row));
  });

  app.get<{ Params: { id: string } }>('/api/ask/threads/:id', async (req, reply) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM ask_threads WHERE id = ?').get(Number(req.params.id)) as ThreadRow | undefined;
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const thread = threadOut(t);
    const messages = (db.prepare('SELECT * FROM ask_messages WHERE thread_id = ? ORDER BY id').all(t.id) as MessageRow[]).map(messageOut);
    // Context preview: what the first turn sends, minus the image bytes. The
    // UI shows it as chips + a thumbnail strip. Lists EVERY asset of the run,
    // with the excluded ones flagged, so a removed asset can be restored.
    const excludedSet = new Set(thread.excluded);
    const packs = await buildPacks(thread.scenarioIds, thread.runIds, { withImages: false });
    const context = packs.map((p) => {
      const runId = p.runId;
      const asset = (file: string) => ({ file, key: runId ? assetKey(runId, file) : file, excluded: runId ? excludedSet.has(assetKey(runId, file)) : false });
      return {
        scenarioId: p.scenarioId, name: p.name, url: p.url, viewport: p.viewport,
        runId, runStatus: p.runStatus, runStartedAt: p.runStartedAt,
        steps: p.steps,
        screenshots: (runId ? runStore().screenshots(runId) ?? [] : []).map((f) => ({
          ...asset(f), thumb: runId ? screenshotUrl(runId, f, 240) : null, url: runId ? `/api/runs/${runId}/screenshots/${encodeURIComponent(f)}` : null,
        })),
        texts: (runId ? runStore().texts(runId) ?? [] : []).map((f) => {
          const path = runId ? runStore().screenshotPath(runId, f) : null;
          let bytes = 0;
          try { if (path) bytes = fs.statSync(path).size; } catch { /* missing file: listed with 0 bytes */ }
          return { ...asset(f), bytes, url: runId ? `/api/runs/${runId}/texts/${encodeURIComponent(f)}` : null };
        }),
      };
    });
    return { ...thread, messages, context };
  });

  app.put<{ Params: { id: string } }>('/api/ask/threads/:id', async (req, reply) => {
    const b = UpdateBody.parse(req.body);
    const db = getDb();
    const t = db.prepare('SELECT * FROM ask_threads WHERE id = ?').get(Number(req.params.id)) as ThreadRow | undefined;
    if (!t) return reply.code(404).send({ error: 'not_found' });
    db.prepare('UPDATE ask_threads SET title = ?, model = ?, excluded_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(b.title ?? t.title, b.model ?? t.model, b.excluded ? JSON.stringify(b.excluded) : t.excluded_json, t.id);
    return threadOut(db.prepare('SELECT * FROM ask_threads WHERE id = ?').get(t.id) as ThreadRow);
  });

  app.delete<{ Params: { id: string } }>('/api/ask/threads/:id', async (req, reply) => {
    const info = getDb().prepare('DELETE FROM ask_threads WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/ask/threads/:id/messages', async (req, reply) => {
    const { text } = MessageBody.parse(req.body);
    const db = getDb();
    const t = db.prepare('SELECT * FROM ask_threads WHERE id = ?').get(Number(req.params.id)) as ThreadRow | undefined;
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const thread = threadOut(t);
    const history = db.prepare('SELECT * FROM ask_messages WHERE thread_id = ? ORDER BY id').all(t.id) as MessageRow[];
    const firstTurn = !history.some((m) => m.role === 'user' && m.with_context);

    // Persist the user turn first so a crash mid-stream still leaves the
    // question in the thread.
    const userInfo = db
      .prepare('INSERT INTO ask_messages (thread_id, role, text, with_context) VALUES (?, ?, ?, ?)')
      .run(t.id, 'user', text, firstTurn ? 1 : 0);
    const userMessageId = Number(userInfo.lastInsertRowid);

    // Assemble the conversation. The context pack is rebuilt for the turn
    // that carried it (the first), so follow-ups keep seeing the screenshots.
    const messages: ChatMessage[] = [{ role: 'system', content: ASK_SYSTEM_PROMPT }];
    let packsAttached = false;
    for (const m of [...history, { role: 'user' as const, text, with_context: firstTurn ? 1 : 0, error: null }]) {
      if (m.error) continue; // a failed assistant turn is not part of the conversation
      if (m.role === 'user' && m.with_context && !packsAttached) {
        const packs = await buildPacks(thread.scenarioIds, thread.runIds, { excluded: new Set(thread.excluded) });
        messages.push({ role: 'user', content: packToContent(packs, m.text) });
        packsAttached = true;
      } else {
        messages.push({ role: m.role, content: m.text });
      }
    }

    // SSE. Hijack the reply so Fastify leaves the raw socket to us.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj: unknown) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
    send({ userMessageId });

    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());

    // Resolved per call: the thread's own model if one was picked, else the
    // admin default at this moment.
    const model = threadModel(t);
    let full = '';
    let usage: Usage | undefined;
    let error: string | null = null;
    try {
      for await (const ev of streamChat(model, messages, { signal: abort.signal })) {
        if (ev.delta) { full += ev.delta; send({ delta: ev.delta }); }
        if (ev.usage) usage = ev.usage;
      }
    } catch (e: any) {
      error = abort.signal.aborted ? 'cancelled' : (e?.message ?? String(e));
    }
    const asstInfo = db
      .prepare('INSERT INTO ask_messages (thread_id, role, text, usage_json, error, model) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.id, 'assistant', full, usage ? JSON.stringify(usage) : null, error, model);
    db.prepare('UPDATE ask_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(t.id);
    send({ done: true, messageId: Number(asstInfo.lastInsertRowid), usage: usage ?? null, model, error });
    res.end();
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  agentAvailable,
  startAgentJob,
  getJob,
  hasActiveJob,
  currentModel,
  setModelSetting,
  listGatewayModels,
  DEFAULT_MODEL,
} from '../agent/scenarioAgent.js';

const StartBody = z.object({ prompt: z.string().trim().min(1).max(4000) });
const ModelBody = z.object({ model: z.string().trim().max(200) });

export async function agentTasksRoutes(app: FastifyInstance) {
  // Feature detection for the UI (button disabled without a gateway key).
  app.get('/api/agent-tasks/availability', async () => ({
    available: agentAvailable(),
    busy: hasActiveJob(),
  }));

  app.post<{ Params: { id: string } }>('/api/scenarios/:id/agent-task', async (req, reply) => {
    const { prompt } = StartBody.parse(req.body);
    const scenarioId = Number(req.params.id);
    const exists = getDb().prepare('SELECT id FROM scenarios WHERE id = ?').get(scenarioId);
    if (!exists) return reply.code(404).send({ error: 'scenario_not_found' });
    try {
      const job = startAgentJob(scenarioId, prompt);
      return reply.code(202).send({ jobId: job.id });
    } catch (e: any) {
      return reply.code(409).send({ error: 'agent_unavailable', message: e?.message ?? String(e) });
    }
  });

  // Prompt history for a scenario — newest first. Powers the modal's
  // "previous prompts" list so a task can be inspected and re-run.
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/agent-prompts', async (req) => {
    return getDb()
      .prepare(
        `SELECT id, prompt, model, status, steps_added, created_at
         FROM agent_prompts WHERE scenario_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 20`,
      )
      .all(Number(req.params.id));
  });

  // Delete one saved prompt.
  app.delete<{ Params: { promptId: string } }>('/api/agent-prompts/:promptId', async (req, reply) => {
    const info = getDb()
      .prepare('DELETE FROM agent_prompts WHERE id = ?')
      .run(Number(req.params.promptId));
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Clear a scenario's whole prompt history.
  app.delete<{ Params: { id: string } }>('/api/scenarios/:id/agent-prompts', async (req) => {
    const info = getDb()
      .prepare('DELETE FROM agent_prompts WHERE scenario_id = ?')
      .run(Number(req.params.id));
    return { deleted: info.changes };
  });

  // --- Admin: model selection -------------------------------------------------
  app.get('/api/admin/ai-settings', async () => {
    const { model, source } = currentModel();
    return {
      model,
      source, // 'setting' (DB) | 'env' (AI_GATEWAY_MODEL) | 'default'
      defaultModel: DEFAULT_MODEL,
      envModel: process.env.AI_GATEWAY_MODEL ?? null,
      available: agentAvailable(),
    };
  });

  app.put('/api/admin/ai-settings', async (req) => {
    const { model } = ModelBody.parse(req.body);
    setModelSetting(model || null); // empty string → clear override (back to env/default)
    const now = currentModel();
    return { model: now.model, source: now.source };
  });

  // Gateway model catalog for the admin dropdown. Best-effort: a gateway error
  // returns an empty list and the UI falls back to free-text entry.
  app.get('/api/admin/ai-models', async () => {
    if (!agentAvailable()) return { models: [] };
    try {
      return { models: await listGatewayModels() };
    } catch {
      return { models: [] };
    }
  });

  app.get<{ Params: { jobId: string } }>('/api/agent-tasks/:jobId', async (req, reply) => {
    const job = getJob(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return {
      id: job.id,
      scenarioId: job.scenarioId,
      status: job.status,
      log: job.log,
      stepsAdded: job.stepsAdded,
      summary: job.summary,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  });
}

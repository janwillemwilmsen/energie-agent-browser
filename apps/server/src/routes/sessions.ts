import type { FastifyInstance } from 'fastify';
import { openSession, closeSession, sessionStatus, DEFAULT_SESSION } from '../agentBrowser/driver.js';

export async function sessionsRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>('/api/sessions/:name/status', async (req) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_SESSION;
    return { name, ...sessionStatus(name) };
  });

  app.post<{ Params: { name: string } }>('/api/sessions/:name/bootstrap', async (req, reply) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_SESSION;
    try {
      await openSession(name, { intent: 'reuse' });
      return { name, ...sessionStatus(name) };
    } catch (e: any) {
      return reply.code(502).send({ error: 'bootstrap_failed', message: e?.message ?? String(e) });
    }
  });

  app.post<{ Params: { name: string } }>('/api/sessions/:name/close', async (req) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_SESSION;
    await closeSession(name);
    return { name, closed: true };
  });
}

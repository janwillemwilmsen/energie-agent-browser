import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openSession, closeSession, DEFAULT_SESSION } from '../agentBrowser/driver.js';

function sessionPidAlive(session: string): { alive: boolean; pid: number | null } {
  try {
    const pid = Number(
      fs.readFileSync(path.join(os.homedir(), '.agent-browser', `${session}.pid`), 'utf-8').trim(),
    );
    if (!pid) return { alive: false, pid: null };
    try { process.kill(pid, 0); return { alive: true, pid }; } catch { return { alive: false, pid }; }
  } catch {
    return { alive: false, pid: null };
  }
}

export async function sessionsRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>('/api/sessions/:name/status', async (req) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_SESSION;
    return { name, ...sessionPidAlive(name) };
  });

  app.post<{ Params: { name: string } }>('/api/sessions/:name/bootstrap', async (req, reply) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_SESSION;
    try {
      await openSession(name, { intent: 'reuse' });
      return { name, ...sessionPidAlive(name) };
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

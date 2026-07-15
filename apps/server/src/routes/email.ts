import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  emailEnabled,
  listRecipients,
  addRecipient,
  updateRecipient,
  deleteRecipient,
  getRecipient,
  sendTestEmail,
  sendDailyDigest,
} from '../email.js';

const AddBody = z.object({ email: z.string().email().max(254) });
const UpdateBody = z.object({
  scenarioIds: z.array(z.number().int()).default([]),
  successScenarioIds: z.array(z.number().int()).default([]),
  dailyDigest: z.boolean().default(false),
});

export async function emailRoutes(app: FastifyInstance) {
  // Whether sending is configured — the UI uses this to explain setup.
  app.get('/api/email/status', async () => ({
    enabled: emailEnabled(),
    from: config.email.from,
  }));

  app.get('/api/email/recipients', async () => listRecipients());

  app.post('/api/email/recipients', async (req, reply) => {
    const { email } = AddBody.parse(req.body);
    const recipient = addRecipient(email.trim().toLowerCase());
    return reply.code(201).send(recipient);
  });

  app.put<{ Params: { id: string } }>('/api/email/recipients/:id', async (req, reply) => {
    const body = UpdateBody.parse(req.body);
    const updated = updateRecipient(Number(req.params.id), body);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/email/recipients/:id', async (req, reply) => {
    if (!deleteRecipient(Number(req.params.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/email/recipients/:id/test', async (req, reply) => {
    const recipient = getRecipient(Number(req.params.id));
    if (!recipient) return reply.code(404).send({ error: 'not_found' });
    const res = await sendTestEmail(recipient.email);
    if (!res.ok) return reply.code(502).send({ error: 'send_failed', message: res.error });
    return { ok: true, id: res.id };
  });

  // Manual digest trigger ("Send digest now") — bypasses the once-per-day guard.
  app.post('/api/email/digest/send', async (req, reply) => {
    const res = await sendDailyDigest(true);
    if (res.errors.length > 0 && res.sent === 0) {
      return reply.code(502).send({ error: 'send_failed', message: res.errors.join('; ') });
    }
    return { ok: true, sent: res.sent, runCount: res.runCount, errors: res.errors };
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getVapidPublicKey,
  upsertSubscription,
  deleteSubscription,
  getSubscriptionScenarioIds,
  sendTestToEndpoint,
} from '../push.js';

const SubscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
  scenarioIds: z.array(z.number().int()).default([]),
  successScenarioIds: z.array(z.number().int()).default([]),
});
const EndpointBody = z.object({ endpoint: z.string().min(1) });

export async function pushRoutes(app: FastifyInstance) {
  // The client needs the VAPID public key to create a PushManager subscription.
  app.get('/api/push/vapid-public-key', async () => ({ publicKey: getVapidPublicKey() }));

  // Register (or update) a browser's subscription + the scenarios it wants.
  app.post('/api/push/subscribe', async (req) => {
    const body = SubscribeBody.parse(req.body);
    upsertSubscription(body.subscription, body.scenarioIds, body.successScenarioIds);
    return { ok: true };
  });

  // Report whether an endpoint is registered and which scenarios it selected,
  // so the UI can render the checkboxes to match this browser's state.
  app.post('/api/push/status', async (req) => {
    const { endpoint } = EndpointBody.parse(req.body);
    const status = getSubscriptionScenarioIds(endpoint);
    return {
      subscribed: status !== null,
      scenarioIds: status?.scenarioIds ?? [],
      successScenarioIds: status?.successScenarioIds ?? [],
    };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = EndpointBody.parse(req.body);
    deleteSubscription(endpoint);
    return { ok: true };
  });

  app.post('/api/push/test', async (req, reply) => {
    const { endpoint } = EndpointBody.parse(req.body);
    const ok = await sendTestToEndpoint(endpoint);
    if (!ok) return reply.code(404).send({ error: 'subscription_not_found' });
    return { ok: true };
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkCredentials,
  createSessionToken,
  isAuthenticated,
  sessionSetCookie,
  sessionClearCookie,
} from '../auth.js';
import { config } from '../config.js';

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  // Whether the caller is logged in (and whether the gate is even on). The SPA
  // hits this on load to decide between the login page and the app.
  app.get('/api/auth/me', async (req) => ({
    authenticated: isAuthenticated(req),
    enabled: config.auth.enabled,
  }));

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    if (!checkCredentials(body.username.trim(), body.password)) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    reply.header('set-cookie', sessionSetCookie(createSessionToken()));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', sessionClearCookie());
    return { ok: true };
  });
}

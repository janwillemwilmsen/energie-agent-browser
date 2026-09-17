import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { scenariosRoutes } from './routes/scenarios.js';
import { snapshotRoutes } from './routes/snapshot.js';
import { runsRoutes } from './routes/runs.js';
import { recordingsRoutes } from './routes/recordings.js';
import { diffsRoutes } from './routes/diffs.js';
import { schedulesRoutes } from './routes/schedules.js';
import { sessionsRoutes } from './routes/sessions.js';
import { sessionStatesRoutes } from './routes/sessionStates.js';
import { preflightsRoutes } from './routes/preflights.js';
import { authProfilesRoutes } from './routes/authProfiles.js';
import { authRoutes } from './routes/auth.js';
import { isAuthenticated } from './auth.js';
import { pushRoutes } from './routes/push.js';
import { emailRoutes } from './routes/email.js';
import { agentTasksRoutes } from './routes/agentTasks.js';
import { adminEnvRoutes } from './routes/adminEnv.js';
import { browserlessHealthRoutes } from './routes/browserlessHealth.js';
import { storageRoutes } from './routes/storage.js';
import { screenshotsZipRoutes } from './routes/screenshotsZip.js';
import { terminalWsRoute } from './ws/terminal.js';
import { screencastWsRoute } from './ws/screencast.js';

// The composition root for the HTTP app: error handling, the login gate,
// every route, and the static SPA. It starts nothing — no timers, no
// schedulers, no signal handlers, no listen — so a test can build it over an
// injected database and drive it with inject(). main() in index.ts does the
// rest.

export interface CreateAppOptions {
  logger?: boolean;
  /** Directory holding the built SPA (index.html); default apps/web/dist. Pass null to skip. */
  webDist?: string | null;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(websocket);

  // A failed `Schema.parse(req.body)` throws a ZodError. Fastify's default
  // handler renders any uncaught error as a 500, so bad input (e.g. an invalid
  // auth-profile URL) looked like a server crash. Turn validation errors into a
  // clean 400 with the offending fields, and keep real failures as 500.
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: error.issues
          .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
          .join('; '),
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: error.name, message: error.message });
    }
    req.log.error(error);
    return reply.code(500).send({ error: 'internal_error', message: error.message });
  });

  // Login gate: everything under /api/* and /ws/* requires a valid session,
  // EXCEPT the auth endpoints themselves and the health check. Static assets and
  // the SPA (any non-API/WS path) are served freely so the login page can load;
  // the API returning 401 is what actually keeps data protected.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (url.startsWith('/api/auth/') || url === '/health') return;
    const gated = url.startsWith('/api/') || url.startsWith('/ws/');
    if (gated && !isAuthenticated(req)) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
  });

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(scenariosRoutes);
  await app.register(snapshotRoutes);
  await app.register(runsRoutes);
  await app.register(recordingsRoutes);
  await app.register(diffsRoutes);
  await app.register(schedulesRoutes);
  await app.register(sessionsRoutes);
  await app.register(sessionStatesRoutes);
  await app.register(preflightsRoutes);
  await app.register(authProfilesRoutes);
  await app.register(pushRoutes);
  await app.register(emailRoutes);
  await app.register(agentTasksRoutes);
  await app.register(adminEnvRoutes);
  await app.register(browserlessHealthRoutes);
  await app.register(storageRoutes);
  await app.register(screenshotsZipRoutes);
  await app.register(terminalWsRoute);
  await app.register(screencastWsRoute);

  // Static SPA: serve apps/web/dist/ when the build output exists. Skipped
  // silently in development, where Vite runs on its own port and proxies
  // /api + /ws to this server. In production (Coolify / Docker) this is what
  // makes a single container serve both the API and the React SPA on $PORT.
  // Order matters: all API + WS routes are already registered above, so the
  // static handler only catches things they didn't claim.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = opts.webDist === undefined ? path.resolve(__dirname, '..', '..', 'web', 'dist') : opts.webDist;
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // React Router uses client-side routes (/preflight, /scenarios/12, …). On
    // a hard refresh the browser asks the server for those paths and we'd
    // 404 without this fallback — return index.html so the SPA hydrates and
    // the in-app router takes over. Excludes /api/* and /ws/* to keep their
    // 404s honest (so a typo'd API path doesn't silently return HTML).
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '';
      if (url.startsWith('/api/') || url.startsWith('/ws/')) {
        reply.code(404).send({ error: 'not_found', path: url });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
    app.log.info({ webDist }, 'SPA: serving apps/web/dist from this server');
  } else {
    app.log.info('SPA: apps/web/dist not built — only the API is exposed on this port');
  }

  return app;
}

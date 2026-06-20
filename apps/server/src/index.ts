import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
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
import { browserlessHealthRoutes } from './routes/browserlessHealth.js';
import { terminalWsRoute } from './ws/terminal.js';
import { screencastWsRoute } from './ws/screencast.js';
import { startScheduler } from './scheduler/index.js';
import { closeAllActiveSessions } from './agentBrowser/driver.js';

// node-pty on Windows occasionally throws "AttachConsole failed" from its
// internal console-enumeration helper. That can kill the whole server. Catch
// it (and any other late stray error) so we degrade to a broken pty instead
// of taking the API down with it.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});

async function main() {
  migrate();

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(websocket);

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

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
  await app.register(browserlessHealthRoutes);
  await app.register(terminalWsRoute);
  await app.register(screencastWsRoute);

  // Static SPA: serve apps/web/dist/ when the build output exists. Skipped
  // silently in development, where Vite runs on its own port and proxies
  // /api + /ws to this server. In production (Coolify / Docker) this is what
  // makes a single container serve both the API and the React SPA on $PORT.
  // Order matters: all API + WS routes are already registered above, so the
  // static handler only catches things they didn't claim.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
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

  startScheduler();

  // Graceful shutdown: flush every daemon's --session-name state to disk
  // before exit. Without this, Ctrl+C kills the daemon with taskkill /F and
  // the in-memory cookies/localStorage for the live preflight are lost.
  // 15-second cap so a single stuck daemon can't block the whole shutdown.
  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 15_000;
  async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown: flushing agent-browser --session-name state');
    try {
      await Promise.race([
        closeAllActiveSessions(),
        new Promise<void>((res) => setTimeout(res, SHUTDOWN_TIMEOUT_MS)),
      ]);
    } catch (e) {
      app.log.error({ err: e }, 'shutdown: session flush failed');
    }
    try { await app.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  // SIGINT covers Ctrl+C on Windows + POSIX. SIGTERM is what `docker stop`,
  // systemd, and most process managers send for a polite shutdown request.
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { scenariosRoutes } from './routes/scenarios.js';
import { snapshotRoutes } from './routes/snapshot.js';
import { runsRoutes } from './routes/runs.js';
import { schedulesRoutes } from './routes/schedules.js';
import { sessionsRoutes } from './routes/sessions.js';
import { terminalWsRoute } from './ws/terminal.js';
import { screencastWsRoute } from './ws/screencast.js';
import { startScheduler } from './scheduler/index.js';

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
  await app.register(schedulesRoutes);
  await app.register(sessionsRoutes);
  await app.register(terminalWsRoute);
  await app.register(screencastWsRoute);

  startScheduler();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

import { config, loadConfig, loadDotenv, setConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { ensurePushConfigured, pushRunFinished } from './push.js';
import { emailRunFinished, startEmailDigestSchedule } from './email.js';
import { onRunFinished } from './notifications.js';
import { startScheduler } from './scheduler/index.js';
import { closeAllActiveSessions } from './agentBrowser/driver.js';

// The process entry point: load configuration, migrate, build the app
// (app.ts), wire the adapters and background work, listen, and shut down
// cleanly. Everything that starts or stops something lives here.

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
  // Configuration is a value: read .env, load it once, fail with every missing
  // variable listed, and install it for the modules that read `config`.
  loadDotenv();
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    // eslint-disable-next-line no-console
    console.error(`Missing required env var(s): ${loaded.missing.join(', ')}`);
    process.exit(1);
  }
  setConfig(loaded.config);

  migrate();

  const app = await createApp();

  // Set up VAPID (generates/persists keys on first boot) so the first push
  // request doesn't pay that cost mid-request.
  try { ensurePushConfigured(); } catch (e) { app.log.warn({ err: e }, 'push: VAPID setup failed'); }

  // The run-finished seam: push and email are its two adapters.
  onRunFinished(pushRunFinished);
  onRunFinished(emailRunFinished);

  startScheduler();
  startEmailDigestSchedule();

  // Graceful shutdown: close every daemon we started before exit. Without
  // this, Ctrl+C kills the daemon with taskkill /F and the in-memory
  // cookies/localStorage for the live preflight are lost. 15-second cap so a
  // single stuck daemon can't block the whole shutdown.
  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 15_000;
  async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown: closing agent-browser sessions');
    try {
      await Promise.race([
        closeAllActiveSessions(),
        new Promise<void>((res) => setTimeout(res, SHUTDOWN_TIMEOUT_MS)),
      ]);
    } catch (e) {
      app.log.error({ err: e }, 'shutdown: session close failed');
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

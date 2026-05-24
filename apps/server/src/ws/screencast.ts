import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { run } from '../agentBrowser/driver.js';

function sessionPidAlive(session: string): boolean {
  try {
    const pid = Number(
      fs.readFileSync(path.join(os.homedir(), '.agent-browser', `${session}.pid`), 'utf-8').trim(),
    );
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch {
    return false;
  }
}

const FRAME_INTERVAL_MS = 1500;

let activeClient: { close: () => void; session: string } | null = null;

export async function screencastWsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { session?: string } }>(
    '/ws/screencast',
    { websocket: true },
    (socket, req) => {
      const session = (req.query.session ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!session) {
        socket.close(1008, 'invalid session');
        return;
      }

      // "One concurrent stream at a time" — kick the previous viewer.
      if (activeClient) {
        try { activeClient.close(); } catch { /* ignore */ }
      }

      if (!sessionPidAlive(session)) {
        socket.send(
          JSON.stringify({
            type: 'help',
            message:
              `Session "${session}" is not running. Open the Terminal tab and run:\n` +
              `  agent-browser --session ${session} connect "%BROWSERLESS_CDP_URL%"\n` +
              `Then come back and start the preview.`,
          }),
        );
        socket.close(1011, 'session_not_ready');
        return;
      }

      const tmpDir = path.join(config.dataDir, 'preview');
      fs.mkdirSync(tmpDir, { recursive: true });
      const framePath = path.join(tmpDir, `${session}.jpg`);

      let cancelled = false;
      let inflight = false;

      const sendFrame = async () => {
        if (cancelled || socket.readyState !== socket.OPEN) return;
        if (inflight) return;
        inflight = true;
        try {
          const r = await run(
            ['--screenshot-format', 'jpeg', '--screenshot-quality', '60', 'screenshot', framePath],
            { session, timeoutMs: 20_000 },
          );
          if (r.exitCode !== 0) {
            socket.send(JSON.stringify({ type: 'error', message: r.stderr || r.stdout }));
            return;
          }
          const buf = await fs.promises.readFile(framePath);
          socket.send(
            JSON.stringify({
              type: 'frame',
              capturedAt: new Date().toISOString(),
              data: buf.toString('base64'),
            }),
          );
        } catch (e: any) {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'error', message: e.message }));
          }
        } finally {
          inflight = false;
        }
      };

      const interval = setInterval(sendFrame, FRAME_INTERVAL_MS);
      void sendFrame(); // emit one frame immediately

      const close = () => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(interval);
        try { socket.close(); } catch { /* ignore */ }
        if (activeClient && activeClient.session === session) activeClient = null;
      };

      activeClient = { close, session };

      socket.on('close', close);
      socket.on('error', close);
      socket.on('message', () => {
        // No protocol input expected yet.
      });
    },
  );
}

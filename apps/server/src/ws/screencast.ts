import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { isSessionAlive, openSession, run, DEFAULT_SESSION } from '../agentBrowser/driver.js';

const FRAME_INTERVAL_MS = 1500;

let activeClient: { close: () => void; session: string } | null = null;

export async function screencastWsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { session?: string } }>(
    '/ws/screencast',
    { websocket: true },
    (socket, req) => {
      const session = (req.query.session ?? DEFAULT_SESSION).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!session) {
        socket.close(1008, 'invalid session');
        return;
      }

      // "One concurrent stream at a time" — kick the previous viewer.
      if (activeClient) {
        try { activeClient.close(); } catch { /* ignore */ }
      }

      const tmpDir = path.join(config.dataDir, 'preview');
      fs.mkdirSync(tmpDir, { recursive: true });
      const framePath = path.join(tmpDir, `${session}.jpg`);

      let cancelled = false;
      let inflight = false;
      let interval: NodeJS.Timeout | null = null;

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

      const close = () => {
        if (cancelled) return;
        cancelled = true;
        if (interval) clearInterval(interval);
        try { socket.close(); } catch { /* ignore */ }
        if (activeClient && activeClient.session === session) activeClient = null;
      };

      activeClient = { close, session };

      socket.on('close', close);
      socket.on('error', close);
      socket.on('message', () => {
        // No protocol input expected yet.
      });

      // Start the session ourselves when it's down (local mode launches its
      // own browser; there's nothing for the user to run by hand), then begin
      // streaming frames. ensureSession dedupes concurrent bootstraps, so a
      // preview opening mid-bootstrap just awaits the in-flight connect.
      void (async () => {
        if (!isSessionAlive(session)) {
          try {
            socket.send(
              JSON.stringify({ type: 'status', message: 'Starting browser session…' }),
            );
            await openSession(session, { intent: 'reuse' });
          } catch (e: any) {
            if (socket.readyState === socket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  message: `Could not start session "${session}": ${e?.message ?? e}`,
                }),
              );
            }
            close();
            return;
          }
        }
        if (cancelled) return;
        interval = setInterval(sendFrame, FRAME_INTERVAL_MS);
        void sendFrame(); // emit one frame immediately
      })();
    },
  );
}

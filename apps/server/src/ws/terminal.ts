import type { FastifyInstance } from 'fastify';
import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentBrowserEnv, DEFAULT_SESSION } from '../agentBrowser/driver.js';
import { cdpConnectUrl, connectUrlEnvVar, currentBackend } from '../agentBrowser/backend.js';
import { resolveChromeConnectUrl } from '../agentBrowser/chromeRemote.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function shellCommand(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: process.env.COMSPEC ?? 'cmd.exe', args: [] };
  }
  // Walk a list of candidates and return the first one that exists. Coolify /
  // Nixpacks slim base images often ship only `/bin/sh` (dash), not bash —
  // hardcoding `/bin/bash` makes pty.spawn fail with ENOENT and the xterm
  // panel just shows "[connection error] [connection closed]" with no clue.
  const candidates = [
    process.env.SHELL,
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/usr/bin/sh',
  ].filter((c): c is string => !!c);
  for (const cmd of candidates) {
    try {
      if (fs.existsSync(cmd)) return { cmd, args: [] };
    } catch { /* ignore */ }
  }
  // Last resort — let node-pty throw a useful ENOENT we can surface.
  return { cmd: '/bin/sh', args: [] };
}

// The env plus, for a chrome backend, why its connect URL could not be set
// (Chrome unreachable when the shell opened) — printed into the terminal.
async function ptyEnv(): Promise<{ env: NodeJS.ProcessEnv; warning: string | null }> {
  // apps/server/src/ws → apps/server (server root) → ../../ (repo root).
  // With npm workspaces, the agent-browser bin is hoisted to the repo-root
  // node_modules/.bin, not the server-local one. Include both so PATH wins
  // wherever the install ended up.
  const serverRoot = path.resolve(__dirname, '..', '..');
  const repoRoot = path.resolve(serverRoot, '..', '..');
  const binDirs = [
    path.join(repoRoot, 'node_modules', '.bin'),
    path.join(serverRoot, 'node_modules', '.bin'),
  ];
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH ?? '';
  // The same wiring every agent-browser process gets (the configured backend,
  // stealth), plus what a shell needs: the bin dirs on PATH, the shared
  // session as the default --session, and the connect URL for a manual
  // `connect` (BROWSERLESS_CDP_URL / CHROME_CDP_URL, see bootstrapCommand).
  const env: NodeJS.ProcessEnv = {
    ...agentBrowserEnv(),
    PATH: `${binDirs.join(pathSep)}${pathSep}${currentPath}`,
    AGENT_BROWSER_SESSION: DEFAULT_SESSION,
  };
  let warning: string | null = null;
  const { backend, stealth } = currentBackend();
  const envVar = connectUrlEnvVar(backend);
  if (backend.kind === 'cdp' && envVar) env[envVar] = cdpConnectUrl(backend, stealth);
  if (backend.kind === 'chrome' && envVar) {
    // Resolved once, when the shell opens: the URL embeds Chrome's current
    // browser id. Restart Chrome → reopen the Terminal page (or Refresh).
    try {
      env[envVar] = await resolveChromeConnectUrl(backend.url);
    } catch (e: any) {
      warning = `${envVar} not set — ${e?.message ?? e}. Start Chrome + the tunnel, then reload this page.`;
    }
  }
  return { env, warning };
}

export async function terminalWsRoute(app: FastifyInstance) {
  app.get('/ws/terminal', { websocket: true }, (socket) => {
    const { cmd, args } = shellCommand();

    // The env may take a network round-trip (chrome backend). Listeners go on
    // the socket now — a 'message' with no listener is dropped — and what the
    // client sends before the shell exists (its first resize) is replayed.
    let proc: pty.IPty | null = null;
    let closed = false;
    const pending: Array<{ type?: string; data?: string; cols?: number; rows?: number }> = [];

    const apply = (m: { type?: string; data?: string; cols?: number; rows?: number }) => {
      if (!proc) return;
      if (m.type === 'data' && typeof m.data === 'string') {
        proc.write(m.data);
      } else if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
        try {
          proc.resize(m.cols, m.rows);
        } catch {
          /* ignore */
        }
      }
    };

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (proc) apply(msg as typeof pending[number]);
      else pending.push(msg as typeof pending[number]);
    });

    socket.on('close', () => {
      closed = true;
      try {
        proc?.kill();
      } catch {
        /* ignore */
      }
    });

    void ptyEnv().then(({ env, warning }) => {
      if (closed) return;
      if (warning && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[33m${warning}\x1b[0m\r\n` }));
      }

      let spawned: pty.IPty;
      try {
        spawned = pty.spawn(cmd, args, {
          name: 'xterm-color',
          cols: 120,
          rows: 30,
          cwd: process.cwd(),
          env: env as { [key: string]: string },
        });
      } catch (e: any) {
        // Surface the actual cause via the xterm panel. Without this the
        // client just sees [connection error] / [connection closed] and you
        // have to dig into server logs to know it's e.g. ENOENT on /bin/bash.
        const msg = `pty spawn failed (${cmd}): ${e?.message ?? e}`;
        // Log server-side too — useful in Coolify's logs panel.
        app.log.error({ cmd, err: e }, 'terminal pty spawn failed');
        try {
          socket.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[31m${msg}\x1b[0m\r\n` }));
          socket.send(JSON.stringify({ type: 'exit', exitCode: -1 }));
          socket.close();
        } catch { /* ignore */ }
        return;
      }
      proc = spawned;

      spawned.onData((data) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'data', data }));
        }
      });

      spawned.onExit(({ exitCode, signal }) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
          socket.close();
        }
      });

      for (const m of pending.splice(0)) apply(m);
    });
  });
}

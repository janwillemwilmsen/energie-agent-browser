import type { FastifyInstance } from 'fastify';
import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, browserlessCdpUrl } from '../config.js';

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

function ptyEnv(): NodeJS.ProcessEnv {
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDirs.join(pathSep)}${pathSep}${currentPath}`,
    AGENT_BROWSER_SESSION: 'default',
    BROWSERLESS_CDP_URL: browserlessCdpUrl(),
    BROWSERLESS_API_URL: config.browserless.url
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://'),
    BROWSERLESS_API_KEY: config.browserless.token,
  };
  if (config.stealth.enabled) {
    if (config.stealth.userAgent) env.AGENT_BROWSER_USER_AGENT = config.stealth.userAgent;
    if (config.stealth.initScript) env.AGENT_BROWSER_INIT_SCRIPTS = config.stealth.initScript;
  }
  return env;
}

export async function terminalWsRoute(app: FastifyInstance) {
  app.get('/ws/terminal', { websocket: true }, (socket) => {
    const { cmd, args } = shellCommand();

    let proc: pty.IPty;
    try {
      proc = pty.spawn(cmd, args, {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: ptyEnv() as { [key: string]: string },
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

    proc.onData((data) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'data', data }));
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
        socket.close();
      }
    });

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; data?: string; cols?: number; rows?: number };
      if (m.type === 'data' && typeof m.data === 'string') {
        proc.write(m.data);
      } else if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
        try {
          proc.resize(m.cols, m.rows);
        } catch {
          /* ignore */
        }
      }
    });

    socket.on('close', () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    });
  });
}

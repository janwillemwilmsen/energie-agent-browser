import type { FastifyInstance } from 'fastify';
import * as pty from 'node-pty';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, browserlessCdpUrl } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function shellCommand(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: process.env.COMSPEC ?? 'cmd.exe', args: [] };
  }
  return { cmd: process.env.SHELL ?? '/bin/bash', args: [] };
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
      // node-pty intermittently throws AttachConsole on Windows. Don't crash the
      // whole server; just close this socket with an error frame.
      try {
        socket.send(
          JSON.stringify({ type: 'error', message: `pty spawn failed: ${e?.message ?? e}` }),
        );
        socket.close();
      } catch {
        /* ignore */
      }
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

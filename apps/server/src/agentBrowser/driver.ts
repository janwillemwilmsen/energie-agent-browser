import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import { browserlessCdpUrl, config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');
const AGENT_BROWSER_BIN_DIR = path.join(REPO_ROOT, 'node_modules', 'agent-browser', 'bin');

/**
 * Pick the right native agent-browser binary for this platform. We invoke it
 * directly instead of going through the package's agent-browser.js wrapper,
 * because the wrapper spawns the native exe with `windowsHide: false`, which
 * pops a console window for every invocation on Windows.
 */
function getNativeBin(): string {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let osKey: string;
  if (platform === 'win32') osKey = 'win32';
  else if (platform === 'darwin') osKey = 'darwin';
  else if (platform === 'linux') osKey = 'linux';
  else throw new Error(`Unsupported platform: ${platform}`);
  const ext = platform === 'win32' ? '.exe' : '';
  return path.join(AGENT_BROWSER_BIN_DIR, `agent-browser-${osKey}-${arch}${ext}`);
}

const NATIVE_BIN = getNativeBin();

const READY_TIMEOUT_MS = 40_000;
const READY_POLL_MS = 500;
const CMD_TIMEOUT_MS = 60_000;

const sessionsConnecting = new Map<string, Promise<void>>();

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  /** Per-session name passed via --session. */
  session?: string;
  /** Soft timeout (ms). */
  timeoutMs?: number;
}

function pidFile(session: string): string {
  return path.join(os.homedir(), '.agent-browser', `${session}.pid`);
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  }
}

const DEBUG = process.env.AB_DRIVER_DEBUG === '1';

function childEnv(): NodeJS.ProcessEnv {
  // Make BROWSERLESS_API_KEY available so spawned commands never trigger an
  // auto-launch error, but do NOT set AGENT_BROWSER_PROVIDER — the self-hosted
  // browserless lacks the REST API the provider mode expects. We always go
  // through explicit `connect wss://...` instead.
  // wss:// → https://, ws:// → http://  (preserve the secure scheme)
  const apiBase = config.browserless.url
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSERLESS_API_KEY: config.browserless.token,
    BROWSERLESS_API_URL: apiBase,
  };
  if (config.stealth.enabled) {
    // We connect to a REMOTE browser via CDP, so Chromium-launch args go via
    // the wss `launch` query (in browserlessCdpUrl()) rather than AGENT_BROWSER_ARGS.
    // The two runtime-applied knobs still travel via env so every agent-browser
    // invocation gets them.
    if (config.stealth.userAgent) env.AGENT_BROWSER_USER_AGENT = config.stealth.userAgent;
    if (config.stealth.initScript) env.AGENT_BROWSER_INIT_SCRIPTS = config.stealth.initScript;
  }
  return env;
}

async function runRaw(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    if (DEBUG) console.log(`[ab] spawn ${args.join(' ')} (timeout=${timeoutMs}ms)`);
    const proc = spawn(NATIVE_BIN, args, {
      shell: false,
      windowsHide: true,
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let resolved = false;

    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (DEBUG) {
        const ms = Date.now() - startedAt;
        console.log(`[ab] done ${args.join(' ')} exit=${code} killed=${killed} ms=${ms}`);
      }
      resolve({
        stdout,
        stderr: killed ? stderr + '\n[timed out]' : stderr,
        exitCode: code,
      });
    };

    const timer = setTimeout(() => {
      killed = true;
      if (proc.pid) killProcessTree(proc.pid);
      // Fallback resolve in case 'close' never fires after tree kill.
      setTimeout(() => done(-9), 2_000);
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => done(code ?? -1));
    proc.on('error', (err) => {
      stderr += '\n' + err.message;
      done(-1);
    });
  });
}

function sessionHasPidFile(session: string): boolean {
  try {
    const pid = Number(fs.readFileSync(pidFile(session), 'utf-8').trim());
    if (!pid) return false;
    // Verify the recorded PID is alive — if not, wipe the stale entry so the
    // CLI doesn't try to talk to a dead daemon (which hangs).
    try {
      process.kill(pid, 0);
    } catch {
      try { fs.unlinkSync(pidFile(session)); } catch { /* ignore */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isSessionAlive(session: string): boolean {
  // The daemon writes its pid file only AFTER the wss handshake to browserless
  // succeeds — i.e. once it's actually ready to receive commands. So the pid
  // file existing + the recorded pid being alive is a sufficient readiness
  // signal, and we can skip the expensive `get url` round-trip that used to
  // dominate the bootstrap budget. Stale pid files are wiped here too.
  return sessionHasPidFile(session);
}

const LAUNCH_HELPER = path.join(__dirname, 'launchConnect.cjs');

function killStaleDaemons(): void {
  // Zombie agent-browser daemons left over from prior failed bootstraps seem to
  // correlate with 10060 errors on fresh connects. Wipe them so each bootstrap
  // starts clean. Use taskkill on Windows; pkill elsewhere. Errors ignored.
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/IM', 'agent-browser-win32-x64.exe'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  } else {
    try {
      spawn('pkill', ['-f', 'agent-browser-'], { shell: false, stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  // Also wipe stale per-session marker files so isSessionAlive doesn't trust them.
  try {
    const dir = path.join(os.homedir(), '.agent-browser');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.pid') || f.endsWith('.port') || f.endsWith('.stream')) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    /* ignore */
  }
}

function spawnConnectDetached(session: string): void {
  killStaleDaemons();
  const cdp = browserlessCdpUrl();
  const logDir = path.join(config.dataDir, 'agent-browser-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${session}.log`);
  try { fs.writeFileSync(logPath, ''); } catch { /* ignore */ }

  // Spawn the agent-browser daemon through node-pty (conpty on Windows).
  // The native exe needs a real console to start its CDP client; conpty
  // provides one without creating a visible window. Drain output to the
  // log file. The pty handle is intentionally leaked — the daemon lives
  // for the session lifetime; we don't kill the pty until session close.
  try {
    const ptyProc = pty.spawn(
      NATIVE_BIN,
      ['--session', session, 'connect', cdp],
      {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: childEnv() as { [key: string]: string },
      },
    );
    const out = fs.createWriteStream(logPath, { flags: 'a' });
    ptyProc.onData((d) => out.write(d));
    ptyProc.onExit(() => out.end());
    if (DEBUG) console.log(`[ab] pty-daemon spawn session=${session} pid=${ptyProc.pid}`);
  } catch (e: any) {
    if (DEBUG) console.log(`[ab] pty-daemon spawn failed: ${e?.message ?? e}`);
    fs.appendFileSync(logPath, `\n[server] pty.spawn failed: ${e?.message ?? e}\n`);
  }
}

async function connectSession(session: string): Promise<void> {
  spawnConnectDetached(session);

  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (isSessionAlive(session)) return;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(
    `Session "${session}" failed to become ready within ${READY_TIMEOUT_MS}ms`,
  );
}

export async function ensureSession(session = 'default'): Promise<void> {
  if (sessionsConnecting.has(session)) {
    await sessionsConnecting.get(session);
    return;
  }
  if (isSessionAlive(session)) return;
  const p = connectSession(session).finally(() => sessionsConnecting.delete(session));
  sessionsConnecting.set(session, p);
  await p;
}

export async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const session = opts.session ?? 'default';
  await ensureSession(session);
  return runRaw(['--session', session, ...args], opts.timeoutMs ?? CMD_TIMEOUT_MS);
}

export async function runJson<T = unknown>(
  args: string[],
  opts: RunOptions = {},
): Promise<T> {
  const r = await run(['--json', ...args], opts);
  if (r.exitCode !== 0) {
    throw new Error(`agent-browser ${args.join(' ')} failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  }
  const trimmed = r.stdout.trim();
  if (!trimmed) {
    throw new Error(`agent-browser ${args.join(' ')} produced no output`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`agent-browser returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
  if (parsed.success === false) {
    throw new Error(`agent-browser error: ${parsed.error ?? 'unknown'}`);
  }
  return parsed.data as T;
}

export async function closeSession(session: string): Promise<void> {
  // Skip the graceful-close CLI round-trip (3-10 s on Windows). Just kill the
  // process and wipe the session marker files — the browserless side will
  // garbage-collect the wss session on its own idle timeout.
  try {
    const pid = Number(
      fs.readFileSync(pidFile(session), 'utf-8').trim(),
    );
    if (pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        try { process.kill(pid); } catch { /* ignore */ }
      }
    }
  } catch {
    /* no pid file */
  }
  const dir = path.join(os.homedir(), '.agent-browser');
  for (const ext of ['pid', 'port', 'stream', 'engine']) {
    try { fs.unlinkSync(path.join(dir, `${session}.${ext}`)); } catch { /* ignore */ }
  }
}

export { browserlessCdpUrl, config, pidFile };

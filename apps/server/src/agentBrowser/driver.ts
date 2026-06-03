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

// Disk-backed record of which agent-browser --session-name a given --session
// daemon was started with. Lives next to the other daemon markers (.pid,
// .port, …) so it survives the server's hot-reload — without this, every
// `tsx watch` rebuild would lose track of the binding, ensureSession would
// assume mismatch on the next call, and closeSession would skip the
// in-memory-state flush because it has nothing to flush to. Empty value
// means "started without --session-name".
function sessionNameMarker(session: string): string {
  return path.join(os.homedir(), '.agent-browser', `${session}.session-name`);
}
function readSessionName(session: string): string | null {
  try {
    const v = fs.readFileSync(sessionNameMarker(session), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}
function writeSessionName(session: string, name: string | null): void {
  const file = sessionNameMarker(session);
  try {
    if (name) fs.writeFileSync(file, name);
    else { try { fs.unlinkSync(file); } catch { /* missing is fine */ } }
  } catch {
    /* best-effort; a missing marker is recoverable */
  }
}

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

// Plain process.env without our BROWSERLESS_* / AGENT_BROWSER_* knobs.
// Detached commands (auth list/save/delete/show, state list, version, etc.)
// just touch local files — passing the browserless wiring makes them try to
// auto-connect and hang. Use this env instead.
function detachedEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

// Public sister of `runRaw` for commands that don't talk to a daemon — auth
// vault CRUD, state list, version, etc. No ensureSession; we just spawn the
// native binary with the given args and capture stdout/stderr.
export async function runDetached(args: string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(NATIVE_BIN, args, {
      shell: false,
      windowsHide: true,
      env: detachedEnv(),
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    };
    const timer = setTimeout(() => {
      if (proc.pid) killProcessTree(proc.pid);
      setTimeout(() => done(-9), 1_000);
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => done(code ?? -1));
    proc.on('error', (err) => { stderr += '\n' + err.message; done(-1); });
  });
}

// Same as runDetached but pipes a single line into the child's stdin and
// closes it. Used for `auth save --password-stdin` so the password never
// appears in argv (visible in `ps` / Task Manager / audit logs).
export async function runDetachedWithStdin(
  args: string[],
  stdinLine: string,
  timeoutMs = 10_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(NATIVE_BIN, args, {
      shell: false,
      windowsHide: true,
      env: detachedEnv(),
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    };
    const timer = setTimeout(() => {
      if (proc.pid) killProcessTree(proc.pid);
      setTimeout(() => done(-9), 1_000);
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => done(code ?? -1));
    proc.on('error', (err) => { stderr += '\n' + err.message; done(-1); });
    proc.stdin.write(stdinLine.endsWith('\n') ? stdinLine : stdinLine + '\n');
    proc.stdin.end();
  });
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

function spawnConnectDetached(session: string, sessionName?: string | null): void {
  killStaleDaemons();
  const cdp = browserlessCdpUrl();
  const logDir = path.join(config.dataDir, 'agent-browser-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${session}.log`);
  try { fs.writeFileSync(logPath, ''); } catch { /* ignore */ }

  // When sessionName is set, ask agent-browser to load/save state under
  // ~/.agent-browser/sessions/<sessionName> for this daemon's lifetime.
  // That's the mechanism that gives scenarios "already logged in" semantics —
  // a previous preflight populated the state, and now this daemon picks it up.
  const cliArgs = ['--session', session];
  if (sessionName) cliArgs.push('--session-name', sessionName);
  cliArgs.push('connect', cdp);

  // Spawn the agent-browser daemon through node-pty (conpty on Windows).
  // The native exe needs a real console to start its CDP client; conpty
  // provides one without creating a visible window. Drain output to the
  // log file. The pty handle is intentionally leaked — the daemon lives
  // for the session lifetime; we don't kill the pty until session close.
  try {
    const ptyProc = pty.spawn(
      NATIVE_BIN,
      cliArgs,
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
    if (DEBUG) console.log(
      `[ab] pty-daemon spawn session=${session}${sessionName ? ` session-name=${sessionName}` : ''} pid=${ptyProc.pid}`,
    );
  } catch (e: any) {
    if (DEBUG) console.log(`[ab] pty-daemon spawn failed: ${e?.message ?? e}`);
    fs.appendFileSync(logPath, `\n[server] pty.spawn failed: ${e?.message ?? e}\n`);
  }
}

// agent-browser prints `✗ Could not configure browser: …` to its pty log and
// exits when it can't complete the wss handshake with browserless. Without
// log-tailing we'd burn the full READY_TIMEOUT_MS waiting for a pid file that
// will never appear; with it, we surface the actual cause in ~1s.
const FAIL_LINE_RE = /✗\s*(Could not configure browser:[^\r\n]+|[^\r\n]+(?:error|fail(?:ed)?)[^\r\n]*)/i;
const ANSI_ESC_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07)/g;
function detectBootstrapFailure(logPath: string): string | null {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf-8'); } catch { return null; }
  const m = text.replace(ANSI_ESC_RE, '').match(FAIL_LINE_RE);
  return m && m[1] ? m[1].trim() : null;
}

// Inject cookies/localStorage/etc into the freshly-bootstrapped daemon's
// browser via CDP. agent-browser's `--session-name` startup flag only
// schedules the auto-save half of state persistence when connected over wss
// to browserless — the auto-load half is a no-op in that mode. So even a
// daemon spawned with `--session-name=X` comes up with an empty cookie jar
// unless we explicitly tell it to load the file. `state load` is the
// documented command for that, and it's been verified to populate the
// browser's cookies in a connect-wss session.
async function loadPersistedStateIntoDaemon(session: string, sessionName: string): Promise<void> {
  const target = persistedStatePath(sessionName);
  if (!fs.existsSync(target)) return; // first-ever use of this name, nothing to load
  try {
    const r = await runRaw(['--session', session, 'state', 'load', target], 10_000);
    if (DEBUG) {
      console.log(
        `[ab] state load session=${session} name=${sessionName} ` +
          `exit=${r.exitCode}${r.exitCode === 0 ? '' : ' err=' + r.stderr.slice(0, 200)}`,
      );
    }
  } catch (e: any) {
    if (DEBUG) console.log(`[ab] state load threw: ${e?.message ?? e}`);
  }
}

async function connectSession(session: string, sessionName: string | null): Promise<void> {
  spawnConnectDetached(session, sessionName);

  const logPath = path.join(config.dataDir, 'agent-browser-logs', `${session}.log`);
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (isSessionAlive(session)) {
      writeSessionName(session, sessionName ?? null);
      // Inject any persisted state for this --session-name into the live
      // browser. Without this step the daemon starts with an empty cookie
      // jar even though `--session-name=X` was in the spawn args.
      if (sessionName) {
        await loadPersistedStateIntoDaemon(session, sessionName);
      }
      return;
    }
    const fail = detectBootstrapFailure(logPath);
    if (fail) throw new Error(`agent-browser bootstrap failed: ${fail}`);
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(
    `Session "${session}" failed to become ready within ${READY_TIMEOUT_MS}ms`,
  );
}

export interface EnsureSessionOptions {
  /**
   * agent-browser `--session-name`. When set, the daemon for `session` must be
   * running with this exact session-name; if the live daemon was started with
   * a different name (or none), it is closed and re-bootstrapped. When
   * omitted, an already-running daemon is reused regardless of its name.
   */
  sessionName?: string | null;
}

export async function ensureSession(
  session = 'default',
  opts: EnsureSessionOptions = {},
): Promise<void> {
  if (sessionsConnecting.has(session)) {
    await sessionsConnecting.get(session);
    // After the in-flight connect resolves, re-check the name match — if it
    // doesn't, fall through to the restart path below.
  }

  const wantName = opts.sessionName ?? null;
  const alive = isSessionAlive(session);
  if (alive) {
    // No specific name requested → reuse whatever's up.
    if (opts.sessionName === undefined) return;
    const have = readSessionName(session);
    if (have === wantName) {
      // Daemon's --session-name matches. Reapply the on-disk state anyway —
      // the in-memory cookie jar can drift between calls (other commands,
      // probes, intra-scenario navigations), and selecting a preflight on a
      // scenario implies "I want this preflight's state to be active right
      // now", not "I'll trust whatever's already in the browser". Cheap and
      // idempotent when state matches.
      if (wantName) await loadPersistedStateIntoDaemon(session, wantName);
      return;
    }
    // Mismatch — close and re-bootstrap with the desired name.
    await closeSession(session);
  }

  const p = connectSession(session, wantName).finally(() => sessionsConnecting.delete(session));
  sessionsConnecting.set(session, p);
  await p;
}

export async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const session = opts.session ?? 'default';
  await ensureSession(session);
  return runRaw(['--session', session, ...args], opts.timeoutMs ?? CMD_TIMEOUT_MS);
}

// Daemon-routed sister of `run` that pipes a single line into the child's
// stdin. Used for `auth save --password-stdin` so the password is never on
// argv. Goes through ensureSession so the command attaches to the live daemon
// (and thus doesn't fail with a TCP timeout when agent-browser tries to
// bootstrap a new wss connection just to run a local-only command).
export async function runWithStdin(
  args: string[],
  stdinLine: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const session = opts.session ?? 'default';
  await ensureSession(session);
  const fullArgs = ['--session', session, ...args];
  const timeoutMs = opts.timeoutMs ?? CMD_TIMEOUT_MS;
  return new Promise((resolve) => {
    const proc = spawn(NATIVE_BIN, fullArgs, {
      shell: false,
      windowsHide: true,
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const done = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    };
    const timer = setTimeout(() => {
      if (proc.pid) killProcessTree(proc.pid);
      setTimeout(() => done(-9), 1_000);
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => done(code ?? -1));
    proc.on('error', (err) => { stderr += '\n' + err.message; done(-1); });
    proc.stdin.write(stdinLine.endsWith('\n') ? stdinLine : stdinLine + '\n');
    proc.stdin.end();
  });
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

// Path agent-browser's `--session-name <X>` auto-loads from (and where the
// runtime drops state when shutdown is graceful). We use the `.json` suffix
// so `agent-browser state list` recognizes the file — without it, state list
// hides the entry even though --session-name load still works.
export function persistedStatePath(sessionName: string): string {
  return path.join(os.homedir(), '.agent-browser', 'sessions', `${sessionName}.json`);
}

// Ask the running daemon to dump its current cookies/localStorage/etc to the
// canonical --session-name path. The caller is the authoritative event
// ("preflight Replay just finished", "user clicked Save preflight on the
// preflight currently bound to this daemon") — we don't second-guess it
// with auto-flush from generic lifecycle hooks any more.
//
// Returns true if the save succeeded (file written), false otherwise.
export async function persistSessionState(session: string, sessionName: string): Promise<boolean> {
  try {
    const stateDir = path.join(os.homedir(), '.agent-browser', 'sessions');
    fs.mkdirSync(stateDir, { recursive: true });
    const target = persistedStatePath(sessionName);
    const r = await runRaw(['--session', session, 'state', 'save', target], 10_000);
    if (DEBUG) {
      console.log(
        `[ab] state save session=${session} name=${sessionName} ` +
          `exit=${r.exitCode}${r.exitCode === 0 ? '' : ' err=' + r.stderr.slice(0, 200)}`,
      );
    }
    return r.exitCode === 0;
  } catch (e: any) {
    if (DEBUG) console.log(`[ab] state save threw: ${e?.message ?? e}`);
    return false;
  }
}

export async function closeSession(session: string): Promise<void> {
  // NOTE: we deliberately do NOT auto-flush in-memory state to disk here.
  // Doing so would overwrite the canonical preflight auth.json with whatever
  // happens to be in the browser at close time — which is frequently a
  // degraded subset (some cookies dropped, no localStorage for origins that
  // weren't navigated to this session, etc.). That eroded the saved state
  // every time a scenario or daemon respawn closed the session.
  //
  // Disk state is now authoritative and only mutated by explicit saves:
  //   - Preflight Replay (clean) writes the post-replay state at the end.
  //   - Save preflight (PUT /api/preflights/:id) writes when the daemon is
  //     currently bound to that preflight's --session-name.

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
  writeSessionName(session, null);
}

// /preflight recording targets the same 'default' daemon scenarios use, so
// the preview shows the live browser the moment that daemon is alive — no
// second daemon to keep in sync, no separate "session not running" gate to
// confuse the user. ensureSession(..., {sessionName}) handles binding the
// daemon to the right --session-name when recording or running with a
// preflight; on mismatch it restarts, on match it reuses for free.
export const PREFLIGHT_RECORDER_SESSION = 'default';

// Close every daemon currently tracked on disk (any session with a
// .session-name marker — i.e. one we know was started under a --session-name).
// The signal handler in index.ts calls this on Ctrl+C / SIGTERM so the
// auth.json for the live preflight isn't stranded in browser memory. Errors
// are swallowed per-session so one stuck daemon can't block the others.
export async function closeAllActiveSessions(): Promise<void> {
  const dir = path.join(os.homedir(), '.agent-browser');
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.session-name'))
      .map((f) => f.slice(0, -'.session-name'.length));
  } catch {
    return;
  }
  await Promise.all(names.map((s) => closeSession(s).catch(() => undefined)));
}

// Best-effort wipe of agent-browser's persisted state for a given
// --session-name. agent-browser writes under ~/.agent-browser/sessions/<name>
// (the exact file/dir shape isn't fully documented and may change between
// releases), so we try both: a directory and a `<name>.json` file. Errors are
// swallowed — if nothing is there, there's nothing to clear, and we don't
// want a missing path to fail a Replay.
//
// Used by the /preflight Replay path so the daemon comes up with zero saved
// cookies/localStorage/IndexedDB and the steps actually re-run from scratch.
export function clearPersistedSessionState(sessionName: string): void {
  const base = path.join(os.homedir(), '.agent-browser', 'sessions');
  for (const candidate of [
    path.join(base, sessionName),
    path.join(base, `${sessionName}.json`),
  ]) {
    try { fs.rmSync(candidate, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Wait for agent-browser to flush any pending state to disk after a daemon
// shuts down. We only need this when stopping a recording session so the
// next scenario can pick up the updated state. agent-browser writes the
// state file synchronously on shutdown today, so this is a generous safety
// margin rather than a hard requirement.
export async function flushSessionState(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

export { browserlessCdpUrl, config, pidFile };

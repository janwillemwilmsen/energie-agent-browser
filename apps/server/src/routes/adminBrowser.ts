import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BackendSchema,
  bootstrapCommand,
  cdpApiBase,
  cdpConnectUrl,
  currentBackend,
  envBackend,
  isRedacted,
  redactBackend,
  setBackendSetting,
  type BrowserBackend,
} from '../agentBrowser/backend.js';
import {
  DEFAULT_SESSION,
  agentBrowserEnv,
  closeSession,
  nativeBin,
  openSession,
  run,
  sessionStatus,
} from '../agentBrowser/driver.js';
import { config } from '../config.js';

// Admin → Browser: which browser the session daemon drives, whether it works,
// and (for the local backend) installing it.
//
// GET  /api/browser/health           the active backend + a reachability
//                                    probe; the Terminal/Network pages use it
//                                    for their badge and bootstrap button.
// GET  /api/admin/browser            the active backend (secrets redacted),
//                                    its source, and the env fallback.
// PUT  /api/admin/browser            save a backend (or null → back to env).
//                                    Closes the shared session so the next
//                                    bootstrap uses the new backend.
// POST /api/admin/browser/test       end-to-end check: restart the shared
//                                    session on the active backend and run a
//                                    command in it.
// GET  /api/admin/browser/doctor     `agent-browser doctor --json`.
// POST /api/admin/browser/install    start `agent-browser install [--with-deps]`
// GET  /api/admin/browser/install    its progress/log (single job at a time).

const PROBE_TIMEOUT_MS = 8_000;
const VERSION_TIMEOUT_MS = 4_000;
const DOCTOR_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

interface VersionInfo {
  browser: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
  webSocketDebuggerUrl: string | null;
}

async function probe(url: string, timeoutMs: number): Promise<
  { status: number; ok: boolean; body?: string; error?: undefined } |
  { status: null; ok: false; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    // Cap body read so a misbehaving server can't blow memory.
    const text = await res.text().catch(() => '');
    // browserless /docs redirects (301/302) to its hosted docs site — that's
    // still proof the service is up, so we treat 2xx AND 3xx as healthy.
    // Their own docker-compose healthcheck uses `curl -f`, which also accepts
    // 3xx, so this matches what they consider "ready".
    const ok = res.status >= 200 && res.status < 400;
    return { status: res.status, ok, body: text.slice(0, 4_000) };
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : (e?.message ?? String(e));
    return { status: null, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Reachability of a browserless HTTP API (self-hosted or browserless.io).
// /docs is what a self-hosted instance's own healthcheck uses; browserless.io
// token-gates it (401), so an authenticated /json/version answer also counts —
// it proves both reachability and a valid token.
async function probeBrowserless(httpsBase: string, token: string) {
  const docsUrl = `${httpsBase}/docs`;
  // /json/version is token-gated on browserless v2 (returns "Bad or missing
  // authentication" otherwise). Pass the token but never echo it back to
  // the client; the UI gets the version string, not the URL.
  const versionUrl = `${httpsBase}/json/version?token=${encodeURIComponent(token)}`;
  const startedAt = Date.now();
  const docs = await probe(docsUrl, PROBE_TIMEOUT_MS);
  let version: VersionInfo | null = null;
  const versionProbe = await probe(versionUrl, VERSION_TIMEOUT_MS);
  if (versionProbe.status === 200 && versionProbe.body) {
    try {
      const json = JSON.parse(versionProbe.body) as Record<string, string>;
      version = {
        browser: json['Browser'] ?? null,
        protocolVersion: json['Protocol-Version'] ?? null,
        userAgent: json['User-Agent'] ?? null,
        webSocketDebuggerUrl: json['webSocketDebuggerUrl'] ?? null,
      };
    } catch {
      /* ignore — leave version null */
    }
  }
  return {
    ok: docs.ok || version !== null,
    latencyMs: Date.now() - startedAt,
    docs: { url: docsUrl, status: docs.status, ok: docs.ok, error: docs.error ?? null },
    version,
  };
}

// Run the native binary once, capturing output (for doctor / install).
function runNative(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, onOutput?: (chunk: string) => void) {
  return new Promise<{ exitCode: number; output: string; timedOut: boolean }>((resolve) => {
    let output = '';
    let timedOut = false;
    const proc = spawn(nativeBin(), args, { shell: false, windowsHide: true, env });
    const collect = (buf: Buffer) => {
      const s = buf.toString();
      output += s;
      onOutput?.(s);
    };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: -1, output: output + `\n${e.message}`, timedOut }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, output, timedOut }); });
  });
}

// --- Install job (one at a time) --------------------------------------------------
interface InstallJob {
  args: string[];
  running: boolean;
  log: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}
let installJob: InstallJob | null = null;

const InstallBody = z.object({ withDeps: z.boolean().default(false) });

// PUT body: a backend, or null to drop the setting and fall back to env.
// Secret fields may carry the redaction hint from GET, meaning "keep what's stored".
const PutBody = z.object({ backend: BackendSchema.nullable() });

// A redacted secret in the PUT body means "keep": the stored one when the kind
// is unchanged, else the matching .env value (that's what the prefill showed).
function mergeSecrets(next: BrowserBackend, prev: BrowserBackend): BrowserBackend {
  if (next.kind === 'cdp' && isRedacted(next.token)) {
    return { ...next, token: prev.kind === 'cdp' ? prev.token : (process.env.BROWSERLESS_TOKEN ?? '') };
  }
  if (next.kind === 'browserless-cloud' && isRedacted(next.apiKey)) {
    const apiKey = prev.kind === 'browserless-cloud' ? prev.apiKey : (process.env.BROWSERLESS_API_KEY ?? '');
    if (!apiKey) throw new Error('No stored browserless.io API key to keep — enter one');
    return { ...next, apiKey };
  }
  if (next.kind === 'browserbase' && isRedacted(next.apiKey)) {
    const apiKey = prev.kind === 'browserbase' ? prev.apiKey : (process.env.BROWSERBASE_API_KEY ?? '');
    if (!apiKey) throw new Error('No stored Browserbase API key to keep — enter one');
    return { ...next, apiKey };
  }
  return next;
}

const hint = (s: string) => `••••${s.slice(-4)}`;

// The browserless.io provider vars a user may already have in .env — offered
// as prefill so switching to that backend doesn't mean retyping them. The key
// is redacted like every other secret; saving the hint keeps the env value.
function cloudPrefillFromEnv(): Partial<Extract<BrowserBackend, { kind: 'browserless-cloud' }>> {
  const e = process.env;
  const out: Partial<Extract<BrowserBackend, { kind: 'browserless-cloud' }>> = {};
  if (e.BROWSERLESS_API_KEY) out.apiKey = hint(e.BROWSERLESS_API_KEY);
  if (e.BROWSERLESS_API_URL && /^https?:\/\//.test(e.BROWSERLESS_API_URL)) out.apiUrl = e.BROWSERLESS_API_URL;
  if (e.BROWSERLESS_BROWSER_TYPE === 'chrome' || e.BROWSERLESS_BROWSER_TYPE === 'chromium') out.browserType = e.BROWSERLESS_BROWSER_TYPE;
  if (e.BROWSERLESS_TTL && Number(e.BROWSERLESS_TTL) > 0) out.ttlMs = Number(e.BROWSERLESS_TTL);
  if (e.BROWSERLESS_STEALTH) out.stealth = e.BROWSERLESS_STEALTH !== 'false';
  return out;
}

async function health() {
  const { backend, source } = currentBackend();
  const base = {
    kind: backend.kind,
    source,
    checkedAt: new Date().toISOString(),
    bootstrapCommand: bootstrapCommand(backend, DEFAULT_SESSION),
    session: sessionStatus(DEFAULT_SESSION),
  };
  switch (backend.kind) {
    case 'local':
      // Nothing remote to probe; `doctor` is the real check and the page runs it on demand.
      return { ...base, ok: true, latencyMs: 0, executablePath: backend.executablePath || null, remote: null };
    case 'cdp': {
      const r = await probeBrowserless(cdpApiBase(backend.url), backend.token);
      const cdp = new URL(cdpConnectUrl(backend));
      cdp.searchParams.delete('token');
      cdp.searchParams.delete('launch');
      return { ...base, ok: r.ok, latencyMs: r.latencyMs, executablePath: null, remote: { configuredUrl: cdp.toString(), docs: r.docs, version: r.version } };
    }
    case 'browserless-cloud': {
      const r = await probeBrowserless(backend.apiUrl.replace(/\/+$/, ''), backend.apiKey);
      return { ...base, ok: r.ok, latencyMs: r.latencyMs, executablePath: null, remote: { configuredUrl: backend.apiUrl, docs: r.docs, version: r.version } };
    }
    case 'browserbase':
      // No cheap unauthenticated-ish probe (sessions are created per key via
      // their SDK); the Test button is the check.
      return { ...base, ok: true, latencyMs: 0, executablePath: null, remote: null };
  }
}

export async function adminBrowserRoutes(app: FastifyInstance) {
  app.get('/api/browser/health', async () => health());

  app.get('/api/admin/browser', async () => {
    const { backend, source } = currentBackend();
    return {
      backend: redactBackend(backend),
      source,
      envBackend: redactBackend(envBackend()),
      cloudPrefill: cloudPrefillFromEnv(),
      browserbasePrefill: process.env.BROWSERBASE_API_KEY ? { apiKey: hint(process.env.BROWSERBASE_API_KEY) } : {},
      stealthEnabled: config.stealth.enabled,
    };
  });

  app.put('/api/admin/browser', async (req, reply) => {
    const { backend } = PutBody.parse(req.body);
    const prev = currentBackend().backend;
    let merged: BrowserBackend | null = null;
    try {
      merged = backend ? mergeSecrets(backend, prev) : null;
    } catch (e: any) {
      return reply.code(400).send({ error: 'validation_error', message: e?.message ?? String(e) });
    }
    setBackendSetting(merged);
    // The live daemon was started against the old backend; drop it so the
    // next bootstrap (Test below, a scenario run, the Terminal button) picks
    // up the new one. Best-effort: nothing to close is fine.
    await closeSession(DEFAULT_SESSION).catch(() => undefined);
    const now = currentBackend();
    return { backend: redactBackend(now.backend), source: now.source };
  });

  // End-to-end: a fresh shared-session daemon on the active backend, then a
  // real command through it. This is exactly what a scenario run does first,
  // so passing here means scenarios will get a browser.
  app.post('/api/admin/browser/test', async () => {
    const { backend } = currentBackend();
    const startedAt = Date.now();
    const steps: Array<{ step: string; ok: boolean; detail: string; ms: number }> = [];
    const timed = async (step: string, fn: () => Promise<string>) => {
      const t = Date.now();
      try {
        const detail = await fn();
        steps.push({ step, ok: true, detail, ms: Date.now() - t });
        return true;
      } catch (e: any) {
        steps.push({ step, ok: false, detail: e?.message ?? String(e), ms: Date.now() - t });
        return false;
      }
    };
    let ok = await timed('bootstrap session', async () => {
      await openSession(DEFAULT_SESSION, { intent: 'fresh' });
      return `daemon up (pid ${sessionStatus(DEFAULT_SESSION).pid ?? '?'})`;
    });
    if (ok) {
      ok = await timed('open page', async () => {
        const r = await run(['open', 'https://example.com'], { session: DEFAULT_SESSION, timeoutMs: 30_000 });
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`);
        return (r.stdout.trim() || 'ok').slice(0, 300);
      });
    }
    if (ok) {
      await timed('user agent', async () => {
        const r = await run(['eval', 'navigator.userAgent'], { session: DEFAULT_SESSION, timeoutMs: 15_000 });
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
        return r.stdout.trim().slice(0, 300);
      });
    }
    return { ok, kind: backend.kind, ms: Date.now() - startedAt, steps };
  });

  app.get('/api/admin/browser/doctor', async () => {
    const { backend } = currentBackend();
    const r = await runNative(['doctor', '--json'], agentBrowserEnv(), DOCTOR_TIMEOUT_MS);
    let checks: Array<{ category: string; id: string; message: string; status: string; fix?: string }> | null = null;
    try {
      // doctor may print non-JSON warnings first; take the last JSON object.
      const start = r.output.indexOf('{"checks"');
      if (start >= 0) checks = (JSON.parse(r.output.slice(start)) as { checks: typeof checks }).checks;
    } catch { /* fall through to raw output */ }
    return { kind: backend.kind, exitCode: r.exitCode, timedOut: r.timedOut, checks, raw: checks ? null : r.output.slice(-8_000) };
  });

  app.post('/api/admin/browser/install', async (req, reply) => {
    const { withDeps } = InstallBody.parse(req.body ?? {});
    if (installJob?.running) return reply.code(409).send({ error: 'install_running' });
    const args = ['install', ...(withDeps ? ['--with-deps'] : [])];
    const job: InstallJob = { args, running: true, log: '', exitCode: null, startedAt: new Date().toISOString(), finishedAt: null };
    installJob = job;
    void runNative(args, process.env, INSTALL_TIMEOUT_MS, (chunk) => { job.log = (job.log + chunk).slice(-64_000); })
      .then((r) => {
        job.running = false;
        job.exitCode = r.exitCode;
        job.finishedAt = new Date().toISOString();
        if (r.timedOut) job.log += `\n[server] install timed out after ${INSTALL_TIMEOUT_MS / 60_000} min\n`;
      });
    return reply.code(202).send({ started: true, args });
  });

  app.get('/api/admin/browser/install', async () => installJob ?? { running: false, log: '', exitCode: null, startedAt: null, finishedAt: null, args: [] });
}

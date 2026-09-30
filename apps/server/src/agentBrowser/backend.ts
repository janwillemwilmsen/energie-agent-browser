import { z } from 'zod';
import { config } from '../config.js';
import { getSetting, setSetting } from '../settings.js';

// Which browser the agent-browser daemon drives, as a value. Three backends:
//
//   local            agent-browser's own installed browser (`agent-browser
//                    install`). Chromium launch args travel via AGENT_BROWSER_ARGS.
//   cdp              A self-hosted browserless (or any CDP endpoint): the daemon
//                    runs `connect wss://host/chromium?token=…`. Two fields.
//   browserless-cloud browserless.io through agent-browser's built-in provider
//                    (AGENT_BROWSER_PROVIDER=browserless): the CLI creates a
//                    session via their REST API, so the API URL is https://,
//                    not wss://. browserless.io also works as `cdp` (its
//                    wss://…/chromium endpoint), which is the more reliable
//                    route for scenario runs.
//   browserbase      Browserbase through agent-browser's provider.
//
// Precedence: admin setting (DB, /admin/browser) → env (BROWSER_MODE and the
// BROWSERLESS_* vars, see config.ts). The setting is read on every spawn, so
// changing it needs no restart — only a re-bootstrap of the shared session,
// which the admin route does on save.

export const BackendSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    // Empty → agent-browser auto-detects its installed browser.
    executablePath: z.string().trim().max(1000).default(''),
  }),
  z.object({
    kind: z.literal('cdp'),
    url: z.string().trim().url().refine((u) => /^wss?:\/\//.test(u), 'must be a ws:// or wss:// URL'),
    token: z.string().trim().max(1000).default(''),
  }),
  z.object({
    kind: z.literal('browserless-cloud'),
    apiKey: z.string().trim().min(1),
    apiUrl: z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'must be an http(s):// URL (the provider talks REST, not wss)')
      .default('https://production-sfo.browserless.io'),
    browserType: z.enum(['chromium', 'chrome']).default('chromium'),
    ttlMs: z.number().int().min(10_000).max(3_600_000).default(300_000),
    stealth: z.boolean().default(true),
  }),
  // Browserbase through agent-browser's provider; the key alone identifies the project.
  z.object({
    kind: z.literal('browserbase'),
    apiKey: z.string().trim().min(1),
  }),
]);

export type BrowserBackend = z.infer<typeof BackendSchema>;
export type BackendKind = BrowserBackend['kind'];

const SETTING_KEY = 'browser_backend';

/** The backend derived from env alone (BROWSER_MODE + BROWSERLESS_URL/TOKEN). */
export function envBackend(): BrowserBackend {
  if (config.browser.mode === 'local') {
    return { kind: 'local', executablePath: config.browser.executablePath };
  }
  return { kind: 'cdp', url: config.browserless.url, token: config.browserless.token };
}

export function currentBackend(): { backend: BrowserBackend; source: 'setting' | 'env' } {
  const raw = getSetting(SETTING_KEY);
  if (raw) {
    const parsed = BackendSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { backend: parsed.data, source: 'setting' };
    // A setting the current schema can't read is ignored rather than fatal —
    // the env fallback keeps the app usable and the admin page shows the env one.
  }
  return { backend: envBackend(), source: 'env' };
}

export function setBackendSetting(backend: BrowserBackend | null): void {
  setSetting(SETTING_KEY, backend ? JSON.stringify(backend) : null);
}

// --- URL builders -------------------------------------------------------------

/** The browserless HTTP API base for a wss CDP URL (wss→https, ws→http). */
export function cdpApiBase(url: string): string {
  return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/+$/, '');
}

/** The CDP WebSocket URL the daemon connects to, with token + stealth launch params. */
export function cdpConnectUrl(backend: Extract<BrowserBackend, { kind: 'cdp' }>): string {
  const u = new URL(backend.url);
  // Browserless v2 expects the CDP WebSocket on /chromium (or /devtools/browser/<id>
  // for re-attach). The bare root is documented as a backward-compat alias but
  // the v2.x build here returns 404 on root and only honours /chromium.
  if (!u.pathname || u.pathname === '/') u.pathname = '/chromium';
  if (backend.token) u.searchParams.set('token', backend.token);

  if (config.stealth.enabled) {
    const launch: Record<string, unknown> = {};
    const args = splitArgs(config.stealth.launchArgs);
    if (args.length) launch.args = args;
    const ignore = splitArgs(config.stealth.ignoreDefaultArgs);
    if (ignore.length) launch.ignoreDefaultArgs = ignore;
    if (config.stealth.userAgent) launch.userAgent = config.stealth.userAgent;
    if (Object.keys(launch).length) {
      // Browserless v2 accepts JSON or base64 here. Base64 is more reliable
      // because URL-encoded JSON sometimes confuses query parsers (commas in
      // values, especially the trailing `}` getting interpreted oddly).
      u.searchParams.set('launch', Buffer.from(JSON.stringify(launch)).toString('base64'));
    }
  }
  return u.toString();
}

function splitArgs(s: string): string[] {
  return s.split(/\s+/).map((a) => a.trim()).filter(Boolean);
}

// Chromium launch args for the local backend, comma-joined for AGENT_BROWSER_ARGS
// (agent-browser accepts comma- or newline-separated). Starts from the same
// stealth args the cdp backend folds into the wss `launch` query, then appends
// the two flags Chromium needs to run inside a container: it can't use its
// sandbox as root, and the default /dev/shm is too small so shared memory must
// go to /tmp. Both are harmless on a dev box, so we add them everywhere rather
// than gating on "is this a container".
export function localBrowserArgs(): string {
  const args = config.stealth.enabled ? splitArgs(config.stealth.launchArgs) : [];
  for (const req of ['--no-sandbox', '--disable-dev-shm-usage']) {
    if (!args.includes(req)) args.push(req);
  }
  return args.join(',');
}

// --- Process wiring -------------------------------------------------------------

/**
 * The environment every agent-browser process gets for `backend`. Starts from
 * process.env with every BROWSERLESS_* var and AGENT_BROWSER_PROVIDER removed:
 * agent-browser reads those itself, and a stray AGENT_BROWSER_PROVIDER=browserless
 * in .env would otherwise switch a local backend into provider mode on every
 * spawn (the "Browserless request failed: builder error" symptom).
 */
export function backendEnv(backend: BrowserBackend): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(BROWSERLESS|BROWSERBASE|BROWSER_USE|KERNEL)_/.test(k) || k === 'AGENT_BROWSER_PROVIDER') continue;
    env[k] = v;
  }
  // The two runtime-applied stealth knobs apply to every backend — agent-browser
  // sets them on the page after connecting, wherever the browser runs.
  if (config.stealth.enabled) {
    if (config.stealth.userAgent) env.AGENT_BROWSER_USER_AGENT = config.stealth.userAgent;
    if (config.stealth.initScript) env.AGENT_BROWSER_INIT_SCRIPTS = config.stealth.initScript;
  }
  switch (backend.kind) {
    case 'local':
      // Launch args go via env: there is no wss `launch` query to fold them into.
      env.AGENT_BROWSER_ARGS = localBrowserArgs();
      if (backend.executablePath) env.AGENT_BROWSER_EXECUTABLE_PATH = backend.executablePath;
      else delete env.AGENT_BROWSER_EXECUTABLE_PATH;
      break;
    case 'cdp':
      // Make BROWSERLESS_API_KEY available so spawned commands never trigger an
      // auto-launch error, but do NOT set AGENT_BROWSER_PROVIDER — a self-hosted
      // browserless lacks the REST API the provider mode expects. We always go
      // through an explicit `connect wss://...` instead.
      env.BROWSERLESS_API_KEY = backend.token;
      env.BROWSERLESS_API_URL = cdpApiBase(backend.url);
      break;
    case 'browserless-cloud':
      env.AGENT_BROWSER_PROVIDER = 'browserless';
      env.BROWSERLESS_API_KEY = backend.apiKey;
      env.BROWSERLESS_API_URL = backend.apiUrl.replace(/\/+$/, '');
      env.BROWSERLESS_BROWSER_TYPE = backend.browserType;
      env.BROWSERLESS_TTL = String(backend.ttlMs);
      env.BROWSERLESS_STEALTH = backend.stealth ? 'true' : 'false';
      break;
    case 'browserbase':
      env.AGENT_BROWSER_PROVIDER = 'browserbase';
      env.BROWSERBASE_API_KEY = backend.apiKey;
      break;
  }
  return env;
}

/** Whether the daemon drives a remote browser (affects --session-name handling in the driver). */
export function isRemote(backend: BrowserBackend): boolean {
  return backend.kind !== 'local';
}

/**
 * The CLI args that boot a session daemon. For local and the cloud provider,
 * opening a cheap page is what launches/creates the browser; for cdp the
 * daemon connects to the remote endpoint.
 */
export function bootstrapArgs(backend: BrowserBackend): string[] {
  return backend.kind === 'cdp' ? ['connect', cdpConnectUrl(backend)] : ['open', 'about:blank'];
}

/**
 * The same bootstrap as a line for the Terminal page. The terminal shell
 * exports BROWSERLESS_CDP_URL for the cdp backend so the token never reaches
 * the client.
 */
export function bootstrapCommand(backend: BrowserBackend, session: string): string {
  return backend.kind === 'cdp'
    ? `agent-browser --session ${session} connect "%BROWSERLESS_CDP_URL%"`
    : `agent-browser --session ${session} open about:blank`;
}

/** The backend with its secrets replaced by a hint, for API responses. */
export function redactBackend(backend: BrowserBackend): BrowserBackend {
  const hint = (s: string) => (s ? `••••${s.slice(-4)}` : '');
  switch (backend.kind) {
    case 'local': return backend;
    case 'cdp': return { ...backend, token: hint(backend.token) };
    case 'browserless-cloud':
    case 'browserbase':
      return { ...backend, apiKey: hint(backend.apiKey) };
  }
}

/** True when `value` is a redaction hint produced by redactBackend (the UI sends it back to mean "keep"). */
export function isRedacted(value: string): boolean {
  return value.startsWith('••••');
}

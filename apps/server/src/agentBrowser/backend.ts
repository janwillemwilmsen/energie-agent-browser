import { z } from 'zod';
import { config } from '../config.js';
import { getSetting, setSetting } from '../settings.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../secrets.js';

// Which browser the agent-browser daemon drives, as a value. Five backends:
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
//   kernel           Kernel (onkernel.com) through agent-browser's provider.
//
// Storage: ONE admin setting holds the settings of every backend plus which
// one is active (BrowserConfig), so switching backends never means retyping
// credentials. The blob is encrypted at rest (secrets.ts) because it carries
// API keys. Precedence: that setting → env (BROWSER_MODE and the provider
// vars, see envConfig). The setting is read on every spawn, so changing it
// needs no restart — only a re-bootstrap of the shared session, which the
// admin route does on save.

const LocalSchema = z.object({
  kind: z.literal('local'),
  // Empty → agent-browser auto-detects its installed browser.
  executablePath: z.string().trim().max(1000).default(''),
});
const CdpSchema = z.object({
  kind: z.literal('cdp'),
  url: z.string().trim().url().refine((u) => /^wss?:\/\//.test(u), 'must be a ws:// or wss:// URL'),
  token: z.string().trim().max(1000).default(''),
});
const CloudSchema = z.object({
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
});
// Browserbase through agent-browser's provider; the key alone identifies the project.
const BrowserbaseSchema = z.object({
  kind: z.literal('browserbase'),
  apiKey: z.string().trim().min(1),
});
// Kernel through agent-browser's provider (KERNEL_* env, see backendEnv).
const KernelSchema = z.object({
  kind: z.literal('kernel'),
  apiKey: z.string().trim().min(1),
  headless: z.boolean().default(true),
  stealth: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(10).max(86_400).default(300),
  // An existing Kernel browser profile to load; empty = none.
  profileName: z.string().trim().max(200).default(''),
  profileSaveChanges: z.boolean().default(false),
});

/** The strict schema: what a backend must look like to be USED. */
export const BackendSchema = z.discriminatedUnion('kind', [
  LocalSchema,
  CdpSchema,
  CloudSchema,
  BrowserbaseSchema,
  KernelSchema,
]);

export type BrowserBackend = z.infer<typeof BackendSchema>;
export type BackendKind = BrowserBackend['kind'];
export const BACKEND_KINDS: readonly BackendKind[] = ['local', 'cdp', 'browserless-cloud', 'browserbase', 'kernel'];

// Stored form of each backend: the same fields, but the required ones (URL,
// API key) may be empty, so an unconfigured inactive backend is still a valid
// part of the config. The strict schema applies to the active one only
// (validateActive).
const maybe = z.string().trim().max(1000).default('');

// Browser-fingerprint stealth, shared by every backend but not honoured
// everywhere (see the table on the admin page): launch args reach the local
// browser (AGENT_BROWSER_ARGS) and a CDP browserless (the wss `launch` query);
// ignoreDefaultArgs is a browserless launch option only; the user agent and
// init script are applied by agent-browser on the page, so they travel with
// any backend. The .env STEALTH_* values are the defaults (config.ts).
export const StealthSchema = z.object({
  enabled: z.boolean().default(true),
  userAgent: z.string().trim().max(1000).default(''),
  /** Whitespace-separated Chromium flags; a value may contain commas. */
  launchArgs: z.string().trim().max(4000).default(''),
  ignoreDefaultArgs: z.string().trim().max(1000).default(''),
  /** Path of a page init script (served to agent-browser as AGENT_BROWSER_INIT_SCRIPTS). */
  initScript: z.string().trim().max(1000).default(''),
});
export type Stealth = z.infer<typeof StealthSchema>;

export const BrowserConfigSchema = z.object({
  active: z.enum(['local', 'cdp', 'browserless-cloud', 'browserbase', 'kernel']),
  backends: z.object({
    local: LocalSchema,
    cdp: CdpSchema.extend({ url: maybe }),
    'browserless-cloud': CloudSchema.extend({ apiKey: maybe }),
    browserbase: BrowserbaseSchema.extend({ apiKey: maybe }),
    kernel: KernelSchema.extend({ apiKey: maybe }),
  }),
  // Absent in blobs saved before stealth moved here → the env values.
  stealth: StealthSchema.default(() => envStealth()),
});
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

/** Stealth as .env describes it (STEALTH_* with the built-in defaults). */
export function envStealth(): Stealth {
  const s = config.stealth;
  return { enabled: s.enabled, userAgent: s.userAgent, launchArgs: s.launchArgs, ignoreDefaultArgs: s.ignoreDefaultArgs, initScript: s.initScript };
}

const SETTING_KEY = 'browser_backends';
/** Pre-config setting: a single backend. Read once and folded into the new shape. */
const LEGACY_SETTING_KEY = 'browser_backend';

/** Every backend as .env describes it: BROWSER_MODE picks the active one, the provider vars fill the rest. */
export function envConfig(): BrowserConfig {
  const e = process.env;
  const num = (v: string | undefined, fallback: number) => (v && Number(v) > 0 ? Number(v) : fallback);
  const bool = (v: string | undefined, fallback: boolean) => (v == null || v === '' ? fallback : v !== 'false');
  return {
    active: config.browser.mode === 'local' ? 'local' : 'cdp',
    backends: {
      local: { kind: 'local', executablePath: config.browser.executablePath },
      cdp: { kind: 'cdp', url: config.browserless.url, token: config.browserless.token },
      'browserless-cloud': {
        kind: 'browserless-cloud',
        apiKey: e.BROWSERLESS_API_KEY ?? '',
        apiUrl: e.BROWSERLESS_API_URL && /^https?:\/\//.test(e.BROWSERLESS_API_URL) ? e.BROWSERLESS_API_URL : 'https://production-sfo.browserless.io',
        browserType: e.BROWSERLESS_BROWSER_TYPE === 'chrome' ? 'chrome' : 'chromium',
        ttlMs: num(e.BROWSERLESS_TTL, 300_000),
        stealth: bool(e.BROWSERLESS_STEALTH, true),
      },
      browserbase: { kind: 'browserbase', apiKey: e.BROWSERBASE_API_KEY ?? '' },
      kernel: {
        kind: 'kernel',
        apiKey: e.KERNEL_API_KEY ?? '',
        headless: bool(e.KERNEL_HEADLESS, true),
        stealth: bool(e.KERNEL_STEALTH, false),
        timeoutSeconds: num(e.KERNEL_TIMEOUT_SECONDS, 300),
        profileName: e.KERNEL_PROFILE_NAME ?? '',
        profileSaveChanges: bool(e.KERNEL_PROFILE_SAVE_CHANGES, false),
      },
    },
    stealth: envStealth(),
  };
}

/** A legacy single-backend setting folded into the full shape (env fills the other kinds). */
function fromLegacy(raw: string): BrowserConfig | null {
  const parsed = BackendSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  const cfg = envConfig();
  cfg.active = parsed.data.kind;
  (cfg.backends as Record<string, unknown>)[parsed.data.kind] = parsed.data;
  return cfg;
}

export function currentConfig(): { config: BrowserConfig; source: 'setting' | 'env' } {
  const raw = getSetting(SETTING_KEY);
  if (raw) {
    try {
      const json = isEncrypted(raw) ? decryptSecret(raw) : raw;
      const parsed = BrowserConfigSchema.safeParse(JSON.parse(json));
      if (parsed.success) return { config: parsed.data, source: 'setting' };
    } catch {
      // A blob the current key can't open (SECRETS_KEY changed, key file lost)
      // or the current schema can't read is ignored rather than fatal — the
      // env fallback keeps the app usable and the admin page shows the env one.
    }
  }
  const legacy = getSetting(LEGACY_SETTING_KEY);
  if (legacy) {
    const cfg = fromLegacy(legacy);
    if (cfg) return { config: cfg, source: 'setting' };
  }
  return { config: envConfig(), source: 'env' };
}

/** The active backend and the stealth settings — what every spawn uses. */
export function currentBackend(): { backend: BrowserBackend; stealth: Stealth; source: 'setting' | 'env' } {
  const { config: cfg, source } = currentConfig();
  return { backend: cfg.backends[cfg.active] as BrowserBackend, stealth: cfg.stealth, source };
}

/** The strict check for the active backend; returns the problem, or null when it can be used. */
export function validateActive(cfg: BrowserConfig): string | null {
  const r = BackendSchema.safeParse(cfg.backends[cfg.active]);
  if (r.success) return null;
  const issue = r.error.issues[0];
  return `${cfg.active}: ${issue?.path.join('.') || 'value'} ${issue?.message ?? 'invalid'}`;
}

/** Save the whole config (encrypted), or null to drop it and fall back to env. */
export function setConfigSetting(cfg: BrowserConfig | null): void {
  setSetting(SETTING_KEY, cfg ? encryptSecret(JSON.stringify(cfg)) : null);
  // Once the new shape exists (or the override is dropped) the legacy value is history.
  setSetting(LEGACY_SETTING_KEY, null);
}

// --- URL builders -------------------------------------------------------------

/** The browserless HTTP API base for a wss CDP URL (wss→https, ws→http). */
export function cdpApiBase(url: string): string {
  return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/+$/, '');
}

/** The CDP WebSocket URL the daemon connects to, with token + stealth launch params. */
export function cdpConnectUrl(backend: Extract<BrowserBackend, { kind: 'cdp' }>, stealth: Stealth): string {
  const u = new URL(backend.url);
  // Browserless v2 expects the CDP WebSocket on /chromium (or /devtools/browser/<id>
  // for re-attach). The bare root is documented as a backward-compat alias but
  // the v2.x build here returns 404 on root and only honours /chromium.
  if (!u.pathname || u.pathname === '/') u.pathname = '/chromium';
  if (backend.token) u.searchParams.set('token', backend.token);

  if (stealth.enabled) {
    const launch: Record<string, unknown> = {};
    const args = splitArgs(stealth.launchArgs);
    if (args.length) launch.args = args;
    const ignore = splitArgs(stealth.ignoreDefaultArgs);
    if (ignore.length) launch.ignoreDefaultArgs = ignore;
    if (stealth.userAgent) launch.userAgent = stealth.userAgent;
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
export function localBrowserArgs(stealth: Stealth): string {
  const args = stealth.enabled ? splitArgs(stealth.launchArgs) : [];
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
export function backendEnv(backend: BrowserBackend, stealth: Stealth = envStealth()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(BROWSERLESS|BROWSERBASE|BROWSER_USE|KERNEL)_/.test(k) || k === 'AGENT_BROWSER_PROVIDER') continue;
    env[k] = v;
  }
  // The two runtime-applied stealth knobs apply to every backend — agent-browser
  // sets them on the page after connecting, wherever the browser runs.
  if (stealth.enabled) {
    if (stealth.userAgent) env.AGENT_BROWSER_USER_AGENT = stealth.userAgent;
    if (stealth.initScript) env.AGENT_BROWSER_INIT_SCRIPTS = stealth.initScript;
  }
  switch (backend.kind) {
    case 'local':
      // Launch args go via env: there is no wss `launch` query to fold them into.
      env.AGENT_BROWSER_ARGS = localBrowserArgs(stealth);
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
    case 'kernel':
      env.AGENT_BROWSER_PROVIDER = 'kernel';
      env.KERNEL_API_KEY = backend.apiKey;
      env.KERNEL_HEADLESS = backend.headless ? 'true' : 'false';
      env.KERNEL_STEALTH = backend.stealth ? 'true' : 'false';
      env.KERNEL_TIMEOUT_SECONDS = String(backend.timeoutSeconds);
      if (backend.profileName) {
        env.KERNEL_PROFILE_NAME = backend.profileName;
        env.KERNEL_PROFILE_SAVE_CHANGES = backend.profileSaveChanges ? 'true' : 'false';
      }
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
export function bootstrapArgs(backend: BrowserBackend, stealth: Stealth): string[] {
  return backend.kind === 'cdp' ? ['connect', cdpConnectUrl(backend, stealth)] : ['open', 'about:blank'];
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

// --- Secrets in API responses ---------------------------------------------------

/** The secret field of each kind (one each); the rest is plain configuration. */
const SECRET_FIELD: Partial<Record<BackendKind, 'token' | 'apiKey'>> = {
  cdp: 'token',
  'browserless-cloud': 'apiKey',
  browserbase: 'apiKey',
  kernel: 'apiKey',
};

const hint = (s: string) => (s ? `••••${s.slice(-4)}` : '');

/** The config with every secret replaced by a hint, for API responses. */
export function redactConfig(cfg: BrowserConfig): BrowserConfig {
  const backends = { ...cfg.backends } as Record<string, Record<string, unknown>>;
  for (const [kind, field] of Object.entries(SECRET_FIELD)) {
    const b = backends[kind]!;
    backends[kind] = { ...b, [field]: hint(String(b[field] ?? '')) };
  }
  return { ...cfg, backends: backends as BrowserConfig['backends'] };
}

/** True when `value` is a redaction hint produced by redactConfig (the UI sends it back to mean "keep"). */
export function isRedacted(value: string): boolean {
  return value.startsWith('••••');
}

/**
 * A redacted secret in a saved config means "keep what is stored" — per
 * backend, so credentials of inactive backends survive a save untouched.
 * `prev` is what the GET showed: the stored config, or the env one.
 */
export function mergeSecrets(next: BrowserConfig, prev: BrowserConfig): BrowserConfig {
  const backends = { ...next.backends } as Record<string, Record<string, unknown>>;
  const prevBackends = prev.backends as Record<string, Record<string, unknown>>;
  for (const [kind, field] of Object.entries(SECRET_FIELD)) {
    const value = String(backends[kind]![field] ?? '');
    if (isRedacted(value)) backends[kind] = { ...backends[kind], [field]: prevBackends[kind]![field] ?? '' };
  }
  return { ...next, backends: backends as BrowserConfig['backends'] };
}

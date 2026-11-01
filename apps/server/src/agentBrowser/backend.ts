import { z } from 'zod';
import { BrowserBackendKind } from '@eab/shared';
import { config } from '../config.js';
import { getSetting, setSetting } from '../settings.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../secrets.js';
import { resolveChromeConnectUrl } from './chromeRemote.js';
import { cdpUrlFor, requirePc } from '../connector/hub.js';

// Which browser the agent-browser daemon drives, as a value. Seven backends:
//
//   local            agent-browser's own installed browser (`agent-browser
//                    install`). Chromium launch args travel via AGENT_BROWSER_ARGS.
//   connector        The Chrome on the user's own PC, reached through the
//                    connector the PC runs (connector/hub.ts): the daemon
//                    connects to a loopback URL on this server and the hub
//                    relays to the PC. One optional field, which PC.
//   chrome           A Chrome the user started with --remote-debugging-port
//                    (their own PC, reached over a tunnel). One field, host:port;
//                    the daemon runs `connect ws://host:port/devtools/browser/<id>`
//                    with the <id> looked up from /json/version at connect time
//                    (chromeRemote.ts).
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
// Which paired PC to drive, by the name it connected with; empty = the most
// recently connected one. Always valid as a setting — whether a PC is
// connected right now is checked at bootstrap, with a message saying what to run.
const ConnectorSchema = z.object({
  kind: z.literal('connector'),
  pc: z.string().trim().max(60).default(''),
});
// host:port of the remote-debugging Chrome. ws(s):// or http(s):// — only the
// host and port matter (chromeRemote.ts builds the real URLs); no token, Chrome
// has none, which is why it must only ever be reachable through a tunnel.
const ChromeSchema = z.object({
  kind: z.literal('chrome'),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^(wss?|https?):\/\//.test(u), 'must be a ws://, wss://, http:// or https:// URL, e.g. http://127.0.0.1:9222'),
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
  ConnectorSchema,
  ChromeSchema,
  CdpSchema,
  CloudSchema,
  BrowserbaseSchema,
  KernelSchema,
]);

export type BrowserBackend = z.infer<typeof BackendSchema>;
export type BackendKind = BrowserBackend['kind'];
// The shared enum (scenario schema, pickers) and this union must agree; the
// assignment fails to type-check if a kind is added on one side only.
export const BACKEND_KINDS: readonly BackendKind[] = BrowserBackendKind.options;

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
  active: BrowserBackendKind,
  backends: z.object({
    local: LocalSchema,
    // Defaulted: blobs saved before these backends existed must still parse,
    // or currentConfig would silently fall back to env.
    connector: ConnectorSchema.default({ kind: 'connector', pc: '' }),
    chrome: ChromeSchema.extend({ url: maybe }).default({ kind: 'chrome', url: '' }),
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
      // No env form: pairing a PC or a tunnel to one is set up on the admin page, not in .env.
      connector: { kind: 'connector', pc: '' },
      chrome: { kind: 'chrome', url: '' },
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

/**
 * The backend a spawn uses — the active one, or `override` (a Scenario's
 * pinned backend) — plus the stealth settings. An override must be usable
 * (strict schema: its URL / API key filled in on the admin page); an
 * unusable one throws rather than silently running on the active browser.
 */
export function currentBackend(override?: BackendKind | null): { backend: BrowserBackend; stealth: Stealth; source: 'setting' | 'env' } {
  const { config: cfg, source } = currentConfig();
  const kind = override ?? cfg.active;
  if (override && override !== cfg.active) {
    const r = BackendSchema.safeParse(cfg.backends[override]);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new Error(
        `browser "${override}" is not configured on Admin → Browser (${issue?.path.join('.') || 'value'} ${issue?.message ?? 'invalid'})`,
      );
    }
  }
  return { backend: cfg.backends[kind] as BrowserBackend, stealth: cfg.stealth, source };
}

/** Every backend kind with whether it is usable as-is (strict schema), for pickers. */
export function backendAvailability(): { active: BackendKind; backends: { kind: BackendKind; configured: boolean }[] } {
  const { config: cfg } = currentConfig();
  return {
    active: cfg.active,
    backends: BACKEND_KINDS.map((kind) => ({ kind, configured: BackendSchema.safeParse(cfg.backends[kind]).success })),
  };
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
  // The two runtime-applied stealth knobs apply to every backend that is a
  // bare automation Chromium — agent-browser sets them on the page after
  // connecting, wherever the browser runs. NOT to the user's own Chrome
  // (connector / chrome): that is a real browser with a real profile, and
  // every patch makes it less consistent — a UA override says one version
  // while the Sec-CH-UA client hints Chrome still sends say the real one, the
  // init script's WebGL/plugins/languages contradict the machine's own — which
  // is exactly what Cloudflare-style checks look for.
  if (stealth.enabled && !isUsersOwnBrowser(backend)) {
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
    case 'connector':
    case 'chrome':
      // Nothing to pass: the daemon gets the connect URL on its command line
      // (bootstrapArgs), and the user's Chrome is already running with
      // whatever flags it was given — launch args cannot apply.
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

/** The user's own Chrome, already running with their profile: no stealth patching applies. */
export function isUsersOwnBrowser(backend: BrowserBackend): boolean {
  return backend.kind === 'connector' || backend.kind === 'chrome';
}

/**
 * The CLI args that boot a session daemon. For local and the cloud provider,
 * opening a cheap page is what launches/creates the browser; for cdp the
 * daemon connects to the remote endpoint; for chrome it connects to the
 * browser's current WebSocket URL, looked up now (throws when Chrome is not
 * reachable, with the reason).
 */
export async function bootstrapArgs(backend: BrowserBackend, stealth: Stealth): Promise<string[]> {
  switch (backend.kind) {
    case 'cdp': return ['connect', cdpConnectUrl(backend, stealth)];
    case 'chrome': return ['connect', await resolveChromeConnectUrl(backend.url)];
    case 'connector': return ['connect', connectorConnectUrl(backend)];
    default: return ['open', 'about:blank'];
  }
}

/** The loopback relay URL for the configured PC; throws (what to run) when no PC is connected. */
export function connectorConnectUrl(backend: Extract<BrowserBackend, { kind: 'connector' }>): string {
  return cdpUrlFor(requirePc(backend.pc).id);
}

/** The env var the Terminal shell exports with the connect URL, per backend (null: the backend opens a page instead). */
export function connectUrlEnvVar(backend: BrowserBackend): 'BROWSERLESS_CDP_URL' | 'CHROME_CDP_URL' | 'CONNECTOR_CDP_URL' | null {
  switch (backend.kind) {
    case 'cdp': return 'BROWSERLESS_CDP_URL';
    case 'chrome': return 'CHROME_CDP_URL';
    case 'connector': return 'CONNECTOR_CDP_URL';
    default: return null;
  }
}

/**
 * The same bootstrap as a line for the Terminal page. The terminal shell
 * exports the connect URL (BROWSERLESS_CDP_URL / CHROME_CDP_URL) so the token
 * never reaches the client and the line stays valid when Chrome restarts.
 * cmd.exe and sh expand variables differently; the line follows the server's
 * shell (ws/terminal.ts).
 */
export function bootstrapCommand(backend: BrowserBackend, session: string): string {
  const envVar = connectUrlEnvVar(backend);
  if (!envVar) return `agent-browser --session ${session} open about:blank`;
  const ref = process.platform === 'win32' ? `%${envVar}%` : `$${envVar}`;
  return `agent-browser --session ${session} connect "${ref}"`;
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

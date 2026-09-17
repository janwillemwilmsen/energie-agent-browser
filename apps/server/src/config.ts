import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Configuration as a value. loadConfig(env) is pure: it reads the given
// environment and returns either the config or the list of missing variables.
// The exported `config` keeps the shape every module already uses, but
// resolves lazily on first access — from process.env in production, or from
// whatever a test injected with setConfig — so importing a module that reads
// config no longer needs a real environment. dotenv runs only when an entry
// point asks for it (loadDotenv), never on import.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const DEFAULT_STEALTH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Whitespace-separated — values may themselves contain commas (e.g. --disable-features=A,B).
const DEFAULT_STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-default-browser-check',
  '--no-first-run',
].join(' ');

const DEFAULT_STEALTH_IGNORE = '--enable-automation';

const stealthInitPath = path.resolve(__dirname, '..', 'stealth', 'init.js');

export type BrowserMode = 'browserless' | 'local';

export interface Config {
  port: number;
  webOrigin: string;
  dataDir: string;
  migrationsDir: string;
  browser: {
    // 'browserless' → the session daemon connects to a remote CDP over wss
    //   (the original behaviour; requires BROWSERLESS_URL/TOKEN).
    // 'local'       → the session daemon launches agent-browser's locally-installed
    //   browser (`agent-browser install [--with-deps]`). No browserless needed.
    mode: BrowserMode;
    // Explicit browser executable for local mode. agent-browser also honours
    // AGENT_BROWSER_EXECUTABLE_PATH directly; empty means "let it auto-detect".
    executablePath: string;
  };
  browserless: {
    // Only required in browserless mode; unused (and optional) when mode=local.
    url: string;
    token: string;
  };
  auth: {
    // Single shared login gate in front of the whole app. Set APP_AUTH_ENABLED
    // to "false" to turn it off. Credentials + signing secret come from env.
    enabled: boolean;
    user: string;
    pass: string;
    // Optional explicit signing secret; when empty a random one is generated and
    // persisted to DATA_DIR/auth-secret so sessions survive restarts.
    secret: string;
  };
  agentBrowserBin: string;
  sessionIdleTtlMs: number;
  // Scenario video recording taps agent-browser's live CDP screencast on the
  // EXISTING stealthed page and muxes the JPEG frames to a .webm with ffmpeg.
  ffmpegPath: string;
  // Constant output frame rate; the latest frame is re-emitted at this cadence.
  recordingFps: number;
  // Pause after `record start` before running any steps, so ffmpeg + the CDP
  // screencast are actually capturing before the first action.
  recordingWarmupMs: number;
  // When true, the runner probes and logs the page state right after `record start`.
  recordingDebug: boolean;
  stealth: {
    enabled: boolean;
    userAgent: string;
    launchArgs: string;
    ignoreDefaultArgs: string;
    initScript: string;
  };
  email: {
    // Resend API key. Empty → email notifications are disabled.
    resendApiKey: string;
    // Sender. The domain must be verified in Resend.
    from: string;
    // Where replies go; empty → no Reply-To header.
    replyTo: string;
    // Base URL used for links in emails (to the /runs page).
    appBaseUrl: string;
  };
}

export type LoadConfigResult = { ok: true; config: Config } | { ok: false; missing: string[] };

/** Build the config from an environment. Pure: no files, no process state. */
export function loadConfig(env: NodeJS.ProcessEnv, opts: { root?: string } = {}): LoadConfigResult {
  const root = opts.root ?? repoRoot;
  const missing: string[] = [];
  const required = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? '';
  };
  const optional = (name: string, fallback: string): string => env[name] ?? fallback;

  const mode: BrowserMode = optional('BROWSER_MODE', 'browserless') === 'local' ? 'local' : 'browserless';

  const config: Config = {
    port: Number(optional('PORT', '3001')),
    webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
    dataDir: path.resolve(root, optional('DATA_DIR', './data')),
    migrationsDir: path.resolve(root, optional('MIGRATIONS_DIR', './migrations')),
    browser: {
      mode,
      executablePath: optional('AGENT_BROWSER_EXECUTABLE_PATH', ''),
    },
    browserless: {
      url: mode === 'local' ? optional('BROWSERLESS_URL', '') : required('BROWSERLESS_URL'),
      token: mode === 'local' ? optional('BROWSERLESS_TOKEN', '') : required('BROWSERLESS_TOKEN'),
    },
    auth: {
      enabled: optional('APP_AUTH_ENABLED', 'true') !== 'false',
      user: optional('APP_AUTH_USER', 'jw@ikkoop.nl'),
      pass: optional('APP_AUTH_PASS', 'jw@ikkoop.nl'),
      secret: optional('APP_AUTH_SECRET', ''),
    },
    agentBrowserBin: optional('AGENT_BROWSER_BIN', 'agent-browser'),
    sessionIdleTtlMs: Number(optional('SESSION_IDLE_TTL_MS', '300000')),
    ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
    recordingFps: Number(optional('RECORDING_FPS', '10')),
    recordingWarmupMs: Number(optional('RECORDING_WARMUP_MS', '1500')),
    recordingDebug: optional('RECORDING_DEBUG', '0') === '1',
    stealth: {
      enabled: optional('STEALTH_ENABLED', 'true') !== 'false',
      userAgent: optional('STEALTH_USER_AGENT', DEFAULT_STEALTH_UA),
      launchArgs: optional('STEALTH_LAUNCH_ARGS', DEFAULT_STEALTH_ARGS),
      ignoreDefaultArgs: optional('STEALTH_IGNORE_DEFAULT_ARGS', DEFAULT_STEALTH_IGNORE),
      initScript: optional('STEALTH_INIT_SCRIPT', stealthInitPath),
    },
    email: {
      resendApiKey: optional('RESEND_API_KEY', ''),
      from: optional('EMAIL_FROM', 'Energie Agent <onboarding@resend.dev>'),
      replyTo: optional('EMAIL_REPLY_TO', ''),
      appBaseUrl: optional('APP_BASE_URL', ''),
    },
  };
  return missing.length ? { ok: false, missing } : { ok: true, config };
}

/** Load the repo's .env into process.env. Entry points call this; nothing runs it on import. */
export function loadDotenv(): void {
  dotenv.config({ path: path.join(repoRoot, '.env') });
}

// --- The app's instance --------------------------------------------------------------

let current: Config | null = null;

/** Install the config the app runs with (main after loadConfig, or a test). */
export function setConfig(value: Config): void {
  current = value;
}

/** Forget the installed config; the next access reloads from process.env. */
export function resetConfig(): void {
  current = null;
}

function resolved(): Config {
  if (current) return current;
  const loaded = loadConfig(process.env);
  if (!loaded.ok) throw new Error(`Missing required env var(s): ${loaded.missing.join(', ')}`);
  current = loaded.config;
  return current;
}

/**
 * The configuration every module reads. Resolves lazily on first access, so
 * importing a module never needs an environment; running it does.
 */
export const config: Config = {
  get port() { return resolved().port; },
  get webOrigin() { return resolved().webOrigin; },
  get dataDir() { return resolved().dataDir; },
  get migrationsDir() { return resolved().migrationsDir; },
  get browser() { return resolved().browser; },
  get browserless() { return resolved().browserless; },
  get auth() { return resolved().auth; },
  get agentBrowserBin() { return resolved().agentBrowserBin; },
  get sessionIdleTtlMs() { return resolved().sessionIdleTtlMs; },
  get ffmpegPath() { return resolved().ffmpegPath; },
  get recordingFps() { return resolved().recordingFps; },
  get recordingWarmupMs() { return resolved().recordingWarmupMs; },
  get recordingDebug() { return resolved().recordingDebug; },
  get stealth() { return resolved().stealth; },
  get email() { return resolved().email; },
};

/** The browserless HTTP API base for its configured wss URL (wss→https, ws→http). */
export function browserlessApiBase(): string {
  return config.browserless.url
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/+$/, '');
}

export function browserlessCdpUrl(): string {
  const u = new URL(config.browserless.url);
  // Browserless v2 expects the CDP WebSocket on /chromium (or /devtools/browser/<id>
  // for re-attach). The bare root is documented as a backward-compat alias but
  // the v2.x build here returns 404 on root and only honours /chromium.
  if (!u.pathname || u.pathname === '/' || u.pathname === '') {
    u.pathname = '/chromium';
  }
  u.searchParams.set('token', config.browserless.token);

  if (config.stealth.enabled) {
    const launch: Record<string, unknown> = {};
    const args = config.stealth.launchArgs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (args.length) launch.args = args;
    const ignore = config.stealth.ignoreDefaultArgs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (ignore.length) launch.ignoreDefaultArgs = ignore;
    if (config.stealth.userAgent) launch.userAgent = config.stealth.userAgent;
    if (Object.keys(launch).length) {
      // Browserless v2 accepts JSON or base64 here. Base64 is more reliable
      // because URL-encoded JSON sometimes confuses query parsers (commas in
      // values, especially the trailing `}` getting interpreted oddly).
      const b64 = Buffer.from(JSON.stringify(launch)).toString('base64');
      u.searchParams.set('launch', b64);
    }
  }

  return u.toString();
}

// Chromium launch args for local mode, comma-joined for AGENT_BROWSER_ARGS
// (agent-browser accepts comma- or newline-separated). Starts from the same
// stealth args that browserless mode folds into the wss `launch` query, then
// appends the two flags Chromium needs to run inside a container: it can't use
// its sandbox as root, and the default /dev/shm is too small so shared memory
// must go to /tmp. Both are harmless on a dev box, so we add them in every
// local-mode environment rather than gating on "is this a container".
export function localBrowserArgs(): string {
  const args = config.stealth.enabled
    ? config.stealth.launchArgs.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    : [];
  for (const req of ['--no-sandbox', '--disable-dev-shm-usage']) {
    if (!args.includes(req)) args.push(req);
  }
  return args.join(',');
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

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

// 'browserless' → the session daemon connects to a remote CDP over wss (the
//   original behaviour; requires BROWSERLESS_URL/TOKEN).
// 'local'       → the session daemon launches agent-browser's locally-installed
//   browser (`agent-browser install [--with-deps]`). No browserless needed, and
//   BROWSERLESS_URL/TOKEN become optional.
const BROWSER_MODE: 'browserless' | 'local' =
  optional('BROWSER_MODE', 'browserless') === 'local' ? 'local' : 'browserless';

export const config = {
  port: Number(optional('PORT', '3001')),
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
  dataDir: path.resolve(repoRoot, optional('DATA_DIR', './data')),
  migrationsDir: path.resolve(repoRoot, optional('MIGRATIONS_DIR', './migrations')),
  browser: {
    mode: BROWSER_MODE,
    // Explicit browser executable for local mode. agent-browser also honours
    // AGENT_BROWSER_EXECUTABLE_PATH directly; empty means "let it auto-detect"
    // (system Chrome, or the copy fetched by `agent-browser install`).
    executablePath: optional('AGENT_BROWSER_EXECUTABLE_PATH', ''),
  },
  browserless: {
    // Only required in browserless mode; unused (and optional) when mode=local.
    url: BROWSER_MODE === 'local' ? optional('BROWSERLESS_URL', '') : required('BROWSERLESS_URL'),
    token: BROWSER_MODE === 'local' ? optional('BROWSERLESS_TOKEN', '') : required('BROWSERLESS_TOKEN'),
  },
  agentBrowserBin: optional('AGENT_BROWSER_BIN', 'agent-browser'),
  sessionIdleTtlMs: Number(optional('SESSION_IDLE_TTL_MS', '300000')),
  // Scenario video recording is done by tapping agent-browser's live CDP
  // screencast (the `stream` WebSocket) on the EXISTING stealthed page and
  // muxing the JPEG frames to a .webm with ffmpeg. This avoids `agent-browser
  // record`, which spins up a fresh, un-stealthed browser context and gets
  // blocked by Cloudflare/CloudFront on WAF-protected sites.
  ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
  // Constant output frame rate. The screencast only emits frames on visual
  // change, so we re-emit the latest frame at this cadence to keep wall-clock
  // duration accurate and fill static stretches. 10 is plenty for a debug clip.
  recordingFps: Number(optional('RECORDING_FPS', '10')),
  // Pause after `record start` before running any steps, so ffmpeg + the CDP
  // screencast are actually capturing before the first action. Without it the
  // opening steps (navigate, cookie-consent click, …) fall into the recorder's
  // warm-up gap and the video's first seconds are blank/white. Raise it if early
  // steps are still missed on a slow host.
  recordingWarmupMs: Number(optional('RECORDING_WARMUP_MS', '1500')),
  // When '1', the runner probes and logs the page state (title/url/UA/webdriver)
  // right after `record start`, into the run log. Lets you see whether recording
  // reloaded the page into a WAF/CloudFront error — without the AB_DRIVER_DEBUG
  // flood. Off by default.
  recordingDebug: optional('RECORDING_DEBUG', '0') === '1',
  stealth: {
    enabled: optional('STEALTH_ENABLED', 'true') !== 'false',
    userAgent: optional('STEALTH_USER_AGENT', DEFAULT_STEALTH_UA),
    launchArgs: optional('STEALTH_LAUNCH_ARGS', DEFAULT_STEALTH_ARGS),
    ignoreDefaultArgs: optional('STEALTH_IGNORE_DEFAULT_ARGS', DEFAULT_STEALTH_IGNORE),
    initScript: optional('STEALTH_INIT_SCRIPT', stealthInitPath),
  },
} as const;

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

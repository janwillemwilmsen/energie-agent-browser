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

export const config = {
  port: Number(optional('PORT', '3001')),
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
  dataDir: path.resolve(repoRoot, optional('DATA_DIR', './data')),
  migrationsDir: path.resolve(repoRoot, optional('MIGRATIONS_DIR', './migrations')),
  browserless: {
    url: required('BROWSERLESS_URL'),
    token: required('BROWSERLESS_TOKEN'),
  },
  agentBrowserBin: optional('AGENT_BROWSER_BIN', 'agent-browser'),
  sessionIdleTtlMs: Number(optional('SESSION_IDLE_TTL_MS', '300000')),
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

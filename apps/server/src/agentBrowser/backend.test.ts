import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { loadConfig, resetConfig, setConfig } from '../config.js';
import { setDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { getSetting, setSetting } from '../settings.js';
import { _setSecretsKeyForTests, decryptSecret, encryptSecret, isEncrypted } from '../secrets.js';
import {
  backendEnv,
  cdpConnectUrl,
  currentBackend,
  currentConfig,
  envConfig,
  mergeSecrets,
  redactConfig,
  setConfigSetting,
  validateActive,
  type BrowserConfig,
} from './backend.js';

// The browser config over an in-memory database and a fixed key: storage,
// encryption, legacy fold-in, redaction round trip and the kernel env wiring.

beforeAll(() => {
  const loaded = loadConfig({ BROWSER_MODE: 'local', KERNEL_API_KEY: 'env-kernel-key' });
  if (!loaded.ok) throw new Error(loaded.missing.join(', '));
  setConfig(loaded.config);
  process.env.KERNEL_API_KEY = 'env-kernel-key';
  const db = new Database(':memory:');
  setDb(db);
  migrate(db);
  _setSecretsKeyForTests(crypto.randomBytes(32));
});

afterAll(() => {
  delete process.env.KERNEL_API_KEY;
  _setSecretsKeyForTests(null);
  resetConfig();
});

beforeEach(() => {
  setSetting('browser_backends', null);
  setSetting('browser_backend', null);
});

function kernelConfig(apiKey: string): BrowserConfig {
  const cfg = envConfig();
  cfg.active = 'kernel';
  cfg.backends.kernel = { ...cfg.backends.kernel, apiKey, headless: false, profileName: 'shop', profileSaveChanges: true };
  return cfg;
}

describe('secrets', () => {
  it('round-trips and is tamper-evident', () => {
    const enc = encryptSecret('hello');
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain('hello');
    expect(decryptSecret(enc)).toBe('hello');
    expect(() => decryptSecret(enc.slice(0, -2) + 'AA')).toThrow();
  });
});

describe('browser config', () => {
  it('falls back to env when nothing is stored, with every backend prefilled', () => {
    const { config, source } = currentConfig();
    expect(source).toBe('env');
    expect(config.active).toBe('local');
    expect(config.backends.kernel.apiKey).toBe('env-kernel-key');
  });

  it('stores the whole config encrypted and reads the active backend back', () => {
    setConfigSetting(kernelConfig('sk-123456'));
    const raw = getSetting('browser_backends')!;
    expect(isEncrypted(raw)).toBe(true);
    expect(raw).not.toContain('sk-123456');
    expect(currentConfig().source).toBe('setting');
    expect(currentBackend().backend).toMatchObject({ kind: 'kernel', apiKey: 'sk-123456', headless: false });
  });

  it('folds a legacy single-backend setting into the new shape', () => {
    setSetting('browser_backend', JSON.stringify({ kind: 'browserbase', apiKey: 'bb-key' }));
    const { config, source } = currentConfig();
    expect(source).toBe('setting');
    expect(config.active).toBe('browserbase');
    expect(config.backends.browserbase.apiKey).toBe('bb-key');
    expect(config.backends.kernel.apiKey).toBe('env-kernel-key');
  });

  it('ignores a blob the current key cannot open and falls back to env', () => {
    setConfigSetting(kernelConfig('sk-123456'));
    _setSecretsKeyForTests(crypto.randomBytes(32));
    expect(currentConfig().source).toBe('env');
  });

  it('redacts secrets and keeps them per backend when the hint comes back', () => {
    const stored = kernelConfig('sk-123456');
    stored.backends.browserbase.apiKey = 'bb-key';
    const redacted = redactConfig(stored);
    expect(redacted.backends.kernel.apiKey).toBe('••••3456');
    expect(redacted.backends.browserbase.apiKey).toBe('••••-key');
    expect(redacted.backends.cdp.token).toBe('');

    // The UI edits a non-secret and sends the hints back untouched.
    const edited = { ...redacted, backends: { ...redacted.backends, kernel: { ...redacted.backends.kernel, headless: true } } };
    const merged = mergeSecrets(edited, stored);
    expect(merged.backends.kernel).toMatchObject({ apiKey: 'sk-123456', headless: true });
    expect(merged.backends.browserbase.apiKey).toBe('bb-key');
  });

  it('only validates the active backend strictly', () => {
    const cfg = kernelConfig('sk-1');
    cfg.backends.cdp.url = ''; // inactive and empty: fine
    expect(validateActive(cfg)).toBeNull();
    cfg.backends.kernel.apiKey = '';
    expect(validateActive(cfg)).toMatch(/^kernel: apiKey/);
  });

  it('stores stealth with the backends and routes each knob to the backends that honour it', () => {
    const cfg = kernelConfig('sk-1');
    cfg.active = 'local';
    cfg.stealth = { enabled: true, userAgent: 'UA/1', launchArgs: '--a --b=1,2', ignoreDefaultArgs: '--enable-automation', initScript: '/init.js' };
    setConfigSetting(cfg);
    const { backend, stealth } = currentBackend();
    expect(stealth.userAgent).toBe('UA/1');

    // Local: args + UA + init script via env; ignoreDefaultArgs has no agent-browser equivalent.
    const env = backendEnv(backend, stealth);
    expect(env.AGENT_BROWSER_ARGS).toBe('--a,--b=1,2,--no-sandbox,--disable-dev-shm-usage');
    expect(env.AGENT_BROWSER_USER_AGENT).toBe('UA/1');
    expect(env.AGENT_BROWSER_INIT_SCRIPTS).toBe('/init.js');

    // CDP: everything folds into the browserless `launch` query.
    const url = new URL(cdpConnectUrl({ kind: 'cdp', url: 'wss://bl.test', token: 't' }, stealth));
    const launch = JSON.parse(Buffer.from(url.searchParams.get('launch')!, 'base64').toString());
    expect(launch).toEqual({ args: ['--a', '--b=1,2'], ignoreDefaultArgs: ['--enable-automation'], userAgent: 'UA/1' });

    // Disabled: nothing of it reaches the browser.
    const off = { ...stealth, enabled: false };
    expect(backendEnv(backend, off).AGENT_BROWSER_USER_AGENT).toBeUndefined();
    expect(new URL(cdpConnectUrl({ kind: 'cdp', url: 'wss://bl.test', token: '' }, off)).searchParams.has('launch')).toBe(false);
  });

  it('reads a blob saved before stealth moved into the config', () => {
    const { stealth: _s, ...old } = kernelConfig('sk-1');
    setSetting('browser_backends', encryptSecret(JSON.stringify(old)));
    expect(currentConfig().config.stealth).toEqual(envConfig().stealth);
  });

  it('wires the kernel backend into KERNEL_* env for the daemon', () => {
    const env = backendEnv(kernelConfig('sk-1').backends.kernel);
    expect(env).toMatchObject({
      AGENT_BROWSER_PROVIDER: 'kernel',
      KERNEL_API_KEY: 'sk-1',
      KERNEL_HEADLESS: 'false',
      KERNEL_STEALTH: 'false',
      KERNEL_TIMEOUT_SECONDS: '300',
      KERNEL_PROFILE_NAME: 'shop',
      KERNEL_PROFILE_SAVE_CHANGES: 'true',
    });
    // A stray provider var from .env never leaks into a local daemon.
    expect(backendEnv(envConfig().backends.local).KERNEL_API_KEY).toBeUndefined();
  });
});

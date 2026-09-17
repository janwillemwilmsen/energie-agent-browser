import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { config, loadConfig, resetConfig, setConfig } from './config.js';

afterEach(() => resetConfig());

describe('loadConfig', () => {
  it('applies defaults and resolves data dirs against the given root', () => {
    const r = loadConfig({ BROWSERLESS_URL: 'wss://b.test', BROWSERLESS_TOKEN: 't' }, { root: '/srv/app' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.port).toBe(3001);
    expect(r.config.browser.mode).toBe('browserless');
    expect(r.config.dataDir).toBe(path.resolve('/srv/app', './data'));
    expect(r.config.auth.enabled).toBe(true);
    expect(r.config.stealth.enabled).toBe(true);
    expect(r.config.email.resendApiKey).toBe('');
  });

  it('lists every missing required variable instead of throwing on the first', () => {
    const r = loadConfig({});
    expect(r).toEqual({ ok: false, missing: ['BROWSERLESS_URL', 'BROWSERLESS_TOKEN'] });
  });

  it('makes browserless optional in local mode', () => {
    const r = loadConfig({ BROWSER_MODE: 'local', APP_AUTH_ENABLED: 'false', PORT: '4000' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.browser.mode).toBe('local');
    expect(r.config.browserless).toEqual({ url: '', token: '' });
    expect(r.config.auth.enabled).toBe(false);
    expect(r.config.port).toBe(4000);
  });
});

describe('the app config value', () => {
  it('reads whatever was installed, lazily, through the same shape modules import', () => {
    const r = loadConfig({ BROWSER_MODE: 'local', DATA_DIR: '/tmp/x' }, { root: '/' });
    if (!r.ok) throw new Error('unexpected');
    setConfig(r.config);
    expect(config.dataDir).toBe(path.resolve('/', '/tmp/x'));
    expect(config.browser.mode).toBe('local');
  });
});

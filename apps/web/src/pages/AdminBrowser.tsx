import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type BrowserBackend,
  type BrowserBackendKind,
  type BrowserConfig,
  type BrowserHealth,
  type BrowserSettings,
  type BrowserStealth,
  type BrowserTestResult,
  type DoctorResult,
  type InstallJob,
  type ProviderAccount,
} from '../lib/api.js';
import { useResource, usePolling } from '../lib/resource.js';

// Admin → Browser: pick which browser the agent-browser session daemon drives
// (local install, a self-hosted browserless over CDP, browserless.io,
// Browserbase or Kernel through agent-browser's providers), check that it
// works, and install the local one. Every backend's settings are shown and
// saved together — the radio only picks the active one — and live in the
// database (encrypted), so switching never means retyping credentials. Save
// closes the shared session, so scenarios/terminal pick it up immediately.

const KINDS: BrowserBackendKind[] = ['local', 'cdp', 'browserless-cloud', 'browserbase', 'kernel'];

const KIND_LABEL: Record<BrowserBackendKind, string> = {
  local: 'Local browser',
  cdp: 'Browserless over CDP — your own instance (token) or browserless.io (API key)',
  'browserless-cloud': 'browserless.io via agent-browser provider',
  browserbase: 'Browserbase',
  kernel: 'Kernel',
};

const KIND_HELP: Record<BrowserBackendKind, string> = {
  local: "agent-browser's own installed Chrome (`agent-browser install`). Runs on this server; Chromium launch args come from the Stealth section below.",
  cdp: 'The daemon connects straight to a browserless Chrome over CDP (`connect wss://host/chromium?token=…`). Two ways to fill it in: a self-hosted browserless (its URL + the TOKEN it runs with), or browserless.io (a region URL + your API key — the key goes in the same token field). Gets the full stealth set: launch args, ignore-default-args, user agent, init script. This is the recommended way to use browserless.io.',
  'browserless-cloud': "browserless.io through agent-browser's built-in provider (REST session API, https:// URL). Uses browserless.io's own stealth; launch args and the user-agent override do not apply, and the target/ref handling has proven flaky in scenario runs — prefer the CDP option above.",
  browserbase: "Browserbase's hosted browsers through agent-browser's provider. Only the API key is needed (the project is read from the key). Launch args and the user-agent override do not apply.",
  kernel: "Kernel's hosted browsers (onkernel.com) through agent-browser's provider. Optionally loads a saved Kernel profile (cookies, logins) and can write changes back to it. Launch args and the user-agent override do not apply.",
};

// Where each hosted provider's account lives (usage, billing, keys) and the
// agent-browser page for its provider. Shown next to the radio regardless of
// whether a key is stored. CDP borrows the browserless.io links when its URL
// points there (the server tells us via the account check).
const PROVIDER_LINKS: Partial<Record<BrowserBackendKind, { dashboard: string; keys?: string; docs: string }>> = {
  'browserless-cloud': {
    dashboard: 'https://account.browserless.io/',
    docs: 'https://agent-browser.dev/providers/browserless',
  },
  browserbase: {
    dashboard: 'https://www.browserbase.com/overview',
    keys: 'https://www.browserbase.com/settings',
    docs: 'https://agent-browser.dev/providers/browserbase',
  },
  kernel: {
    dashboard: 'https://dashboard.onkernel.com/',
    docs: 'https://agent-browser.dev/providers/kernel',
  },
};

const INSTALL_POLL_MS = 1_500;
const HEALTH_POLL_MS = 15_000;

export function AdminBrowser() {
  const [settings, setSettings] = useState<BrowserSettings | null>(null);
  const [draft, setDraft] = useState<BrowserConfig | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'doctor' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<BrowserTestResult | null>(null);
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);
  // Per backend: what its provider says about the stored key (null = not asked yet).
  const [accounts, setAccounts] = useState<Partial<Record<BrowserBackendKind, ProviderAccount | 'loading'>>>({});

  const { data: health, refresh: refreshHealth, refreshing: checking } = useResource(
    () => api.browserHealth(),
    { initial: null as BrowserHealth | null },
  );
  usePolling(refreshHealth, HEALTH_POLL_MS);

  const checkAccount = useCallback(async (kind: BrowserBackendKind) => {
    setAccounts((a) => ({ ...a, [kind]: 'loading' }));
    try {
      const r = await api.browserAccount(kind);
      setAccounts((a) => ({ ...a, [kind]: r }));
    } catch (e: any) {
      setAccounts((a) => ({ ...a, [kind]: { kind, ok: false, checkedAt: new Date().toISOString(), dashboardUrl: null, facts: [], error: e?.message ?? String(e) } }));
    }
  }, []);

  // Ask each hosted provider about its account once the stored config is
  // known — only where a key/URL is stored, so an unconfigured backend doesn't
  // produce a pointless error line.
  const checkConfiguredAccounts = useCallback((cfg: BrowserConfig) => {
    for (const kind of KINDS) {
      const b = cfg.backends[kind];
      const configured =
        (b.kind === 'cdp' && !!b.url) ||
        ((b.kind === 'browserless-cloud' || b.kind === 'browserbase' || b.kind === 'kernel') && !!b.apiKey);
      if (configured) void checkAccount(kind);
    }
  }, [checkAccount]);

  async function load() {
    try {
      const s = await api.getBrowserSettings();
      setSettings(s);
      setDraft(s.config);
      checkConfiguredAccounts(s.config);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(cfg: BrowserConfig | null) {
    setBusy('save');
    setNotice(null);
    setError(null);
    setTest(null);
    try {
      const r = await api.saveBrowserSettings(cfg);
      setNotice(
        cfg
          ? `Saved — the next session uses ${KIND_LABEL[r.config.active]}. The shared session was closed; run a test or bootstrap from the Terminal.`
          : 'Override removed — back to the .env configuration.',
      );
      await load();
      await refreshHealth();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy('test');
    setError(null);
    setTest(null);
    try {
      setTest(await api.testBrowser());
      await refreshHealth();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runDoctor() {
    setBusy('doctor');
    setError(null);
    try {
      setDoctor(await api.browserDoctor());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  const dirty = settings && draft && JSON.stringify(draft) !== JSON.stringify(settings.config);

  function setBackend<K extends BrowserBackendKind>(kind: K, backend: BrowserConfig['backends'][K]) {
    setDraft((d) => (d ? { ...d, backends: { ...d.backends, [kind]: backend } } : d));
  }

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">← Admin</Link></p>
      <h1>Browser</h1>
      <p className="muted">
        Which browser the <code>agent-browser</code> session daemon drives for scenarios, preflights,
        the live preview and the terminal. Saving applies to the next bootstrap — no restart needed.
        Credentials are stored in the database, encrypted at rest (<code>DATA_DIR/secrets-key</code> or <code>SECRETS_KEY</code>).
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}

      <StatusPanel health={health} checking={checking} onRefresh={refreshHealth} />

      {settings && draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760, marginTop: 16 }}>
          <div>
            <strong>Active source:</strong>{' '}
            {settings.source === 'setting' ? (
              <>admin setting (this page)</>
            ) : (
              <>
                <code>.env</code> (<code>BROWSER_MODE={settings.envConfig.active === 'local' ? 'local' : 'browserless'}</code>) — nothing saved here yet; the fields below are prefilled from it
              </>
            )}
          </div>

          <fieldset className="bb-kinds">
            <legend>Backend — the radio picks the active one; every backend's settings are saved together</legend>
            {KINDS.map((k) => (
              <BackendSection
                key={k}
                kind={k}
                active={draft.active === k}
                stored={settings.config.active === k}
                backend={draft.backends[k]}
                account={accounts[k] ?? null}
                onPick={() => { setDraft({ ...draft, active: k }); setTest(null); }}
                onChange={(b) => setBackend(k, b as BrowserConfig['backends'][typeof k])}
                onCheckAccount={() => void checkAccount(k)}
              />
            ))}
          </fieldset>

          <StealthSection
            stealth={draft.stealth}
            envStealth={settings.envConfig.stealth}
            onChange={(stealth) => setDraft({ ...draft, stealth })}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void save(draft)} disabled={busy !== null || !dirty}>
              {busy === 'save' ? 'Saving…' : '💾 Save'}
            </button>
            <button
              onClick={() => void runTest()}
              disabled={busy !== null || !!dirty}
              title={dirty ? 'Save first — the test runs the saved backend' : 'Restart the shared session on the active backend and open a page in it'}
            >
              {busy === 'test' ? 'Testing…' : '🧪 Test browser'}
            </button>
            <button
              onClick={() => void save(null)}
              disabled={busy !== null || settings.source !== 'setting'}
              title="Remove everything saved here and fall back to .env"
            >
              Reset to .env
            </button>
          </div>
          {dirty && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Unsaved changes — Test and the account checks use the saved settings.</p>}
        </div>
      )}

      {test && <TestReport result={test} />}

      <h2 style={{ marginTop: 28 }}>Local browser</h2>
      <p className="muted">
        The local backend needs a browser on this server. <code>doctor</code> shows what agent-browser
        finds (and does a headless launch test); <code>install</code> downloads Chrome for Testing into{' '}
        <code>~/.agent-browser/browsers</code>. <code>--with-deps</code> also installs system packages
        (Linux only — in the Docker/nixpacks image these are already present).
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => void runDoctor()} disabled={busy !== null}>
          {busy === 'doctor' ? 'Running doctor…' : '🩺 agent-browser doctor'}
        </button>
        <InstallControls />
      </div>
      {doctor && <DoctorReport result={doctor} />}
    </section>
  );
}

// One backend: its radio, help, fields (always visible and editable), and
// what its provider says about the stored account.
function BackendSection({
  kind, active, stored, backend, account, onPick, onChange, onCheckAccount,
}: {
  kind: BrowserBackendKind;
  active: boolean;
  stored: boolean;
  backend: BrowserBackend;
  account: ProviderAccount | 'loading' | null;
  onPick: () => void;
  onChange: (b: BrowserBackend) => void;
  onCheckAccount: () => void;
}) {
  // The provider's own site: where the key comes from and where usage/billing
  // lives. For CDP the server knows whether the URL points at browserless.io.
  const dashboard =
    kind === 'cdp'
      ? (account && account !== 'loading' && account.dashboardUrl ? PROVIDER_LINKS['browserless-cloud'] : null)
      : PROVIDER_LINKS[kind];
  return (
    <div className={`bb-kind${active ? ' bb-kind-active' : ''}`}>
      <label className="bb-kind-head">
        <input type="radio" name="kind" checked={active} onChange={onPick} />
        <strong>{KIND_LABEL[kind]}</strong>
        {stored && <span className="muted">(active)</span>}
        {dashboard && (
          <span className="bb-kind-links" onClick={(e) => e.stopPropagation()}>
            <a href={dashboard.dashboard} target="_blank" rel="noreferrer" title="Usage, billing, API keys">Dashboard ↗</a>
            {dashboard.keys && <a href={dashboard.keys} target="_blank" rel="noreferrer" title="Create or copy an API key">API keys ↗</a>}
            <a href={dashboard.docs} target="_blank" rel="noreferrer" title="agent-browser provider docs">Docs ↗</a>
          </span>
        )}
      </label>
      <p className="muted bb-kind-help">{KIND_HELP[kind]}</p>
      <BackendFields draft={backend} onChange={onChange} />
      {kind !== 'local' && <AccountLine account={account} onCheck={onCheckAccount} />}
    </div>
  );
}

// Plan / concurrency / usage as reported by the provider's API for the STORED
// key. None of them exposes a remaining budget over the API — that is what
// the dashboard link is for.
function AccountLine({ account, onCheck }: { account: ProviderAccount | 'loading' | null; onCheck: () => void }) {
  return (
    <div className="bb-account">
      <span className="muted">Account:</span>{' '}
      {account === 'loading' ? (
        <span className="muted">checking…</span>
      ) : !account ? (
        <span className="muted">not checked</span>
      ) : account.ok ? (
        <span className="bb-account-facts">
          {account.facts.map((f) => (
            <span key={f.label}><span className="muted">{f.label}</span> {f.value}</span>
          ))}
        </span>
      ) : (
        <span className="error">{account.error}</span>
      )}
      <button type="button" onClick={onCheck} disabled={account === 'loading'} className="bb-account-check">
        {account && account !== 'loading' ? 'Refresh' : 'Check'}
      </button>
    </div>
  );
}

const UA_LIST_URL = 'https://www.whatismybrowser.com/guides/the-latest-user-agent/chrome';

// Browser-fingerprint stealth, saved with the backends. Each knob says which
// backends actually honour it — that is a property of agent-browser and the
// providers, not of this page.
function StealthSection({ stealth, envStealth, onChange }: { stealth: BrowserStealth; envStealth: BrowserStealth; onChange: (s: BrowserStealth) => void }) {
  const set = <K extends keyof BrowserStealth>(key: K, value: BrowserStealth[K]) => onChange({ ...stealth, [key]: value });
  const field = (label: string, applies: string, input: JSX.Element, hint?: JSX.Element | string) => (
    <label className="bb-stealth-field">
      <span>
        {label} <span className="muted bb-stealth-applies">· {applies}</span>
      </span>
      {input}
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );
  const mono = { fontFamily: 'Consolas, monospace', fontSize: 12 } as const;
  return (
    <fieldset className="bb-kinds bb-stealth" disabled={false}>
      <legend>Stealth — fingerprint tweaks applied to the active backend (where it supports them)</legend>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" checked={stealth.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <strong>Enabled</strong>
        <span className="muted" style={{ fontSize: 12 }}>off = none of the settings below reach the browser</span>
      </label>
      <div className="bb-fields" style={{ opacity: stealth.enabled ? 1 : 0.5 }}>
        {field(
          'User agent',
          'local, CDP; providers set it but have ignored it',
          <input value={stealth.userAgent} onChange={(e) => set('userAgent', e.target.value)} placeholder={envStealth.userAgent} style={mono} />,
          <>
            Keep it close to a current Chrome:{' '}
            <a href={UA_LIST_URL} target="_blank" rel="noreferrer">latest Chrome user agents ↗</a>.
            Empty = no override (the browser's own UA).
          </>,
        )}
        {field(
          'Launch args',
          'local (AGENT_BROWSER_ARGS), CDP (browserless launch query); not providers',
          <textarea value={stealth.launchArgs} onChange={(e) => set('launchArgs', e.target.value)} rows={3} placeholder={envStealth.launchArgs} style={mono} />,
          'Whitespace-separated Chromium flags; a value may contain commas (--disable-features=A,B). Local adds --no-sandbox and --disable-dev-shm-usage itself.',
        )}
        {field(
          'Ignore default args',
          'CDP (browserless) only — agent-browser has no equivalent for local',
          <input value={stealth.ignoreDefaultArgs} onChange={(e) => set('ignoreDefaultArgs', e.target.value)} placeholder={envStealth.ignoreDefaultArgs} style={mono} />,
          'Default Chromium flags browserless should drop, e.g. --enable-automation (the flag that triggers the "controlled by automated software" bar and navigator.webdriver).',
        )}
        {field(
          'Init script path',
          'every backend (injected into each page by agent-browser)',
          <input value={stealth.initScript} onChange={(e) => set('initScript', e.target.value)} placeholder={envStealth.initScript} style={mono} />,
          'A JavaScript file on this server, run before any page script (navigator.webdriver, plugins, languages…). Empty = none.',
        )}
      </div>
    </fieldset>
  );
}

function BackendFields({ draft, onChange }: { draft: BrowserBackend; onChange: (b: BrowserBackend) => void }) {
  const [reveal, setReveal] = useState(false);
  const field = (label: string, input: JSX.Element, hint?: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span>{label}</span>
      {input}
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );
  const secret = (value: string, set: (v: string) => void, placeholder: string) => (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={{ flex: 1 }}
      />
      <button type="button" onClick={() => setReveal((r) => !r)}>{reveal ? 'Hide' : 'Show'}</button>
    </div>
  );
  const check = (label: string, checked: boolean, set: (v: boolean) => void, title?: string) => (
    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  const KEEP_HINT = 'Stored encrypted; Show reveals it.';

  switch (draft.kind) {
    case 'local':
      return (
        <div className="bb-fields">
          {field(
            'Executable path (optional)',
            <input
              value={draft.executablePath}
              onChange={(e) => onChange({ ...draft, executablePath: e.target.value })}
              placeholder="empty = auto-detect agent-browser's installed Chrome"
            />,
            'Sets AGENT_BROWSER_EXECUTABLE_PATH for the daemon. Leave empty unless you want a specific Chrome/Chromium binary.',
          )}
        </div>
      );
    case 'cdp': {
      // Same wire protocol either way; what differs is where the secret
      // comes from, so the labels follow the URL.
      const cloud = /browserless\.io/i.test(draft.url);
      return (
        <div className="bb-fields">
          <div className="bb-cdp-which">
            <span className={cloud ? '' : 'bb-cdp-on'}>🏠 Self-hosted browserless: <code>wss://your-host</code> + the <code>TOKEN</code> it was started with</span>
            <span className={cloud ? 'bb-cdp-on' : ''}>☁️ browserless.io: <code>wss://production-sfo.browserless.io</code> (or -lon / -ams) + your API key</span>
          </div>
          {field(
            'WebSocket URL',
            <input
              value={draft.url}
              onChange={(e) => onChange({ ...draft, url: e.target.value })}
              placeholder="wss://browserless.chatle.nl  or  wss://production-ams.browserless.io"
            />,
            `The host only — /chromium and ?token= are added automatically (browserless v2).${draft.url ? (cloud ? ' → browserless.io detected.' : ' → treated as self-hosted.') : ''}`,
          )}
          {field(
            cloud ? 'API key (browserless.io)' : 'Token (self-hosted)',
            secret(
              draft.token,
              (token) => onChange({ ...draft, token }),
              cloud ? 'from account.browserless.io' : 'the TOKEN env var your browserless container was started with',
            ),
            `${cloud ? 'Sent as ?token= like a self-hosted token.' : 'Sent as ?token= on the CDP URL.'} ${KEEP_HINT}`,
          )}
        </div>
      );
    }
    case 'browserbase':
      return (
        <div className="bb-fields">
          {field(
            'API key',
            secret(draft.apiKey, (apiKey) => onChange({ ...draft, apiKey }), 'from the Browserbase dashboard'),
            KEEP_HINT,
          )}
        </div>
      );
    case 'browserless-cloud':
      return (
        <div className="bb-fields">
          {field(
            'API key',
            secret(draft.apiKey, (apiKey) => onChange({ ...draft, apiKey }), 'from the browserless.io dashboard'),
            KEEP_HINT,
          )}
          {field(
            'API URL',
            <input
              value={draft.apiUrl}
              onChange={(e) => onChange({ ...draft, apiUrl: e.target.value })}
              placeholder="https://production-sfo.browserless.io"
            />,
            'https://, not wss:// — the provider creates sessions over REST. Regions: production-sfo, production-lon, production-ams.',
          )}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {field(
              'Browser',
              <select
                value={draft.browserType}
                onChange={(e) => onChange({ ...draft, browserType: e.target.value as 'chromium' | 'chrome' })}
              >
                <option value="chromium">chromium</option>
                <option value="chrome">chrome</option>
              </select>,
            )}
            {field(
              'Session TTL (ms)',
              <input
                type="number"
                min={10_000}
                step={1000}
                value={draft.ttlMs}
                onChange={(e) => onChange({ ...draft, ttlMs: Number(e.target.value) || 300_000 })}
                style={{ width: 120 }}
              />,
            )}
            {check('Stealth', draft.stealth, (stealth) => onChange({ ...draft, stealth }))}
          </div>
        </div>
      );
    case 'kernel':
      return (
        <div className="bb-fields">
          {field(
            'API key',
            secret(draft.apiKey, (apiKey) => onChange({ ...draft, apiKey }), 'from the Kernel dashboard'),
            KEEP_HINT,
          )}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {field(
              'Session timeout (s)',
              <input
                type="number"
                min={10}
                step={10}
                value={draft.timeoutSeconds}
                onChange={(e) => onChange({ ...draft, timeoutSeconds: Number(e.target.value) || 300 })}
                style={{ width: 120 }}
              />,
            )}
            {check('Headless', draft.headless, (headless) => onChange({ ...draft, headless }), 'KERNEL_HEADLESS')}
            {check('Stealth', draft.stealth, (stealth) => onChange({ ...draft, stealth }), 'KERNEL_STEALTH — bot-detection evasion on their side')}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {field(
              'Profile name (optional)',
              <input
                value={draft.profileName}
                onChange={(e) => onChange({ ...draft, profileName: e.target.value })}
                placeholder="an existing Kernel browser profile"
              />,
              'Loads that profile (cookies, logins) into every session. Create profiles in the Kernel dashboard.',
            )}
            {check(
              'Save changes back to the profile',
              draft.profileSaveChanges,
              (profileSaveChanges) => onChange({ ...draft, profileSaveChanges }),
              'KERNEL_PROFILE_SAVE_CHANGES — only applies when a profile name is set',
            )}
          </div>
        </div>
      );
  }
}

function StatusPanel({ health, checking, onRefresh }: { health: BrowserHealth | null; checking: boolean; onRefresh: () => void }) {
  const state: 'pending' | 'ok' | 'fail' = !health ? 'pending' : health.ok ? 'ok' : 'fail';
  const badgeClass = state === 'ok' ? 'status-success' : state === 'fail' ? 'status-failed' : 'status-running';
  const remote = health?.remote ?? null;
  return (
    <div className="bl-health">
      <div className="bl-health-row">
        <span className={`status ${badgeClass}`}>
          {health ? KIND_LABEL[health.kind] : 'checking…'}
          {health && (remote ? (health.ok ? ' · reachable' : ' · unreachable') : '')}
        </span>
        {health && (
          <span className="muted">
            session {health.session.alive ? `alive (pid ${health.session.pid})` : 'not running'}
            {remote ? ` · ${health.latencyMs}ms` : ''} · checked {new Date(health.checkedAt).toLocaleTimeString()}
          </span>
        )}
        <button onClick={onRefresh} disabled={checking} style={{ marginLeft: 'auto' }}>
          {checking ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {health && (
        <dl className="bl-health-grid">
          <dt>Bootstrap</dt>
          <dd><code>{health.bootstrapCommand}</code></dd>
          {health.kind === 'local' && (
            <>
              <dt>Executable</dt>
              <dd>
                {health.executablePath
                  ? <code>{health.executablePath}</code>
                  : <span className="muted">auto-detected — run doctor below to see which</span>}
              </dd>
            </>
          )}
          {remote && (
            <>
              <dt>Endpoint</dt>
              <dd><code>{remote.configuredUrl}</code></dd>
              <dt>Probe (<code>/docs</code>)</dt>
              <dd>
                {remote.docs.status != null
                  ? <span className={remote.docs.ok ? 'muted' : 'error'}>HTTP {remote.docs.status}</span>
                  : <span className="error">{remote.docs.error}</span>}
              </dd>
              {remote.version && (
                <>
                  <dt>Browser</dt>
                  <dd>{remote.version.browser ?? '—'} <span className="muted">(CDP {remote.version.protocolVersion ?? '—'})</span></dd>
                </>
              )}
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function TestReport({ result }: { result: BrowserTestResult }) {
  return (
    <div className="bl-health" style={{ marginTop: 12 }}>
      <div className="bl-health-row">
        <span className={`status ${result.ok ? 'status-success' : 'status-failed'}`}>
          test {result.ok ? 'passed' : 'failed'}
        </span>
        <span className="muted">{KIND_LABEL[result.kind]} · {(result.ms / 1000).toFixed(1)}s</span>
      </div>
      <dl className="bl-health-grid">
        {result.steps.map((s) => (
          <>
            <dt key={`${s.step}-t`}>{s.ok ? '✅' : '❌'} {s.step}</dt>
            <dd key={`${s.step}-d`}>
              <span className={s.ok ? undefined : 'error'} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{s.detail}</span>
              <span className="muted"> · {(s.ms / 1000).toFixed(1)}s</span>
            </dd>
          </>
        ))}
      </dl>
    </div>
  );
}

function DoctorReport({ result }: { result: DoctorResult }) {
  if (!result.checks) {
    return (
      <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 12 }}>
        {result.raw || `(no output, exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})`}
      </pre>
    );
  }
  const icon = (status: string) =>
    status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'warn' ? '⚠️' : 'ℹ️';
  const groups = new Map<string, DoctorResult['checks']>();
  for (const c of result.checks) {
    const list = groups.get(c.category) ?? [];
    list!.push(c);
    groups.set(c.category, list);
  }
  return (
    <div style={{ marginTop: 12, fontSize: 13 }}>
      {[...groups.entries()].map(([category, checks]) => (
        <div key={category} style={{ marginBottom: 8 }}>
          <strong>{category}</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {checks!.map((c) => (
              <li key={c.id}>
                {icon(c.status)} {c.message}
                {c.fix && <span className="muted"> — fix: <code>{c.fix}</code></span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function InstallControls() {
  const [job, setJob] = useState<InstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function poll() {
    try { setJob(await api.browserInstallStatus()); } catch { /* transient */ }
  }
  useEffect(() => { void poll(); }, []);
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(() => void poll(), INSTALL_POLL_MS);
    return () => clearInterval(t);
  }, [job?.running]);

  async function start(withDeps: boolean) {
    setError(null);
    try {
      await api.startBrowserInstall(withDeps);
      await poll();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  const running = !!job?.running;
  return (
    <>
      <button onClick={() => void start(false)} disabled={running}>
        {running ? 'Installing…' : '⬇️ agent-browser install'}
      </button>
      <button onClick={() => void start(true)} disabled={running} title="Also install Linux system dependencies">
        install --with-deps
      </button>
      {error && <span className="error">{error}</span>}
      {job && (job.running || job.log) && (
        <div style={{ flexBasis: '100%' }}>
          <p className="muted" style={{ margin: '8px 0 4px', fontSize: 12 }}>
            <code>agent-browser {job.args.join(' ')}</code> —{' '}
            {job.running
              ? `running since ${job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '?'}`
              : `exit ${job.exitCode} at ${job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : '?'}`}
          </p>
          <pre style={{ fontSize: 12, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>
            {job.log || '(no output yet)'}
          </pre>
        </div>
      )}
    </>
  );
}

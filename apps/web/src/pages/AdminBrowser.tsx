import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type BrowserBackend,
  type BrowserBackendKind,
  type BrowserHealth,
  type BrowserSettings,
  type BrowserTestResult,
  type DoctorResult,
  type InstallJob,
} from '../lib/api.js';
import { useResource, usePolling } from '../lib/resource.js';

// Admin → Browser: pick which browser the agent-browser session daemon drives
// (local install, a self-hosted browserless over CDP, or browserless.io via
// agent-browser's provider), check that it works, and install the local one.
// The choice is stored server-side and applies to the next bootstrap — Save
// closes the shared session, so scenarios/terminal pick it up immediately.

const KIND_LABEL: Record<BrowserBackendKind, string> = {
  local: 'Local browser',
  cdp: 'Browserless over CDP (self-hosted or browserless.io)',
  'browserless-cloud': 'browserless.io via agent-browser provider',
  browserbase: 'Browserbase',
};

const KIND_HELP: Record<BrowserBackendKind, string> = {
  local: "agent-browser's own installed Chrome (`agent-browser install`). Runs on this server; Chromium launch args come from STEALTH_LAUNCH_ARGS.",
  cdp: 'The daemon runs `connect wss://host/chromium?token=…`. Works with your own instance (wss://browserless.chatle.nl + its token) and with browserless.io (wss://production-ams.browserless.io + your API key). Gets the full stealth set: launch args, user agent, init script. Recommended for browserless.io.',
  'browserless-cloud': "browserless.io through agent-browser's built-in provider (REST session API, https:// URL). Uses browserless.io's own stealth; launch args and the user-agent override do not apply, and the target/ref handling has proven flaky in scenario runs — prefer the CDP option above.",
  browserbase: "Browserbase's hosted browsers through agent-browser's provider. Only the API key is needed (the project is read from the key). Launch args and the user-agent override do not apply.",
};

const INSTALL_POLL_MS = 1_500;
const HEALTH_POLL_MS = 15_000;

function defaultFor(kind: BrowserBackendKind, s: BrowserSettings | null): BrowserBackend {
  switch (kind) {
    case 'local':
      return { kind, executablePath: '' };
    case 'cdp':
      return { kind, url: 'wss://', token: '' };
    case 'browserless-cloud':
      return {
        kind,
        apiKey: '',
        apiUrl: 'https://production-sfo.browserless.io',
        browserType: 'chromium',
        ttlMs: 300_000,
        stealth: true,
        ...s?.cloudPrefill,
      };
    case 'browserbase':
      return { kind, apiKey: s?.browserbasePrefill?.apiKey ?? '' };
  }
}

export function AdminBrowser() {
  const [settings, setSettings] = useState<BrowserSettings | null>(null);
  const [draft, setDraft] = useState<BrowserBackend | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'doctor' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<BrowserTestResult | null>(null);
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);

  const { data: health, refresh: refreshHealth, refreshing: checking } = useResource(
    () => api.browserHealth(),
    { initial: null as BrowserHealth | null },
  );
  usePolling(refreshHealth, HEALTH_POLL_MS);

  async function load() {
    try {
      const s = await api.getBrowserSettings();
      setSettings(s);
      setDraft(s.backend);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }
  useEffect(() => { void load(); }, []);

  // Switching kind starts from that kind's defaults (or the stored backend if
  // that's the one being switched back to), so half-typed fields don't leak
  // between kinds.
  function pickKind(kind: BrowserBackendKind) {
    if (settings?.backend.kind === kind) setDraft(settings.backend);
    else setDraft(defaultFor(kind, settings));
    setTest(null);
  }

  async function save(backend: BrowserBackend | null) {
    setBusy('save');
    setNotice(null);
    setError(null);
    setTest(null);
    try {
      const r = await api.saveBrowserSettings(backend);
      setNotice(
        backend
          ? `Saved — the next session uses ${KIND_LABEL[r.backend.kind]}. The shared session was closed; run a test or bootstrap from the Terminal.`
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

  const dirty = settings && draft && JSON.stringify(draft) !== JSON.stringify(settings.backend);

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">← Admin</Link></p>
      <h1>Browser</h1>
      <p className="muted">
        Which browser the <code>agent-browser</code> session daemon drives for scenarios, preflights,
        the live preview and the terminal. Saving applies to the next bootstrap — no restart needed.
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}

      <StatusPanel health={health} checking={checking} onRefresh={refreshHealth} />

      {settings && draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, marginTop: 16 }}>
          <div>
            <strong>Active source:</strong>{' '}
            {settings.source === 'setting' ? (
              <>admin override (this page)</>
            ) : (
              <>
                <code>.env</code> (<code>BROWSER_MODE={settings.envBackend.kind === 'local' ? 'local' : 'browserless'}</code>)
              </>
            )}
          </div>

          <fieldset style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
            <legend>Backend</legend>
            {(Object.keys(KIND_LABEL) as BrowserBackendKind[]).map((k) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="radio" name="kind" checked={draft.kind === k} onChange={() => pickKind(k)} />
                <span>
                  <strong>{KIND_LABEL[k]}</strong>
                  {settings.backend.kind === k && <span className="muted"> (active)</span>}
                  <br />
                  <span className="muted" style={{ fontSize: 12 }}>{KIND_HELP[k]}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <BackendFields draft={draft} onChange={setDraft} />

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
              title="Remove the override and fall back to .env"
            >
              Reset to .env
            </button>
          </div>
          {dirty && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Unsaved changes — Test runs against the saved backend.</p>}
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

  switch (draft.kind) {
    case 'local':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
    case 'cdp':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {field(
            'WebSocket URL',
            <input
              value={draft.url}
              onChange={(e) => onChange({ ...draft, url: e.target.value })}
              placeholder="wss://browserless.chatle.nl"
            />,
            'The host only — /chromium and ?token= are added automatically (browserless v2).',
          )}
          {field(
            'Token',
            secret(draft.token, (token) => onChange({ ...draft, token }), 'the TOKEN your browserless was started with'),
            'A value starting with •••• is the stored token; leave it to keep it.',
          )}
        </div>
      );
    case 'browserbase':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {field(
            'API key',
            secret(draft.apiKey, (apiKey) => onChange({ ...draft, apiKey }), 'from the Browserbase dashboard'),
            'A value starting with •••• is the stored key; leave it to keep it.',
          )}
        </div>
      );
    case 'browserless-cloud':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {field(
            'API key',
            secret(draft.apiKey, (apiKey) => onChange({ ...draft, apiKey }), 'from the browserless.io dashboard'),
            'A value starting with •••• is the stored key; leave it to keep it.',
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
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={draft.stealth}
                onChange={(e) => onChange({ ...draft, stealth: e.target.checked })}
              />
              Stealth
            </label>
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

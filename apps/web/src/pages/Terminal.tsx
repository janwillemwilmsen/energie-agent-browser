import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BrowserHealth } from '../lib/api.js';
import { TerminalShell, type TerminalShellHandle } from '../lib/TerminalShell.js';
import { useResource, usePolling } from '../lib/resource.js';

const HEALTH_POLL_MS = 10_000;

const PROVIDER_NAME = { 'browserless-cloud': 'browserless.io', browserbase: 'Browserbase', kernel: 'Kernel' } as const;

export function Terminal() {
  const termRef = useRef<TerminalShellHandle | null>(null);
  const [openUrl, setOpenUrl] = useState('https://example.com');

  const { data: health, refreshing: checking, error: healthErr, refresh: refreshHealth } = useResource(
    () => api.browserHealth(),
    { initial: null as BrowserHealth | null },
  );
  usePolling(refreshHealth, HEALTH_POLL_MS);

  return (
    <section>
      <h1>Terminal</h1>

      <BrowserHealthPanel
        health={health}
        checking={checking}
        error={healthErr}
        onRefresh={refreshHealth}
      />

      <p className="muted">
        {health?.kind === 'cdp' ? (
          <>
            The session connects to your browserless instance over{' '}
            <code>%BROWSERLESS_CDP_URL%</code>, which the shell exports from the configured URL + token.
          </>
        ) : health?.kind === 'browserless-cloud' || health?.kind === 'browserbase' || health?.kind === 'kernel' ? (
          <>The session is created on {PROVIDER_NAME[health.kind]} through agent-browser's provider; opening a page is what starts it.</>
        ) : (
          <>
            The session runs agent-browser's locally installed browser; opening a page is what launches it.
          </>
        )}{' '}
        Configure and test the browser under <Link to="/admin/browser">Admin → Browser</Link>. Click below
        to bootstrap a session, or type any <code>agent-browser</code> command directly.
      </p>
      <div className="actions">
        <button
          disabled={!health}
          title={health?.bootstrapCommand}
          onClick={() => health && termRef.current?.send(health.bootstrapCommand)}
        >
          Bootstrap default session
        </button>
        <button onClick={() => termRef.current?.send('agent-browser --version')}>
          agent-browser --version
        </button>
        <button onClick={() => termRef.current?.send('agent-browser --session default get url')}>
          get url
        </button>
        <button onClick={() => termRef.current?.send('agent-browser quit --all')}>
          quit --all
        </button>
        <button onClick={() => termRef.current?.send('agent-browser doctor')}>
          doctor
        </button>
        <button onClick={() => termRef.current?.send('agent-browser install --with-deps')}>
          install --with-deps
        </button>
        <button onClick={() => termRef.current?.send('agent-browser --session default close')}>
          close
        </button>
      </div>
      <div className="actions">
        <input
          type="text"
          value={openUrl}
          onChange={(e) => setOpenUrl(e.target.value)}
          placeholder="https://…"
          style={{ minWidth: 280 }}
        />
        <button
          disabled={!openUrl.trim()}
          onClick={() =>
            termRef.current?.send(`agent-browser --session default open "${openUrl.trim()}"`)
          }
        >
          open
        </button>
      </div>
      <TerminalShell ref={termRef} />
    </section>
  );
}

function BrowserHealthPanel({
  health,
  checking,
  error,
  onRefresh,
}: {
  health: BrowserHealth | null;
  checking: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  // Tri-state badge: pending while we have no data; pass/fail once we do.
  const state: 'pending' | 'ok' | 'fail' =
    !health && !error ? 'pending' : health?.ok ? 'ok' : 'fail';
  const badgeClass =
    state === 'ok' ? 'status-success' : state === 'fail' ? 'status-failed' : 'status-running';
  const label =
    health?.kind === 'cdp' ? 'browserless'
      : health?.kind === 'browserless-cloud' ? 'browserless.io'
        : health?.kind === 'browserbase' ? 'browserbase'
          : health?.kind === 'kernel' ? 'kernel' : 'browser';
  const badgeText =
    state === 'pending' ? 'checking…'
      : state === 'fail' ? 'unreachable'
        : health?.kind === 'local' ? 'local' : 'healthy';
  const remote = health?.remote ?? null;

  return (
    <div className="bl-health">
      <div className="bl-health-row">
        <span className={`status ${badgeClass}`}>{label}: {badgeText}</span>
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

      {error && <p className="error" style={{ margin: '6px 0 0' }}>{error}</p>}

      {health && health.kind === 'local' && (
        <dl className="bl-health-grid">
          <dt>Executable</dt>
          <dd>
            {health.executablePath
              ? <code>{health.executablePath}</code>
              : <span className="muted">auto-detected — see Admin → Browser → doctor</span>}
          </dd>
        </dl>
      )}

      {remote && (
        <dl className="bl-health-grid">
          <dt>Endpoint</dt>
          <dd><code>{remote.configuredUrl}</code></dd>

          <dt>Probe (<code>/docs</code>)</dt>
          <dd>
            <code>{remote.docs.url}</code>{' '}
            {remote.docs.status != null ? (
              <span className={remote.docs.ok ? 'muted' : 'error'}>→ {remote.docs.status}</span>
            ) : (
              <span className="error">→ {remote.docs.error}</span>
            )}
          </dd>

          {remote.version && (
            <>
              <dt>Browser</dt>
              <dd>{remote.version.browser ?? '—'}</dd>
              <dt>CDP protocol</dt>
              <dd>{remote.version.protocolVersion ?? '—'}</dd>
              <dt>wss debugger URL</dt>
              <dd><code>{remote.version.webSocketDebuggerUrl ?? '—'}</code></dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

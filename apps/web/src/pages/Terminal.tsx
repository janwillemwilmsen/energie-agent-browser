import { useEffect, useRef, useState } from 'react';
import { api, type BrowserlessHealth } from '../lib/api.js';
import { TerminalShell, type TerminalShellHandle } from '../lib/TerminalShell.js';

const HEALTH_POLL_MS = 10_000;

export function Terminal() {
  const termRef = useRef<TerminalShellHandle | null>(null);
  const [health, setHealth] = useState<BrowserlessHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [healthErr, setHealthErr] = useState<string | null>(null);

  async function refreshHealth() {
    setChecking(true);
    setHealthErr(null);
    try {
      setHealth(await api.browserlessHealth());
    } catch (e: any) {
      setHealthErr(e?.message ?? String(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <section>
      <h1>Terminal</h1>

      <BrowserlessHealthPanel
        health={health}
        checking={checking}
        error={healthErr}
        onRefresh={refreshHealth}
      />

      <p className="muted">
        The session uses <code>%BROWSERLESS_CDP_URL%</code>, which the server derives from{' '}
        <code>BROWSERLESS_URL</code> + <code>BROWSERLESS_TOKEN</code> in <code>.env</code>.
        Click below to bootstrap a session, or type any <code>agent-browser</code> command directly.
      </p>
      <div className="actions">
        <button
          onClick={() =>
            termRef.current?.send('agent-browser --session default connect "%BROWSERLESS_CDP_URL%"')
          }
        >
          Bootstrap default session
        </button>
        <button onClick={() => termRef.current?.send('agent-browser --version')}>
          agent-browser --version
        </button>
        <button onClick={() => termRef.current?.send('agent-browser --session default get url')}>
          get url
        </button>
      </div>
      <TerminalShell ref={termRef} />
    </section>
  );
}

function BrowserlessHealthPanel({
  health,
  checking,
  error,
  onRefresh,
}: {
  health: BrowserlessHealth | null;
  checking: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  // Tri-state badge: pending while we have no data; pass/fail once we do.
  const state: 'pending' | 'ok' | 'fail' =
    !health && !error ? 'pending' : health?.ok ? 'ok' : 'fail';
  const badgeClass =
    state === 'ok' ? 'status-success' : state === 'fail' ? 'status-failed' : 'status-running';
  const badgeText = state === 'ok' ? 'healthy' : state === 'fail' ? 'unreachable' : 'checking…';

  return (
    <div className="bl-health">
      <div className="bl-health-row">
        <span className={`status ${badgeClass}`}>browserless: {badgeText}</span>
        {health && (
          <span className="muted">
            {health.latencyMs}ms · checked {new Date(health.checkedAt).toLocaleTimeString()}
          </span>
        )}
        <button onClick={onRefresh} disabled={checking} style={{ marginLeft: 'auto' }}>
          {checking ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="error" style={{ margin: '6px 0 0' }}>{error}</p>}

      {health && (
        <dl className="bl-health-grid">
          <dt>CDP URL</dt>
          <dd><code>{health.cdp.configuredUrl}</code></dd>

          <dt>Probe (<code>/docs</code>)</dt>
          <dd>
            <code>{health.docs.url}</code>{' '}
            {health.docs.status != null ? (
              <span className={health.docs.ok ? 'muted' : 'error'}>→ {health.docs.status}</span>
            ) : (
              <span className="error">→ {health.docs.error}</span>
            )}
          </dd>

          {health.version && (
            <>
              <dt>Browser</dt>
              <dd>{health.version.browser ?? '—'}</dd>
              <dt>CDP protocol</dt>
              <dd>{health.version.protocolVersion ?? '—'}</dd>
              <dt>wss debugger URL</dt>
              <dd><code>{health.version.webSocketDebuggerUrl ?? '—'}</code></dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

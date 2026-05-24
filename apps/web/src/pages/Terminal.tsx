import { useRef } from 'react';
import { TerminalShell, type TerminalShellHandle } from '../lib/TerminalShell.js';

export function Terminal() {
  const termRef = useRef<TerminalShellHandle | null>(null);

  return (
    <section>
      <h1>Terminal</h1>
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

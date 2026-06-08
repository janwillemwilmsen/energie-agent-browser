import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { TerminalShell, type TerminalShellHandle } from '../lib/TerminalShell.js';

// Admin → Network inspector. Reuses the shared TerminalShell component and adds
// a button bar built around agent-browser's `network` subcommand, so an operator
// can inspect the traffic of the live `default` session without typing the
// commands by hand. Everything runs against the same daemon the scenarios use.

const SESSION = 'default';
const ab = (cmd: string) => `agent-browser --session ${SESSION} ${cmd}`;

export function AdminNetwork() {
  const termRef = useRef<TerminalShellHandle | null>(null);
  const run = (cmd: string) => termRef.current?.send(cmd);

  // Navigate the live session somewhere so there's traffic to inspect. Quote the
  // URL so query strings / special chars survive the shell.
  const openUrl = () => {
    const url = prompt('Open which URL?', 'https://');
    if (url == null) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    run(ab(`open "${trimmed}"`));
  };

  // Click an element. The value is usually a snapshot ref (e.g. @e5) but
  // agent-browser also accepts CSS / text= / xpath= selectors — quote it so
  // selectors containing spaces or `>` aren't mangled by the shell.
  const clickEl = () => {
    const v = prompt('Click which element? (snapshot ref like @e5, or a CSS selector)', '@e');
    if (v == null) return;
    const trimmed = v.trim();
    if (!trimmed) return;
    run(ab(`click "${trimmed}"`));
  };

  return (
    <section>
      <p>
        <Link to="/admin">← Admin</Link>
      </p>
      <h1>Network inspector</h1>
      <p className="muted">
        Inspect the network traffic of the live <code>{SESSION}</code> agent-browser session.
        Requests are tracked once the session is connected — bootstrap it first if the terminal
        reports no session, then navigate (in a scenario, the live preview, or here with{' '}
        <code>open &lt;url&gt;</code>) and click <strong>Inspect network traffic</strong>.
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        <strong>Process:</strong> <code>agent-browser exit</code> → bootstrap session →{' '}
        <code>agent-browser open &lt;url&gt;</code> → <code>agent-browser snapshot -i</code> →{' '}
        <code>agent-browser click '@elementId'</code>
      </p>

      <div className="actions">
        {/* Mirrors the documented process order: exit → bootstrap → open → snapshot → click. */}
        <button
          onClick={() => run(ab('exit'))}
          title="Close the current browser session (alias of close) before bootstrapping fresh"
        >
          Exit
        </button>
        {/* The terminal can't inspect anything until a daemon is alive. */}
        <button
          onClick={() => run(`agent-browser --session ${SESSION} connect "%BROWSERLESS_CDP_URL%"`)}
          title="Start the default agent-browser daemon if it isn't already running"
        >
          Bootstrap session
        </button>
        <button onClick={openUrl} title="Navigate the session to a URL to generate traffic">
          Open URL…
        </button>
        <button
          onClick={() => run(ab('snapshot -i'))}
          title="Accessibility-tree snapshot of the current page, interactive elements only"
        >
          Snapshot (-i)
        </button>
        <button onClick={clickEl} title="Click an element by snapshot ref (e.g. @e5) or CSS selector">
          Click…
        </button>
      </div>

      <div className="actions" style={{ marginTop: 8 }}>
        <strong className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>
          Network:
        </strong>
        {/* The primary requested action. */}
        <button onClick={() => run(ab('network requests'))} title="List all tracked requests">
          🔎 Inspect network traffic
        </button>
        <button
          onClick={() => run(ab('network requests --type xhr,fetch'))}
          title="Only XHR / fetch (API) calls"
        >
          API calls (xhr/fetch)
        </button>
        <button
          onClick={() => run(ab('network requests --status 400-599'))}
          title="Only failed responses (4xx/5xx)"
        >
          Failures (4xx/5xx)
        </button>
        <button onClick={() => run(ab('network har start'))} title="Begin recording a HAR file">
          HAR: start
        </button>
        <button
          onClick={() => run(ab('network har stop'))}
          title="Stop recording and save the HAR (path printed in the terminal)"
        >
          HAR: stop &amp; save
        </button>
      </div>

      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Tip: <code>{ab('network request <id>')}</code> shows the full request/response detail for one
        entry from the list above.
      </p>

      <TerminalShell ref={termRef} />
    </section>
  );
}

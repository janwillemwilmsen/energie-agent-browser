import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SessionState } from '../lib/api.js';

// Admin → Session state files. Lists agent-browser's persisted --session-name
// state (~/.agent-browser/sessions/<name>.json) and lets an operator delete a
// file. Deleting resets that session to a clean cookie jar — the fix for a
// cookie-consent preflight whose accepted state got baked in, so the banner no
// longer appears and the "click accept" step fails on every run.

function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminSessionStates() {
  const [items, setItems] = useState<SessionState[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setErr(null);
    try {
      setItems(await api.listSessionStates());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(name: string, inUse: boolean) {
    const warning = inUse
      ? `"${name}" is currently bound to a live session — deleting it won't take effect until that daemon restarts.\n\n`
      : '';
    if (!confirm(`${warning}Delete persisted session state for "${name}"? The next run under this session will start with a clean cookie jar.`)) {
      return;
    }
    setErr(null);
    setBusy(name);
    try {
      await api.deleteSessionState(name);
      setItems((cur) => cur.filter((s) => s.name !== name));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <p>
        <Link to="/admin">← Admin</Link>
      </p>
      <h1>Session state files</h1>
      <p className="muted">
        agent-browser's persisted <code>--session-name</code> state, one file per session under{' '}
        <code>~/.agent-browser/sessions/</code>. Each preflight that saves state writes{' '}
        <code>&lt;name&gt;.json</code>; that file is loaded back into the browser on every scenario
        run that uses the preflight. Deleting a file resets that session to a clean cookie jar — use
        it when a cookie-consent preflight fails because the accepted-cookie state was baked in and
        the banner no longer appears.
      </p>

      <div className="actions" style={{ marginBottom: 12 }}>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {err && <p className="error">{err}</p>}

      {!loading && items.length === 0 ? (
        <p className="muted">No saved session state files.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Session name</th>
              <th>Size</th>
              <th>Modified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.name}>
                <td><code>{s.name}</code></td>
                <td>{fmtSize(s.sizeBytes)}</td>
                <td>{fmtDate(s.modifiedAt)}</td>
                <td>
                  <button
                    className="btn-danger"
                    onClick={() => remove(s.name, s.inUse)}
                    disabled={busy === s.name}
                  >
                    {busy === s.name ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

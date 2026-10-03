import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type PreflightListRow } from '../lib/api.js';
import { useResource } from '../lib/resource.js';

// /preflight — the overview, shaped like /scenarios: a box to create a new
// preflight and the table of existing ones with how many scenarios use each.
// Editing (steps, replay, auth profiles) lives on /preflight/:id.

function parseSteps(p: PreflightListRow): Array<{ kind?: string; name?: string }> {
  try {
    const steps = JSON.parse(p.steps_json);
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

/** The auth profiles the preflight logs in with (its `auth-login` steps), deduplicated. */
function authProfiles(p: PreflightListRow): string[] {
  return [...new Set(parseSteps(p).filter((s) => s.kind === 'auth-login' && s.name).map((s) => s.name as string))];
}

export function Preflights() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: preflights, error: err, setError: setErr, refresh: load } = useResource(
    () => api.listPreflights(),
    { initial: [] as PreflightListRow[] },
  );

  const nameTaken = preflights.some((p) => p.name === name.trim());

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || nameTaken) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createPreflight({ name: n, description: description.trim(), steps: [] });
      setName('');
      setDescription('');
      navigate(`/preflight/${created.id}`);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: PreflightListRow) {
    const inUse = p.scenario_count > 0 ? ` It is attached to ${p.scenario_count} scenario${p.scenario_count === 1 ? '' : 's'} (${p.scenario_names}); they will run without a preflight.` : '';
    if (!confirm(`Delete preflight "${p.name}"?${inUse}\n\nThe saved browser state under ~/.agent-browser/sessions/ is left in place.`)) return;
    setErr(null);
    try {
      await api.deletePreflight(p.id);
      await load();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  }

  return (
    <section>
      <h1>Preflights</h1>
      <p className="muted">
        A preflight records a login or cookie-consent flow once; every scenario that selects it starts
        from that state on each run. Create one here, then record its steps in the editor.
      </p>

      <details className="card" style={{ maxWidth: 720 }}>
        <summary><h3>New preflight</h3></summary>
        <form onSubmit={create}>
        <div className="scenario-meta-row">
          <label className="scenario-meta-name">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. acme-login"
              pattern="[A-Za-z0-9._-]+"
              title="letters, digits, dot, dash, underscore — it doubles as the browser-state folder name"
              required
            />
          </label>
          <label style={{ flex: 2 }}>
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What state does this preflight set up?"
            />
          </label>
        </div>
        {nameTaken && <p className="error" style={{ margin: 0 }}>A preflight named "{name.trim()}" already exists.</p>}
        <div>
          <button type="submit" disabled={busy || !name.trim() || nameTaken}>
            {busy ? 'Creating…' : '+ Create & open editor'}
          </button>
        </div>
        </form>
      </details>

      {err && <p className="error">{err}</p>}

      <table className="table scenario-table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Steps</th>
            <th>Auth profile</th>
            <th>Used by</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {preflights.map((p) => (
            <tr key={p.id}>
              <td data-label="Name"><Link to={`/preflight/${p.id}`}><strong>{p.name}</strong></Link></td>
              <td data-label="Description" className="muted">{p.description || '—'}</td>
              <td data-label="Steps">{parseSteps(p).length}</td>
              <td data-label="Auth profile" title="The auth profile used by this preflight's auth-login step">
                {authProfiles(p).length > 0
                  ? authProfiles(p).map((n) => <code key={n} style={{ marginRight: 6 }}>🔐 {n}</code>)
                  : <span className="muted">—</span>}
              </td>
              <td data-label="Used by" title={p.scenario_names ?? 'No scenario uses this preflight yet'}>
                {p.scenario_count > 0 ? (
                  <>
                    {p.scenario_count} scenario{p.scenario_count === 1 ? '' : 's'}
                    <span className="chip-links">
                      {p.scenarios.map((sc) => (
                        <Link key={sc.id} to={`/scenarios/${sc.id}`} className="chip-link" title="Open this scenario">
                          {sc.name}
                        </Link>
                      ))}
                    </span>
                  </>
                ) : (
                  <span className="muted">not used</span>
                )}
              </td>
              <td data-label="Updated" className="muted">{new Date(p.updated_at + 'Z').toLocaleString()}</td>
              <td>
                <div className="scenario-actions-row">
                  <button onClick={() => void remove(p)} disabled={busy}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
          {preflights.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                No preflights yet — create one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Scenario } from '../lib/api.js';

const SESSION = 'default';

export function Scenarios() {
  const [items, setItems] = useState<Scenario[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [preset, setPreset] = useState<'desktop' | 'mobile' | 'both'>('desktop');
  const [brand, setBrand] = useState('');
  const [type, setType] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Which scenario is currently being launched, and a short status line. Runs
  // share the single 'default' session, so only one launch happens at a time.
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.listScenarios());
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.createScenario({
        name,
        url,
        viewport_preset: preset,
        brand: brand.trim() || null,
        type: type.trim() || null,
      });
      setName('');
      setUrl('https://');
      setBrand('');
      setType('');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this scenario?')) return;
    await api.deleteScenario(id);
    await load();
  }

  // Reset the browser session (close + bootstrap a fresh one) so the run starts
  // clean, then kick off the run.
  async function runScenario(s: Scenario) {
    if (runningId != null) return;
    setErr(null);
    setRunningId(s.id);
    setRunStatus(`Resetting browser for "${s.name}"…`);
    try {
      await api.closeSession(SESSION).catch(() => undefined);
      const boot = await api.bootstrapSession(SESSION);
      if (!boot.alive) {
        setErr('Browser session did not come up after reset. Try again.');
        setRunStatus(null);
        return;
      }
      setRunStatus(`Starting run for "${s.name}"…`);
      const run = await api.startRun(s.id);
      setRunStatus(`Run #${run.id} started for "${s.name}".`);
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setRunStatus(null);
    } finally {
      setRunningId(null);
    }
  }

  async function updateTag(s: Scenario, field: 'brand' | 'type', value: string) {
    const next = value.trim() || null;
    if (next === s[field]) return;
    try {
      await api.updateScenario(s.id, { [field]: next } as Partial<Scenario>);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <section>
      <h1>Scenarios</h1>
      {err && <p className="error">{err}</p>}
      {runStatus && (
        <p className="muted">
          {runStatus} <Link to="/runs">See Runs</Link>
        </p>
      )}

      <details className="card">
        <summary><h3>New scenario</h3></summary>
        <form onSubmit={create}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} required />
          </label>
          <label>
            Viewport
            <select value={preset} onChange={(e) => setPreset(e.target.value as any)}>
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label>
            Brand <span className="muted">(used to filter on the homepage)</span>
            <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Acme" />
          </label>
          <label>
            Type <span className="muted">(used to filter on the homepage)</span>
            <input value={type} onChange={(e) => setType(e.target.value)} placeholder="e.g. Checkout flow" />
          </label>
          <button type="submit">Create</button>
        </form>
      </details>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>URL</th>
            <th>Viewport</th>
            <th>Brand</th>
            <th>Type</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to={`/scenarios/${s.id}`}>{s.name}</Link>
              </td>
              <td>{s.url}</td>
              <td>{s.viewport_preset}</td>
              <td>
                <input
                  className="inline-tag-input"
                  defaultValue={s.brand ?? ''}
                  placeholder="—"
                  onBlur={(e) => updateTag(s, 'brand', e.target.value)}
                />
              </td>
              <td>
                <input
                  className="inline-tag-input"
                  defaultValue={s.type ?? ''}
                  placeholder="—"
                  onBlur={(e) => updateTag(s, 'type', e.target.value)}
                />
              </td>
              <td>{s.updated_at}</td>
              <td className="scenario-actions">
                <button
                  onClick={() => runScenario(s)}
                  disabled={runningId != null}
                  title="Reset the browser session, then run this scenario"
                >
                  {runningId === s.id ? 'Running…' : '▶ Run'}
                </button>
                <button onClick={() => remove(s.id)} disabled={runningId != null}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

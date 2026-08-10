import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Scenario } from '../lib/api.js';

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
  // Capture the id of the most-recently-started run so the "See Runs" link
  // can deep-link to /runs?run=<id>, which the Runs page picks up to open
  // that run's detail panel.
  const [lastRunId, setLastRunId] = useState<number | null>(null);

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

  // Kick off a run with a fresh browser session. The server does the reset
  // (close + bootstrap) as part of the run itself, so it can't race with the
  // preview stream or other run triggers.
  async function runScenario(s: Scenario) {
    if (runningId != null) return;
    setErr(null);
    setRunningId(s.id);
    setRunStatus(`Starting run for "${s.name}" (fresh browser)…`);
    try {
      const run = await api.startRun(s.id, { reset: true });
      setLastRunId(run.id);
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
          {runStatus}{' '}
          <Link to={lastRunId != null ? `/runs?run=${lastRunId}` : '/runs'}>See Runs</Link>
        </p>
      )}

      <details className="card">
        <summary><h3>New scenario</h3></summary>
        <form onSubmit={create}>
          <label htmlFor="scenario-name">
            Name
            <input
              id="scenario-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label htmlFor="scenario-url">
            URL
            <input
              id="scenario-url"
              name="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
          <label htmlFor="scenario-viewport">
            Viewport
            <select
              id="scenario-viewport"
              name="viewport_preset"
              value={preset}
              onChange={(e) => setPreset(e.target.value as any)}
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label htmlFor="scenario-brand">
            Brand <span className="muted">(used to filter on the homepage)</span>
            <input
              id="scenario-brand"
              name="brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Acme"
            />
          </label>
          <label htmlFor="scenario-type">
            Type <span className="muted">(used to filter on the homepage)</span>
            <input
              id="scenario-type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="e.g. Checkout flow"
            />
          </label>
          <button type="submit">Create</button>
        </form>
      </details>

      <table className="table scenarios-table">
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
              <td data-label="Name">
                <Link to={`/scenarios/${s.id}`}>{s.name}</Link>
              </td>
              <td data-label="URL" className="scenario-url">{s.url}</td>
              <td data-label="Viewport">{s.viewport_preset}</td>
              <td data-label="Brand">
                <input
                  className="inline-tag-input"
                  aria-label={`Brand for ${s.name}`}
                  defaultValue={s.brand ?? ''}
                  placeholder="—"
                  onBlur={(e) => updateTag(s, 'brand', e.target.value)}
                />
              </td>
              <td data-label="Type">
                <input
                  className="inline-tag-input"
                  aria-label={`Type for ${s.name}`}
                  defaultValue={s.type ?? ''}
                  placeholder="—"
                  onBlur={(e) => updateTag(s, 'type', e.target.value)}
                />
              </td>
              <td data-label="Updated">{s.updated_at}</td>
              <td className="scenario-actions">
                <button
                  onClick={() => runScenario(s)}
                  disabled={runningId != null}
                  title="Reset the browser session, then run this scenario"
                >
                  {runningId === s.id ? 'Running…' : '▶ Run'}
                </button>
                <Link to={`/screenshots/timeline/${s.id}`} className="btn-link">
                  Screenshots
                </Link>
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

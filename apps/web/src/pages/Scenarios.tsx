import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Scenario } from '../lib/api.js';

export function Scenarios() {
  const [items, setItems] = useState<Scenario[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [preset, setPreset] = useState<'desktop' | 'mobile' | 'both'>('desktop');
  const [err, setErr] = useState<string | null>(null);

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
      await api.createScenario({ name, url, viewport_preset: preset });
      setName('');
      setUrl('https://');
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

  return (
    <section>
      <h1>Scenarios</h1>
      {err && <p className="error">{err}</p>}

      <form onSubmit={create} className="card">
        <h3>New scenario</h3>
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
        <button type="submit">Create</button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>URL</th>
            <th>Viewport</th>
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
              <td>{s.updated_at}</td>
              <td>
                <button onClick={() => remove(s.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';

interface EnvEntry {
  key: string;
  value: string;
  secret: boolean;
}

// Admin page: view + edit the repo-root .env file. Secret-looking values
// (tokens/keys/passwords) are masked until explicitly revealed. Saving rewrites
// the file on the server (comments and order preserved, previous content backed
// up to .env.bak) — but config is snapshotted at boot, so most changes only
// take effect after a server restart.
export function AdminEnv() {
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [original, setOriginal] = useState<string>('[]');
  const [meta, setMeta] = useState<{ path: string; exists: boolean; updatedAt: string | null } | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await api.getEnv();
      setEntries(r.entries);
      setOriginal(JSON.stringify(r.entries.map(({ key, value }) => ({ key, value }))));
      setMeta({ path: r.path, exists: r.exists, updatedAt: r.updatedAt });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const dirty =
    JSON.stringify(entries.map(({ key, value }) => ({ key, value }))) !== original;

  function setValue(key: string, value: string) {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, value } : e)));
  }

  function removeEntry(key: string) {
    if (!confirm(`Remove ${key} from .env?\n\n(The line is deleted on save; the previous file is kept as .env.bak.)`)) return;
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }

  function toggleReveal(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addEntry() {
    const key = newKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setError(`"${key}" is not a valid env var name (letters, digits, underscores; can't start with a digit).`);
      return;
    }
    if (entries.some((e) => e.key === key)) {
      setError(`${key} already exists — edit its value in the table above.`);
      return;
    }
    setError(null);
    setEntries((prev) => [
      ...prev,
      { key, value: newValue, secret: /(TOKEN|SECRET|KEY|PASS|PASSWORD|CREDENTIAL)/i.test(key) },
    ]);
    setNewKey('');
    setNewValue('');
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.saveEnv(entries.map(({ key, value }) => ({ key, value })));
      setNotice(
        `Saved to .env (previous version kept as ${r.backupPath.split(/[\\/]/).pop()}). ` +
          'Restart the server for most changes to take effect.',
      );
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">← Admin</Link></p>
      <h1>Environment variables</h1>
      <p className="muted">
        Edits the server's <code>.env</code> file
        {meta ? <> at <code>{meta.path}</code></> : null}. Comments and ordering are preserved;
        the previous content is backed up to <code>.env.bak</code> on every save.{' '}
        <strong>Most values are read once at server start — restart the server to apply changes.</strong>
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}
      {meta && !meta.exists && (
        <p className="error">No .env file found — saving will create one.</p>
      )}

      <table className="table" style={{ maxWidth: 860 }}>
        <thead>
          <tr>
            <th style={{ width: 280 }}>Variable</th>
            <th>Value</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">No variables set.</td>
            </tr>
          )}
          {entries.map((e) => {
            const hidden = e.secret && !revealed.has(e.key);
            return (
              <tr key={e.key}>
                <td><code>{e.key}</code></td>
                <td>
                  <input
                    type={hidden ? 'password' : 'text'}
                    value={e.value}
                    onChange={(ev) => setValue(e.key, ev.target.value)}
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {e.secret && (
                      <button
                        type="button"
                        onClick={() => toggleReveal(e.key)}
                        title={hidden ? 'Reveal value' : 'Hide value'}
                        style={{ padding: '4px 8px' }}
                      >
                        {hidden ? <Eye size={14} aria-label="Reveal" /> : <EyeOff size={14} aria-label="Hide" />}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeEntry(e.key)}
                      title={`Remove ${e.key}`}
                      style={{ padding: '4px 8px' }}
                    >
                      <Trash2 size={14} aria-label="Remove" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 860, marginTop: 12 }}>
        <input
          placeholder="NEW_VARIABLE"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase())}
          style={{ width: 260, fontFamily: 'monospace' }}
          autoComplete="off"
          spellCheck={false}
        />
        <input
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          style={{ flex: 1, fontFamily: 'monospace' }}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" onClick={addEntry} disabled={!newKey.trim()} title="Add variable">
          <Plus size={14} aria-hidden /> Add
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'Saving…' : '💾 Save .env'}
        </button>
        <button onClick={() => void refresh()} disabled={busy || !dirty} title="Discard unsaved edits">
          Discard changes
        </button>
        {dirty && <span className="muted">Unsaved changes</span>}
        {meta?.updatedAt && !dirty && (
          <span className="muted">File last modified {new Date(meta.updatedAt).toLocaleString()}</span>
        )}
      </div>
    </section>
  );
}

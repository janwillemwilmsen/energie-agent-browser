import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Admin page for the AI scenario builder: pick which model the "✨ AI task"
// agent uses. The choice is stored server-side (app_settings) and takes effect
// on the next task — no restart needed. Clearing it falls back to the
// AI_GATEWAY_MODEL env var, then the built-in default.
export function AdminAi() {
  const [model, setModel] = useState('');
  const [current, setCurrent] = useState<{
    model: string;
    source: 'setting' | 'env' | 'default';
    defaultModel: string;
    envModel: string | null;
    available: boolean;
  } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.getAiSettings();
      setCurrent(s);
      setModel(s.source === 'setting' ? s.model : '');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    void refresh();
    api.listAiModels().then((r) => setModels(r.models)).catch(() => undefined);
  }, []);

  async function save(next: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.saveAiSettings(next);
      setNotice(`Saved — the AI task agent now uses ${r.model}.`);
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const sourceLabel =
    current?.source === 'setting'
      ? 'admin override (this page)'
      : current?.source === 'env'
        ? 'AI_GATEWAY_MODEL environment variable'
        : 'built-in default';

  return (
    <section>
      <h1>AI scenario builder</h1>
      <p className="muted">
        Which model the <strong>✨ AI task</strong> agent uses to build scenario steps (via the
        Vercel AI Gateway). Changes apply to the next task immediately.
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}
      {current && !current.available && (
        <p className="error">
          AI_GATEWAY_API_KEY is not configured on the server — AI tasks are disabled regardless of
          the model chosen here.
        </p>
      )}

      {current && (
        <table className="table" style={{ maxWidth: 640 }}>
          <tbody>
            <tr>
              <th style={{ width: 180 }}>Active model</th>
              <td><code>{current.model}</code> <span className="muted">({sourceLabel})</span></td>
            </tr>
            <tr>
              <th>Env (AI_GATEWAY_MODEL)</th>
              <td>{current.envModel ? <code>{current.envModel}</code> : <span className="muted">not set</span>}</td>
            </tr>
            <tr>
              <th>Built-in default</th>
              <td><code>{current.defaultModel}</code></td>
            </tr>
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640, marginTop: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Override model</span>
          <input
            list="ai-model-options"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={`e.g. ${current?.defaultModel ?? 'anthropic/claude-sonnet-4.6'}`}
          />
          {models.length > 0 && (
            <datalist id="ai-model-options">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            {models.length > 0
              ? `${models.length} models available from the gateway — type to filter, or enter any model id.`
              : 'Model list unavailable from the gateway — enter a model id manually (provider/model).'}
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void save(model)} disabled={busy || !model.trim()}>
            {busy ? 'Saving…' : '💾 Save override'}
          </button>
          <button
            onClick={() => void save('')}
            disabled={busy || current?.source !== 'setting'}
            title="Remove the override and fall back to the env var / built-in default"
          >
            Reset to default
          </button>
        </div>
      </div>
    </section>
  );
}

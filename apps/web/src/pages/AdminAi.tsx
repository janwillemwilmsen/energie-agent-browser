import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

// Vercel's "go to dashboard" redirect: resolves to the current team's AI
// Gateway page, where the credit balance is shown and topped up.
const GATEWAY_DASHBOARD_URL = 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway';

// The gateway bills in USD and reports amounts as decimal strings.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function formatUsd(s: string): string {
  const n = Number(s);
  return Number.isFinite(n) ? usd.format(n) : `$${s}`;
}

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
    askModel: string;
    askSource: 'setting' | 'agent';
  } | null>(null);
  const [askModel, setAskModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [credits, setCredits] = useState<
    { balance: string; totalUsed: string } | null | undefined
  >(undefined); // undefined = loading, null = unavailable
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.getAiSettings();
      setCurrent(s);
      setModel(s.source === 'setting' ? s.model : '');
      setAskModel(s.askSource === 'setting' ? s.askModel : '');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    void refresh();
    api.listAiModels().then((r) => setModels(r.models)).catch(() => undefined);
    api
      .getAiCredits()
      .then((r) => {
        setCredits(r.credits);
        setCreditsError(r.error);
      })
      .catch((e) => {
        setCredits(null);
        setCreditsError(e?.message ?? String(e));
      });
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

  async function saveAsk(next: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.saveAskModel(next);
      setNotice(next ? `Saved — Ask now uses ${r.model}.` : 'Ask override removed — it follows the AI task model again.');
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
      <p className="breadcrumb"><Link to="/admin">← Admin</Link></p>
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
            <tr>
              <th>Gateway credits</th>
              <td>
                {credits === undefined ? (
                  <span className="muted">loading…</span>
                ) : credits ? (
                  <>
                    <strong>{formatUsd(credits.balance)}</strong> remaining{' '}
                    <span className="muted">({formatUsd(credits.totalUsed)} used to date)</span>
                  </>
                ) : (
                  <span className="muted" title={creditsError ?? undefined}>
                    unavailable{creditsError ? ` — ${creditsError}` : ''}
                  </span>
                )}
                {' · '}
                <a href={GATEWAY_DASHBOARD_URL} target="_blank" rel="noreferrer">
                  Top up on Vercel ↗
                </a>
              </td>
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

      <h2 style={{ marginTop: 28 }}>Ask (scenario review)</h2>
      <p className="muted">
        The model behind the <strong>Ask</strong> page. It must accept images (the run screenshots go
        in as pictures); a long context helps. Without an override it follows the AI task model above.
      </p>
      {current && (
        <p style={{ margin: '4px 0 8px' }}>
          Active: <code>{current.askModel}</code>{' '}
          <span className="muted">({current.askSource === 'setting' ? 'Ask override' : 'follows the AI task model'})</span>
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Ask model override</span>
          <input
            list="ai-model-options"
            value={askModel}
            onChange={(e) => setAskModel(e.target.value)}
            placeholder="e.g. anthropic/claude-sonnet-4.6 or google/gemini-2.5-flash"
          />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void saveAsk(askModel)} disabled={busy || !askModel.trim()}>
            {busy ? 'Saving…' : '💾 Save Ask override'}
          </button>
          <button onClick={() => void saveAsk('')} disabled={busy || current?.askSource !== 'setting'}>
            Follow AI task model
          </button>
        </div>
      </div>
    </section>
  );
}

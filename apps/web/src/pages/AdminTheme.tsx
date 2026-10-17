import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { applyTheme, cachedTheme, DEFAULT_THEME, THEMES, themeById } from '../lib/theme.js';

// Admin → Theme: pick the UI's colour scheme. Clicking a swatch previews it
// at once (the whole app repaints through the :root variables); Save stores
// it server-side so every browser gets it; Revert goes back to the saved one.

export function AdminTheme() {
  const [saved, setSaved] = useState<string>(cachedTheme());
  const [current, setCurrent] = useState<string>(cachedTheme());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api.getTheme()
      .then((r) => {
        const id = themeById(r.theme).id;
        setSaved(id);
        setCurrent(id);
        applyTheme(id);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, []);

  // Leaving the page with an unsaved preview restores the saved scheme.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => () => { applyTheme(savedRef.current); }, []);

  function preview(id: string) {
    setCurrent(id);
    applyTheme(id);
    setNote(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.updateTheme(current === DEFAULT_THEME ? null : current);
      const id = themeById(r.theme).id;
      setSaved(id);
      setCurrent(id);
      applyTheme(id);
      setNote(`Saved — ${themeById(id).name} is now the scheme for everyone.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = current !== saved;

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">Admin</Link> / Theme</p>
      <h1>Theme</h1>
      <p className="muted">
        The colour scheme of this app. Click one to preview it; save to keep it. The choice is stored on the
        server, so it applies in every browser that opens this instance. All schemes are dark.
      </p>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}

      <div className="theme-grid" role="radiogroup" aria-label="Colour scheme">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={current === t.id}
            className={`theme-card${current === t.id ? ' theme-card-on' : ''}`}
            onClick={() => preview(t.id)}
            style={{ background: t.vars.bg, borderColor: current === t.id ? t.vars.accent : t.vars.border, color: t.vars.text }}
          >
            <span className="theme-sample" style={{ background: t.vars.panel, borderColor: t.vars.border }}>
              <i style={{ background: t.vars.accent }} />
              <i style={{ background: t.vars.text }} />
              <i style={{ background: t.vars.muted }} />
              <i style={{ background: t.vars.error }} />
            </span>
            <strong>{t.name}</strong>
            <span className="theme-desc" style={{ color: t.vars.muted }}>{t.description}</span>
            {t.id === saved && <span className="theme-badge" style={{ color: t.vars.accent }}>saved</span>}
            {t.id === DEFAULT_THEME && <span className="theme-badge" style={{ color: t.vars.muted }}>default</span>}
          </button>
        ))}
      </div>

      <div className="devices-save">
        <button type="button" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? `Save ${themeById(current).name}` : 'Saved'}
        </button>
        {dirty && (
          <button type="button" className="scenario-meta-cancel" onClick={() => preview(saved)} disabled={saving}>
            Revert
          </button>
        )}
        {dirty && <span className="muted">Previewing {themeById(current).name} — not saved yet.</span>}
      </div>
    </section>
  );
}

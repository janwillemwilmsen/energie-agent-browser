import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage, type Scenario, type ScenarioText } from '../lib/api.js';
import { SavedTextBody, fmtBytes, parseSavedText } from '../lib/SavedTextView.js';

// /scenarios/:id/texts — every file a scenario's save_text steps saved,
// grouped by run, newest first, with a reader pane. Texts (agent-browser
// read) and accessibility reports are Markdown, so they render as Markdown
// with a raw toggle for copy/paste; saved page HTML (.html) is shown raw.

export function ScenarioTexts() {
  const { id } = useParams();
  const scenarioId = Number(id);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [texts, setTexts] = useState<ScenarioText[]>([]);
  const [selected, setSelected] = useState<ScenarioText | null>(null);
  const [content, setContent] = useState<string>('');
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A link from a run's panel names what to open (?run=ID&file=NAME); else
  // the newest file is shown.
  const [searchParams] = useSearchParams();
  const wantRun = Number(searchParams.get('run')) || null;
  const wantFile = searchParams.get('file');
  useEffect(() => {
    api.getScenario(scenarioId).then((s) => setScenario(s)).catch((e) => setError(errorMessage(e)));
    api.scenarioTexts(scenarioId)
      .then((t) => {
        setTexts(t);
        const wanted =
          (wantFile ? t.find((x) => x.file === wantFile && (!wantRun || x.runId === wantRun)) : undefined)
          ?? (wantRun ? t.find((x) => x.runId === wantRun) : undefined)
          ?? t[0];
        if (wanted) setSelected(wanted);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [scenarioId, wantRun, wantFile]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setContent('');
    setEditing(false);
    setNotice(null);
    api.runText(selected.runId, selected.file)
      .then((t) => { if (!cancelled) setContent(t); })
      .catch((e) => setError(errorMessage(e)));
    return () => { cancelled = true; };
  }, [selected]);

  const byRun = useMemo(() => {
    const groups = new Map<number, ScenarioText[]>();
    for (const t of texts) {
      const g = groups.get(t.runId) ?? [];
      g.push(t);
      groups.set(t.runId, g);
    }
    return [...groups.entries()];
  }, [texts]);

  // The file starts with an HTML comment header (label · what · viewport · url · time);
  // show it as a caption rather than letting Markdown swallow it.
  const parsed = useMemo(() => parseSavedText(content, selected?.file ?? ''), [content, selected]);
  const { header, body, kind } = parsed;
  const isHtml = kind === 'html';

  // Editing touches the body only; the header is re-attached on save.
  function startEdit() {
    setDraft(body);
    setEditing(true);
    setNotice(null);
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const next = `${header != null ? `<!-- ${header} -->\n\n` : ''}${draft.replace(/\s+$/, '')}\n`;
      const r = await api.saveRunText(selected.runId, selected.file, next);
      setContent(next);
      setTexts((cur) => cur.map((t) => (t.runId === selected.runId && t.file === selected.file ? { ...t, bytes: r.bytes } : t)));
      setEditing(false);
      setNotice(`Saved (${fmtBytes(r.bytes)}).`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="texts">
      <p className="breadcrumb">
        <Link to="/scenarios">← Scenarios</Link>
        {scenario && <> · <Link to={`/scenarios/${scenario.id}`}>{scenario.name}</Link></>}
      </p>
      <h1>Saved texts{scenario ? ` — ${scenario.name}` : ''}</h1>
      <p className="muted">
        Files captured by <strong>save text</strong> steps, one per step per run: the page&apos;s readable text,
        its full HTML, or an axe-core accessibility report (edit the step to choose). Add the step in the
        scenario editor below the step list; the Ask page also feeds these to the model.
      </p>
      {error && <p className="error">{error}</p>}
      {texts.length === 0 && !error && (
        <p className="muted">No texts yet — add a <em>save text</em> step to the scenario and run it.</p>
      )}
      {texts.length > 0 && (
        <div className="texts-layout">
          <aside className="texts-list">
            {byRun.map(([runId, items]) => (
              <div key={runId} className="texts-run">
                <div className="texts-run-head">
                  <Link to={`/runs?run=${runId}`}>run #{runId}</Link>
                  <span className="muted">{new Date(items[0]!.startedAt + 'Z').toLocaleString()} · {items[0]!.status}</span>
                </div>
                {items.map((t) => (
                  <button
                    key={t.file}
                    className={`texts-item${selected?.file === t.file && selected.runId === t.runId ? ' active' : ''}`}
                    onClick={() => setSelected(t)}
                    title={t.file}
                  >
                    <span>
                      {t.label} <span className="muted">({t.viewport})</span>
                      {/\.html$/i.test(t.file) && <span className="tag tag-type" style={{ marginLeft: 6 }}>html</span>}
                    </span>
                    <span className="muted">{fmtBytes(t.bytes)}</span>
                  </button>
                ))}
              </div>
            ))}
          </aside>
          <div className="texts-reader">
            {selected && (
              <div className="texts-reader-head">
                <code>{selected.file}</code>
                {header && <span className="muted">{header}</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {editing ? (
                    <>
                      <button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
                      <button className="ask-secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="ask-secondary" onClick={startEdit} disabled={!content} title="Edit the text, e.g. strip navigation and footer links">✎ Edit</button>
                      {!isHtml && <button className="ask-secondary" onClick={() => setRaw((r) => !r)}>{raw ? 'Rendered' : 'Raw'}</button>}
                      <a className="button-link" href={`/api/runs/${selected.runId}/texts/${encodeURIComponent(selected.file)}`} target="_blank" rel="noreferrer">
                        Open file ↗
                      </a>
                    </>
                  )}
                </span>
              </div>
            )}
            {notice && <p style={{ color: '#4ade80', fontWeight: 600, margin: '0 0 8px' }}>{notice}</p>}
            {selected && !content && <p className="muted">Loading…</p>}
            {editing ? (
              <textarea
                className="texts-edit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            ) : content && <SavedTextBody body={body} kind={kind} raw={raw} />}
          </div>
        </div>
      )}
    </section>
  );
}

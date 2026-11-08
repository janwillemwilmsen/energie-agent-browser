import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, errorMessage, type Scenario, type ScenarioText } from '../lib/api.js';

// /scenarios/:id/texts — every file a scenario's save_text steps saved,
// grouped by run, newest first, with a reader pane. Texts (agent-browser
// read) and accessibility reports are Markdown, so they render as Markdown
// with a raw toggle for copy/paste; saved page HTML (.html) is shown raw.

// An accessibility report ends with the engine's raw JSON under this heading
// (see stepExecutor's captureA11yReport). It is long and rarely read, so the
// reader folds it into a closed <details> below the rendered report.
const RAW_HEADING = /^## Raw result \(JSON\)\s*$/m;
function splitRawSection(md: string): { main: string; raw: string | null } {
  const m = RAW_HEADING.exec(md);
  if (!m) return { main: md, raw: null };
  return { main: md.slice(0, m.index).replace(/\s+$/, ''), raw: md.slice(m.index + m[0].length).trim() };
}

// Every link in a saved text points out of the app (the audited page, a
// deque help page), so they open in a new tab and leave the reader in place.
const mdComponents: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
};

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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

  useEffect(() => {
    api.getScenario(scenarioId).then((s) => setScenario(s)).catch((e) => setError(errorMessage(e)));
    api.scenarioTexts(scenarioId)
      .then((t) => { setTexts(t); if (t[0]) setSelected(t[0]); })
      .catch((e) => setError(errorMessage(e)));
  }, [scenarioId]);

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
  const header = /^<!--\s*(.*?)\s*-->\n*/.exec(content);
  const body = header ? content.slice(header[0].length) : content;
  const isHtml = !!selected && /\.html$/i.test(selected.file);
  const showRaw = raw || isHtml;
  const sections = useMemo(() => splitRawSection(body), [body]);

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
      const next = `${header ? header[0] : ''}${draft.replace(/\s+$/, '')}\n`;
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
                {header && <span className="muted">{header[1]}</span>}
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
            ) : content && (showRaw
              ? <pre className="texts-raw">{body}</pre>
              : (
                <div className="aui-md texts-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{sections.main}</ReactMarkdown>
                  {sections.raw !== null && (
                    <details className="texts-details">
                      <summary>Raw result (JSON)</summary>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{sections.raw}</ReactMarkdown>
                    </details>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

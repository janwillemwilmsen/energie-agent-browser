import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, FileText, Plus, SlidersHorizontal, Square, Trash2, X } from 'lucide-react';
import {
  api,
  errorMessage,
  type AskContext,
  type AskMessage,
  type AskModel,
  type AskPreset,
  type AskScenario,
  type AskThread,
  type AskThreadSummary,
} from '../lib/api.js';

// Ask: chat with the LLM about one or more scenarios — visual, copy and
// conversion feedback grounded in a run's screenshots. The server builds the
// context pack (step narrative + tiled screenshots) and attaches it to the
// first turn of a thread; the browser only ever sends text.
//
// assistant-ui renders the thread. Messages live in React state fed from our
// API (useExternalStoreRuntime), so the DB stays the source of truth and the
// left rail / context strip are plain components of ours.

// Preset prompts come from the server (editable under /ask/prompts).
function usePresets() {
  const [presets, setPresets] = useState<AskPreset[]>([]);
  const refresh = useCallback(async () => {
    try { setPresets(await api.askPresets()); } catch { /* the page still works without presets */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { presets, refresh };
}

// Gateway models for the picker. Only vision-capable ones are offered: the
// screenshots go in as images.
function useModels() {
  const [models, setModels] = useState<AskModel[]>([]);
  const [def, setDef] = useState<{ model: string; source: 'setting' | 'agent' } | null>(null);
  useEffect(() => {
    api.askModels()
      .then((r) => { setModels(r.models.filter((m) => m.vision)); setDef({ model: r.default, source: r.defaultSource }); })
      .catch(() => undefined);
  }, []);
  return { models, def };
}

function ModelSelect({
  value, onChange, models, def, disabled,
}: { value: string; onChange: (m: string) => void; models: AskModel[]; def: { model: string } | null; disabled?: boolean }) {
  // An empty value follows the admin default; a model not in the (vision)
  // list is still shown so an existing choice never silently disappears.
  const known = models.some((m) => m.id === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="ask-model" title="Model for this review">
      <option value="">Default{def ? ` (${def.model})` : ''}</option>
      {!known && value && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}{m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}
        </option>
      ))}
    </select>
  );
}

// --- Page ------------------------------------------------------------------------

export function Ask() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editingPrompts = id === 'prompts';
  const threadId = id && !editingPrompts ? Number(id) : null;
  const [threads, setThreads] = useState<AskThreadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshThreads = useCallback(async () => {
    try { setThreads(await api.askThreads()); } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void refreshThreads(); }, [refreshThreads]);

  async function remove(t: AskThreadSummary) {
    if (!window.confirm(`Delete thread "${t.title}"?`)) return;
    try {
      await api.deleteAskThread(t.id);
      if (threadId === t.id) navigate('/ask');
      await refreshThreads();
    } catch (e) { setError(errorMessage(e)); }
  }

  return (
    <section className="ask">
      <aside className="ask-rail">
        <button className="ask-new" onClick={() => navigate('/ask')} disabled={threadId === null && !editingPrompts}>
          <Plus size={16} aria-hidden /> New review
        </button>
        <button className="ask-new ask-secondary" onClick={() => navigate('/ask/prompts')} disabled={editingPrompts}>
          <SlidersHorizontal size={16} aria-hidden /> Prompts
        </button>
        <ul className="ask-threads">
          {threads.map((t) => (
            <li key={t.id} className={t.id === threadId ? 'active' : undefined}>
              <button className="ask-thread" onClick={() => navigate(`/ask/${t.id}`)} title={t.lastReply}>
                <strong>{t.title}</strong>
                <span className="muted">
                  {t.messageCount} msg · {new Date(t.updatedAt + 'Z').toLocaleDateString()}
                </span>
              </button>
              <button className="ask-thread-del" onClick={() => void remove(t)} title="Delete thread" aria-label="Delete thread">
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
          {threads.length === 0 && <li className="muted" style={{ padding: 8 }}>No reviews yet.</li>}
        </ul>
      </aside>

      <div className="ask-main">
        {error && <p className="error">{error}</p>}
        {editingPrompts ? (
          <PromptsEditor />
        ) : threadId === null ? (
          <NewThread onCreated={async (t) => { await refreshThreads(); navigate(`/ask/${t.id}`); }} />
        ) : (
          <ThreadView key={threadId} threadId={threadId} onChanged={refreshThreads} />
        )}
      </div>
    </section>
  );
}

// --- New thread: pick scenarios ---------------------------------------------------

function NewThread({ onCreated }: { onCreated: (t: AskThreadSummary) => Promise<void> }) {
  const [scenarios, setScenarios] = useState<AskScenario[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { models, def } = useModels();

  useEffect(() => {
    api.askScenarios().then(setScenarios).catch((e) => setError(errorMessage(e)));
  }, []);
  const byId = useMemo(() => new Map(scenarios.map((s) => [s.id, s])), [scenarios]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scenarios.filter((s) => !q || `${s.name} ${s.brand ?? ''} ${s.type ?? ''} ${s.url}`.toLowerCase().includes(q));
  }, [scenarios, filter]);

  function toggle(sid: number) {
    setSelected((cur) => (cur.includes(sid) ? cur.filter((x) => x !== sid) : cur.length >= 6 ? cur : [...cur, sid]));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreated(await api.createAskThread({ title: title.trim() || undefined, scenarioIds: selected, model: model || undefined }));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="ask-new-thread">
      <h1>Ask</h1>
      <p className="muted">
        Click one scenario to review it, or several (up to 6) to compare them — each click adds a card
        to the selection. The latest finished run's screenshots and the step list go to the model with
        your first question; follow-ups reuse them.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="ask-picker-bar">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter scenarios…" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Thread title (optional)" />
        <ModelSelect value={model} onChange={setModel} models={models} def={def} />
        <button onClick={() => void create()} disabled={busy || selected.length === 0}>
          {busy ? 'Creating…' : selected.length > 1 ? `Compare ${selected.length} scenarios` : 'Start review'}
        </button>
      </div>
      <div className="ask-selection">
        {selected.length === 0 && <span className="muted">Nothing selected yet — click a card below.</span>}
        {selected.map((sid) => (
          <span key={sid} className="ask-chip">
            {byId.get(sid)?.name ?? `#${sid}`}
            <button onClick={() => toggle(sid)} title="Remove" aria-label="Remove"><X size={12} aria-hidden /></button>
          </span>
        ))}
        {selected.length > 0 && selected.length < 6 && (
          <span className="muted">click another card to add it to the comparison</span>
        )}
      </div>
      <div className="ask-picker">
        {shown.map((s) => {
          const on = selected.includes(s.id);
          // Reviewable = a finished run with at least one screenshot.
          const usable = !!s.run && s.run.screenshots > 0;
          return (
            <button
              key={s.id}
              className={`ask-pick${on ? ' on' : ''}${usable ? '' : ' norun'}`}
              onClick={() => toggle(s.id)}
              disabled={!usable && !on}
              title={usable ? `Run #${s.run!.id} · ${s.run!.screenshots} screenshots` : s.run ? 'The last run took no screenshots' : 'No finished run — run the scenario first'}
            >
              {s.run?.thumb ? <img src={s.run.thumb} alt="" loading="lazy" /> : <div className="ask-pick-empty">{s.run ? 'no screenshots' : 'no run'}</div>}
              <span className="ask-pick-name">{s.name}</span>
              <span className="muted">
                {s.run ? `${s.run.screenshots} shots · ${s.run.status}` : 'no finished run'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Thread view: context strip + assistant-ui thread ---------------------------

interface LiveMessage extends AskMessage {
  /** True while this assistant reply is still streaming. */
  streaming?: boolean;
}

function ThreadView({ threadId, onChanged }: { threadId: number; onChanged: () => Promise<void> }) {
  const [thread, setThread] = useState<AskThread | null>(null);
  const { presets } = usePresets();
  const { models, def } = useModels();
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.askThread(threadId)
      .then((t) => { if (!cancelled) { setThread(t); setMessages(t.messages); } })
      .catch((e) => setError(errorMessage(e)));
    return () => { cancelled = true; };
  }, [threadId]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim();
    if (!text) return;
    setError(null);
    setRunning(true);
    const tmpUser = -Date.now();
    const tmpAsst = tmpUser - 1;
    setMessages((cur) => [
      ...cur,
      { id: tmpUser, role: 'user', text, withContext: !cur.some((m) => m.withContext), usage: null, error: null, createdAt: new Date().toISOString() },
      { id: tmpAsst, role: 'assistant', text: '', withContext: false, usage: null, error: null, createdAt: new Date().toISOString(), streaming: true },
    ]);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await api.askSend(threadId, text, (ev) => {
        if ('userMessageId' in ev) {
          setMessages((cur) => cur.map((m) => (m.id === tmpUser ? { ...m, id: ev.userMessageId } : m)));
        } else if ('delta' in ev) {
          setMessages((cur) => cur.map((m) => (m.id === tmpAsst ? { ...m, text: m.text + ev.delta } : m)));
        } else if ('done' in ev) {
          setMessages((cur) => cur.map((m) => (m.id === tmpAsst ? { ...m, id: ev.messageId, usage: ev.usage, error: ev.error, streaming: false } : m)));
          if (ev.error) setError(ev.error);
        }
      }, abort.signal);
    } catch (e) {
      const msg = abort.signal.aborted ? 'cancelled' : errorMessage(e);
      setMessages((cur) => cur.map((m) => (m.id === tmpAsst ? { ...m, error: msg, streaming: false } : m)));
      if (!abort.signal.aborted) setError(msg);
    } finally {
      abortRef.current = null;
      setRunning(false);
      void onChanged();
    }
  }, [threadId, onChanged]);

  const onCancel = useCallback(async () => { abortRef.current?.abort(); }, []);

  async function toggleAsset(key: string, exclude: boolean) {
    if (!thread) return;
    const excluded = exclude ? [...thread.excluded, key] : thread.excluded.filter((k) => k !== key);
    try {
      const t = await api.updateAskThread(threadId, { excluded });
      setThread((cur) => (cur ? { ...cur, excluded: t.excluded } : cur));
    } catch (e) { setError(errorMessage(e)); }
  }

  async function changeModel(model: string) {
    try {
      const t = await api.updateAskThread(threadId, { model });
      setThread((cur) => (cur ? { ...cur, model: t.model, effectiveModel: t.effectiveModel } : cur));
      void onChanged();
    } catch (e) { setError(errorMessage(e)); }
  }

  const runtime = useExternalStoreRuntime<LiveMessage>({
    messages,
    isRunning: running,
    convertMessage,
    onNew,
    onCancel,
  });

  if (!thread) return <p className="muted">{error ?? 'Loading…'}</p>;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="ask-thread-view">
        <header className="ask-head">
          <h1>{thread.title}</h1>
          <ModelSelect value={thread.model} onChange={(m) => void changeModel(m)} models={models} def={def} disabled={running} />
        </header>
        <ContextStrip
          context={thread.context}
          excluded={thread.excluded}
          onToggle={(k, ex) => void toggleAsset(k, ex)}
          busy={running}
          defaultCollapsed={thread.context.length > 1 || thread.messages.length > 0}
        />
        {error && <p className="error">{error}</p>}
        <ThreadPrimitive.Root className="aui-thread">
          <ThreadPrimitive.Viewport className="aui-viewport">
            <ThreadPrimitive.Empty>
              <p className="muted">Start with a preset below, or type your own question.</p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <ThreadPrimitive.ViewportFooter className="aui-footer">
              <ThreadPrimitive.ScrollToBottom className="aui-scroll-bottom">↓ Newest</ThreadPrimitive.ScrollToBottom>
              <PresetBar presets={presets} />
              <Composer />
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}

function convertMessage(m: LiveMessage): ThreadMessageLike {
  return {
    id: String(m.id),
    role: m.role,
    content: [{ type: 'text', text: m.text }],
    createdAt: new Date(m.createdAt),
    status:
      m.role === 'assistant'
        ? m.streaming
          ? { type: 'running' }
          : m.error
            ? { type: 'incomplete', reason: m.error === 'cancelled' ? 'cancelled' : 'error', error: m.error }
            : { type: 'complete', reason: 'stop' }
        : undefined,
    metadata: { custom: { usage: m.usage, error: m.error, withContext: m.withContext } },
  };
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

// The assets the model sees for each scenario: screenshots as a thumbnail
// strip, saved page texts as a list. Each asset has a × to drop it from the
// context (the pack is rebuilt per message, so it applies from the next turn)
// and comes back with ↺; removed assets stay visible, dimmed.
function ContextStrip({
  context, excluded, onToggle, busy, defaultCollapsed,
}: { context: AskContext[]; excluded: string[]; onToggle: (key: string, exclude: boolean) => void; busy: boolean; defaultCollapsed: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  // With several scenarios the full strip is taller than the chat; start
  // folded to a one-line summary and let the user expand it when needed.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const isOut = (key: string) => excluded.includes(key);
  const totals = context.reduce(
    (t, c) => {
      t.shots += c.screenshots.filter((x) => !isOut(x.key)).length;
      t.shotsAll += c.screenshots.length;
      t.texts += c.texts.filter((x) => !isOut(x.key)).length;
      t.textsAll += c.texts.length;
      return t;
    },
    { shots: 0, shotsAll: 0, texts: 0, textsAll: 0 },
  );
  const summary =
    `${context.length} scenario${context.length === 1 ? '' : 's'} · ` +
    `${totals.shots}${totals.shots !== totals.shotsAll ? `/${totals.shotsAll}` : ''} screenshots · ` +
    `${totals.texts}${totals.texts !== totals.textsAll ? `/${totals.textsAll}` : ''} texts`;
  const toggleBtn = (key: string, what: string) =>
    isOut(key) ? (
      <button className="ask-asset-btn" disabled={busy} onClick={() => onToggle(key, false)} title={`Add this ${what} back to the context`} aria-label="Restore">↺</button>
    ) : (
      <button className="ask-asset-btn" disabled={busy} onClick={() => onToggle(key, true)} title={`Remove this ${what} from the context`} aria-label="Remove"><X size={12} aria-hidden /></button>
    );
  return (
    <div className={`ask-context${collapsed ? ' collapsed' : ''}`}>
      <div className="ask-context-bar">
        <span className="muted">Context: {summary}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {collapsed ? context.map((c) => c.name).join(' · ') : ''}
        </span>
        <button className="linkish" style={{ marginLeft: 'auto' }} onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'show context' : 'hide context'}
        </button>
      </div>
      {!collapsed && <div className="ask-context-body">
      {context.map((c) => {
        const shotsIn = c.screenshots.filter((s) => !isOut(s.key)).length;
        const textsIn = c.texts.filter((t) => !isOut(t.key)).length;
        return (
          <div key={c.scenarioId} className="ask-ctx">
            <div className="ask-ctx-head">
              <strong>{c.name}</strong>
              <span className="muted">
                {c.runId
                  ? `run #${c.runId} · ${c.runStatus} · ${shotsIn}/${c.screenshots.length} screenshots · ${textsIn}/${c.texts.length} texts · ${c.steps.length} steps`
                  : 'no finished run'}
              </span>
              <button className="linkish" onClick={() => setOpen(open === c.scenarioId ? null : c.scenarioId)}>
                {open === c.scenarioId ? 'hide steps' : 'steps'}
              </button>
            </div>
            {c.screenshots.length > 0 && (
              <div className="ask-ctx-shots">
                {c.screenshots.map((s) => (
                  <div key={s.key} className={`ask-asset ask-shot${isOut(s.key) ? ' out' : ''}`} title={s.file}>
                    <a href={s.url ?? '#'} target="_blank" rel="noreferrer" title={`${s.file} — open in a new window`}>
                      {s.thumb && <img src={s.thumb} alt={s.file} loading="lazy" />}
                    </a>
                    {toggleBtn(s.key, 'screenshot')}
                  </div>
                ))}
              </div>
            )}
            {c.texts.length > 0 && (
              <ul className="ask-ctx-texts">
                {c.texts.map((t) => (
                  <li key={t.key} className={`ask-asset${isOut(t.key) ? ' out' : ''}`}>
                    <FileText size={14} aria-hidden />
                    <a href={t.url ?? '#'} target="_blank" rel="noreferrer" title={`${t.file} — open in a new window`}>{t.file}</a>
                    <span className="muted">{fmtBytes(t.bytes)}</span>
                    {toggleBtn(t.key, 'text')}
                  </li>
                ))}
              </ul>
            )}
            {open === c.scenarioId && (
              <ol className="ask-ctx-steps">
                {c.steps.map((s) => <li key={s}>{s.replace(/^\d+\.\s*/, '')}</li>)}
              </ol>
            )}
          </div>
        );
      })}
      </div>}
    </div>
  );
}

// Presets sit above the composer on every thread, not only an empty one: a
// follow-up like "Form friction" on an ongoing review is the common case.
function PresetBar({ presets }: { presets: AskPreset[] }) {
  if (presets.length === 0) return null;
  return (
    <div className="ask-presets">
      {presets.map((p) => (
        <ThreadPrimitive.Suggestion key={p.id} prompt={p.prompt} send className="ask-preset" title={p.prompt}>
          {p.label}
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}

// --- Prompts editor (/ask/prompts) -------------------------------------------------

function PromptsEditor() {
  const { presets, refresh } = usePresets();
  const [drafts, setDrafts] = useState<Record<number, { label: string; prompt: string }>>({});
  const [adding, setAdding] = useState<{ label: string; prompt: string } | null>(null);
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draftOf = (p: AskPreset) => drafts[p.id] ?? { label: p.label, prompt: p.prompt };
  const dirty = (p: AskPreset) => { const d = draftOf(p); return d.label !== p.label || d.prompt !== p.prompt; };
  const setDraft = (id: number, d: { label: string; prompt: string }) => setDrafts((cur) => ({ ...cur, [id]: d }));

  async function save(p: AskPreset) {
    setBusy(p.id); setError(null);
    try {
      await api.updateAskPreset(p.id, draftOf(p));
      setDrafts((cur) => { const n = { ...cur }; delete n[p.id]; return n; });
      await refresh();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function remove(p: AskPreset) {
    if (!window.confirm(`Delete preset "${p.label}"?`)) return;
    setBusy(p.id); setError(null);
    try { await api.deleteAskPreset(p.id); await refresh(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function move(p: AskPreset, dir: -1 | 1) {
    const idx = presets.findIndex((x) => x.id === p.id);
    const other = presets[idx + dir];
    if (!other) return;
    setBusy(p.id); setError(null);
    try {
      // Swap positions; equal positions fall back to id order, so give the
      // mover the neighbour's slot and the neighbour the mover's.
      await api.updateAskPreset(p.id, { position: other.position });
      await api.updateAskPreset(other.id, { position: p.position });
      await refresh();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function create() {
    if (!adding) return;
    setBusy('new'); setError(null);
    try { await api.createAskPreset(adding); setAdding(null); await refresh(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  return (
    <div className="ask-prompts">
      <h1>Preset prompts</h1>
      <p className="muted">
        The buttons above the composer. Each sends its prompt as your message; the scenario context
        (screenshots + steps) is attached by the server on a thread's first turn regardless.
      </p>
      {error && <p className="error">{error}</p>}
      {presets.map((p, i) => {
        const d = draftOf(p);
        return (
          <div key={p.id} className="ask-prompt">
            <div className="ask-prompt-head">
              <input value={d.label} onChange={(e) => setDraft(p.id, { ...d, label: e.target.value })} placeholder="Label" />
              <button onClick={() => void move(p, -1)} disabled={i === 0 || busy !== null} title="Move up">↑</button>
              <button onClick={() => void move(p, 1)} disabled={i === presets.length - 1 || busy !== null} title="Move down">↓</button>
              <button onClick={() => void save(p)} disabled={!dirty(p) || busy !== null}>{busy === p.id ? 'Saving…' : 'Save'}</button>
              <button className="ask-danger" onClick={() => void remove(p)} disabled={busy !== null} title="Delete"><Trash2 size={14} aria-hidden /></button>
            </div>
            <textarea value={d.prompt} onChange={(e) => setDraft(p.id, { ...d, prompt: e.target.value })} rows={4} />
          </div>
        );
      })}
      {adding ? (
        <div className="ask-prompt">
          <div className="ask-prompt-head">
            <input value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} placeholder="Label (button text)" autoFocus />
            <button onClick={() => void create()} disabled={!adding.label.trim() || !adding.prompt.trim() || busy !== null}>
              {busy === 'new' ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => setAdding(null)} disabled={busy !== null}>Cancel</button>
          </div>
          <textarea value={adding.prompt} onChange={(e) => setAdding({ ...adding, prompt: e.target.value })} rows={4} placeholder="The prompt sent as your message" />
        </div>
      ) : (
        <button onClick={() => setAdding({ label: '', prompt: '' })}><Plus size={16} aria-hidden /> Add prompt</button>
      )}
    </div>
  );
}

// --- Message + composer components for assistant-ui -----------------------------

function UserMessage() {
  const withContext = useAuiState((s) => !!(s.message.metadata.custom as { withContext?: boolean } | undefined)?.withContext);
  return (
    <MessagePrimitive.Root className="aui-msg aui-user">
      <div className="aui-bubble">
        <MessagePrimitive.Parts />
        {withContext && <span className="aui-tag" title="Screenshots and step list were attached to this turn">📎 context attached</span>}
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const custom = useAuiState((s) => s.message.metadata.custom as { usage?: { total_tokens?: number; cost?: number } | null; error?: string | null } | undefined);
  const status = useAuiState((s) => s.message.status);
  return (
    <MessagePrimitive.Root className="aui-msg aui-assistant">
      <div className="aui-bubble">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        {status?.type === 'running' && <span className="aui-cursor" aria-hidden />}
        {custom?.error && <p className="error" style={{ margin: '6px 0 0' }}>{custom.error}</p>}
        {custom?.usage && (
          <span className="aui-usage muted">
            {custom.usage.total_tokens?.toLocaleString()} tokens
            {typeof custom.usage.cost === 'number' ? ` · $${custom.usage.cost.toFixed(4)}` : ''}
          </span>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md" />;
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="aui-composer">
      <ComposerPrimitive.Input
        className="aui-input"
        placeholder="Ask about these scenarios… (Enter to send, Shift+Enter for a new line)"
        autoFocus
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="aui-send" title="Send"><ArrowUp size={16} aria-hidden /></ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="aui-send aui-stop" title="Stop"><Square size={14} aria-hidden /></ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}

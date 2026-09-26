import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StepKind } from '@eab/shared';
import { api, type Preflight, type ScenarioDetail } from '../lib/api.js';
import { AddStepControls, SnapshotPane, StepList, useServerStepStore } from '../lib/stepEditor/index.js';
import { PreviewStream } from '../lib/screencast.js';
import { TerminalShell, type TerminalShellHandle } from '../lib/TerminalShell.js';

const SESSION = 'default';

// "compact" next to the Steps heading: cap the step list's height and scroll
// inside it, so a long scenario doesn't push the add-step controls and the
// Run button off screen. Remembered across scenarios like the sidebar state.
const COMPACT_STEPS_KEY = 'eab.scenarioEditor.compactSteps';

// Every Scenario Step kind the visual editor offers. `evaluate` is left to the
// admin raw editor and the AI builder.
const SCENARIO_KINDS = StepKind.options.filter((k) => k !== 'evaluate');

interface MetaDraft {
  name: string;
  url: string;
  viewport_preset: 'desktop' | 'mobile' | 'both';
  brand: string;
  type: string;
  preflight_id: number | null;
  preflight_mode: 'steps' | 'cookies';
}

function emptyDraft(): MetaDraft {
  return {
    name: '',
    url: '',
    viewport_preset: 'desktop',
    brand: '',
    type: '',
    preflight_id: null,
    preflight_mode: 'steps',
  };
}

function draftFrom(d: ScenarioDetail): MetaDraft {
  return {
    name: d.name,
    url: d.url,
    viewport_preset: d.viewport_preset,
    brand: d.brand ?? '',
    type: d.type ?? '',
    preflight_id: d.preflight_id ?? null,
    preflight_mode: d.preflight_mode ?? 'steps',
  };
}

function draftsEqual(a: MetaDraft, b: MetaDraft): boolean {
  return (
    a.name === b.name &&
    a.url === b.url &&
    a.viewport_preset === b.viewport_preset &&
    a.brand === b.brand &&
    a.type === b.type &&
    a.preflight_id === b.preflight_id &&
    a.preflight_mode === b.preflight_mode
  );
}

export function ScenarioEditor() {
  const { id } = useParams();
  const scenarioId = Number(id);
  const [data, setData] = useState<ScenarioDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [compactSteps, setCompactSteps] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMPACT_STEPS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COMPACT_STEPS_KEY, compactSteps ? '1' : '0');
    } catch {
      /* ignore — storage may be unavailable (private mode, etc.) */
    }
  }, [compactSteps]);
  const [sessionAlive, setSessionAlive] = useState<boolean | null>(null);
  const [playStatus, setPlayStatus] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<number | null>(null);
  const [draft, setDraft] = useState<MetaDraft>(emptyDraft());
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaSavedAt, setMetaSavedAt] = useState<number | null>(null);
  const [preflights, setPreflights] = useState<Preflight[]>([]);
  const termRef = useRef<TerminalShellHandle | null>(null);

  useEffect(() => {
    api.sessionStatus(SESSION).then((s) => setSessionAlive(s.alive)).catch(() => undefined);
    api.listPreflights().then(setPreflights).catch(() => undefined);
  }, []);

  async function reload() {
    if (!scenarioId) return;
    try {
      const fresh = await api.getScenario(scenarioId);
      setData(fresh);
      setDraft(draftFrom(fresh));
    } catch (e: any) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    reload();
  }, [scenarioId]);

  // Steps persist through the per-step API; the editor module drives it.
  const stepStore = useServerStepStore({
    scenarioId,
    steps: data?.steps ?? [],
    reload,
    onError: setErr,
  });

  async function saveRetry(
    patch: Partial<{
      retries: number;
      retry_wait_before_ms: number;
      retry_wait_after_ms: number;
      restart_on_failure: number;
    }>,
  ) {
    try {
      const updated = await api.updateScenario(scenarioId, patch);
      setData((d) => (d ? { ...d, ...updated } : d));
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function runNow() {
    setErr(null);
    try {
      const run = await api.startRun(scenarioId);
      alert(`Run #${run.id} started (status: ${run.status}). See Runs page.`);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function resetSession() {
    setErr(null);
    setResetting(true);
    setSessionAlive(false);
    try {
      await api.closeSession(SESSION).catch(() => undefined);
      const res = await api.bootstrapSession(SESSION);
      setSessionAlive(res.alive);
      if (!res.alive) setErr('Reset finished but the session did not come back up.');
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setResetting(false);
    }
  }

  async function playScenario(opts: { reset?: boolean } = {}) {
    setErr(null);
    setPlayStatus(null);
    setLastRunId(null);
    if (!previewActive) setPreviewActive(true);
    // The server owns session lifecycle now: the runner starts the session if
    // it's down, and `reset: true` restarts it before the run (fresh cookie
    // jar). No client-side close/bootstrap orchestration — that raced with the
    // preview stream and other run triggers.
    try {
      setPlayStatus(opts.reset ? 'Starting run (fresh browser)…' : 'Starting run…');
      const run = await api.startRun(scenarioId, { reset: opts.reset });
      setLastRunId(run.id);
      setPlayStatus(`Run #${run.id} ${run.status}`);
      // Poll the run row until it reaches a terminal state.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const r2 = await api.getRun(run.id);
          setPlayStatus(`Run #${r2.id} ${r2.status}`);
          if (r2.status === 'success' || r2.status === 'failed') break;
        } catch {
          /* keep polling */
        }
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setPlayStatus(null);
    }
  }

  async function bootstrap() {
    // The agent-browser native exe needs a real Windows console to start;
    // spawning headless silently fails. The server endpoint accepts a brief
    // console popup so the daemon can come up — a flash, then it's gone.
    setErr(null);
    setBootstrapping(true);
    setSessionAlive(false);
    try {
      const res = await api.bootstrapSession(SESSION);
      setSessionAlive(res.alive);
      if (!res.alive) {
        setErr('Bootstrap returned but session did not come up. Try clicking Bootstrap again.');
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBootstrapping(false);
    }
  }

  async function saveMeta(e?: React.FormEvent) {
    e?.preventDefault();
    if (!data) return;
    if (savingMeta) return;
    if (!draft.name.trim() || !draft.url.trim()) {
      setErr('Name and URL are required.');
      return;
    }
    setSavingMeta(true);
    setErr(null);
    try {
      const updated = await api.updateScenario(scenarioId, {
        name: draft.name.trim(),
        url: draft.url.trim(),
        viewport_preset: draft.viewport_preset,
        brand: draft.brand.trim() || null,
        type: draft.type.trim() || null,
        preflight_id: draft.preflight_id,
        preflight_mode: draft.preflight_mode,
      });
      const next = { ...data, ...updated };
      setData(next);
      setDraft(draftFrom(next));
      setMetaSavedAt(Date.now());
    } catch (err: any) {
      setErr(err.message);
    } finally {
      setSavingMeta(false);
    }
  }

  if (err && !data) return <p className="error">{err}</p>;
  if (!data) return <p>Loading…</p>;

  const dirty = !draftsEqual(draft, draftFrom(data));
  const savedRecently = metaSavedAt != null && Date.now() - metaSavedAt < 3000;

  return (
    <section>
      <form onSubmit={saveMeta} className="scenario-meta-form">
        <div className="scenario-meta-row">
          <label className="scenario-meta-name">
            <span>Name</span>
            <input
			name="name"
			type="text"
			  id="scenario-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </label>
          <label>
            <span>Viewport</span>
            <select
              value={draft.viewport_preset}
              onChange={(e) =>
                setDraft({ ...draft, viewport_preset: e.target.value as MetaDraft['viewport_preset'] })
              }
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="both">Both</option>
            </select>
          </label>
        </div>
        <label className="scenario-meta-url">
          <span>URL</span>
          <input
		  name="url"
		  type="url"
		    id="scenario-url"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            required
          />
        </label>
        <div className="scenario-meta-row">
          <label>
            <span>Brand</span>
            <input
              value={draft.brand}
              onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
              placeholder="e.g. Acme"
            />
          </label>
          <label>
            <span>Type</span>
            <input
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value })}
              placeholder="e.g. Checkout flow"
            />
          </label>
          <label>
            <span>Use preflight steps from</span>
            <select
              value={draft.preflight_id ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  preflight_id: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              title="Pick a saved preflight. Its cookies/localStorage are restored before this scenario's steps run. Manage preflights on the Preflights page."
            >
              <option value="">— none —</option>
              {preflights.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {draft.preflight_id != null && (
            <label>
              <span>Preflight mode</span>
              <select
                value={draft.preflight_mode}
                onChange={(e) =>
                  setDraft({ ...draft, preflight_mode: e.target.value as MetaDraft['preflight_mode'] })
                }
                title={
                  'Run all steps: re-run the preflight (login/consent) in a clean browser every run.\n' +
                  'Use saved cookies: skip the steps and load the preflight’s saved cookies/login (faster; needs a saved state).'
                }
              >
                <option value="steps">Run all preflight steps (clean browser)</option>
                <option value="cookies">Use saved cookies only (skip steps)</option>
              </select>
            </label>
          )}
        </div>
        <div className="scenario-meta-actions">
          <button type="submit" disabled={!dirty || savingMeta}>
            {savingMeta ? 'Saving…' : dirty ? 'Save scenario' : 'Saved'}
          </button>
          {dirty && (
            <button
              type="button"
              className="scenario-meta-cancel"
              onClick={() => setDraft(draftFrom(data))}
              disabled={savingMeta}
            >
              Revert
            </button>
          )}
          {!dirty && savedRecently && <span className="muted">Saved.</span>}
          <span className="muted">uses session <code>{SESSION}</code></span>
        </div>
      </form>
      {err && <p className="error">{err}</p>}

      <div className="editor-grid scenario-editor">
        <div>
          <h2>
            Steps{' '}
            <Link
              to={`/admin/scenario-steps?scenario=${scenarioId}`}
              className="steps-raw-link"
              title="Open this scenario in the raw steps editor (Admin)"
            >
              edit raw
            </Link>{' '}
            <button
              type="button"
              className={`steps-raw-link${compactSteps ? ' active' : ''}`}
              aria-pressed={compactSteps}
              title={
                compactSteps
                  ? 'Show the full step list (no inner scrollbar)'
                  : 'Cap the step list height and scroll inside it — handy for long scenarios'
              }
              onClick={() => setCompactSteps((v) => !v)}
            >
              {compactSteps ? 'compact ✓' : 'compact'}
            </button>
          </h2>
          <div className="retry-policy">
            <span className="muted">On step failure, retry</span>
            <label>
              <input
                type="number"
                min={0}
                defaultValue={data.retries}
                onBlur={(e) => saveRetry({ retries: clampInt(e.target.value) })}
              />
              <span>times</span>
            </label>
            <label>
              <span>wait before</span>
              <input
                type="number"
                min={0}
                defaultValue={data.retry_wait_before_ms}
                onBlur={(e) => saveRetry({ retry_wait_before_ms: clampInt(e.target.value) })}
              />
              <span>ms</span>
            </label>
            <label>
              <span>wait after</span>
              <input
                type="number"
                min={0}
                defaultValue={data.retry_wait_after_ms}
                onBlur={(e) => saveRetry({ retry_wait_after_ms: clampInt(e.target.value) })}
              />
              <span>ms</span>
            </label>
          </div>
          <div className="retry-policy">
            <span className="muted">If the whole run fails, reset the browser &amp; restart</span>
            <label>
              <input
                type="number"
                min={0}
                defaultValue={data.restart_on_failure}
                onBlur={(e) => saveRetry({ restart_on_failure: clampInt(e.target.value) })}
              />
              <span>times</span>
            </label>
          </div>
          <div className={compactSteps ? 'step-list-compact' : undefined}>
            <StepList
              store={stepStore}
              empty="No steps yet. Take a snapshot, then click any node to add a step."
            />
          </div>

          <AddStepControls
            store={stepStore}
            kinds={SCENARIO_KINDS}
            defaultUrl={data.url}
            onError={setErr}
          >
            <button onClick={runNow} disabled={data.steps.length === 0}>
              ▶ Run now
            </button>
            <button
              onClick={() => setAiModalOpen(true)}
              title="Describe a task in plain language — an AI drives the browser and each action it takes is appended to this scenario as a replayable step"
            >
              ✨ AI task
            </button>
          </AddStepControls>
        </div>

        {aiModalOpen && (
          <AiTaskModal
            scenarioId={scenarioId}
            onClose={() => {
              setAiModalOpen(false);
              // The modal's live stream kicked this page's preview (server
              // allows one viewer). Bounce it so it reconnects if it was on.
              if (previewActive) {
                setPreviewActive(false);
                window.setTimeout(() => setPreviewActive(true), 400);
              }
            }}
            onStepsAdded={() => void reload()}
          />
        )}

        <div className="se-preview">
          <h2>
            Preview{' '}
            <button onClick={() => setPreviewActive((v) => !v)}>
              {previewActive ? 'stop' : 'start'}
            </button>{' '}
            <button onClick={() => playScenario()} disabled={data.steps.length === 0}>
              ▶ Play scenario
            </button>{' '}
            <button
              onClick={() => playScenario({ reset: true })}
              disabled={data.steps.length === 0 || resetting}
              title="Reset the browser session, then play the scenario"
            >
              ↻▶ Reset &amp; play
            </button>{' '}
            {playStatus &&
              (lastRunId != null ? (
                <Link to={`/runs?run=${lastRunId}`} className="muted" style={{ marginLeft: 8 }}>
                  {playStatus}
                </Link>
              ) : (
                <span className="muted" style={{ marginLeft: 8 }}>{playStatus}</span>
              ))}
          </h2>
          <PreviewStream session={SESSION} active={previewActive} />

          <h2 style={{ marginTop: 24 }}>Snapshot</h2>
          <SnapshotPane
            store={stepStore}
            kinds={SCENARIO_KINDS}
            session={SESSION}
            defaultUrl={data.url}
            onError={setErr}
          />
        </div>
      </div>

      <h2 style={{ marginTop: 32 }}>Terminal</h2>
      <p className="muted">
        First-run setup: click <strong>Bootstrap default session</strong>. The URL is read from{' '}
        <code>BROWSERLESS_URL</code> + <code>BROWSERLESS_TOKEN</code> in <code>.env</code> and
        exposed as <code>%BROWSERLESS_CDP_URL%</code> — you never have to type it.
      </p>
      <div className="actions">
        <button onClick={bootstrap} disabled={bootstrapping || resetting}>
          {bootstrapping ? 'Bootstrapping…' : sessionAlive ? '✓ Session up — re-bootstrap' : 'Bootstrap default session'}
        </button>
        <button onClick={resetSession} disabled={resetting || bootstrapping}>
          {resetting ? 'Resetting…' : 'Reset session'}
        </button>
        <button onClick={() => termRef.current?.send(`agent-browser --session ${SESSION} get url`)}>
          get url
        </button>
        <button onClick={() => termRef.current?.send(`agent-browser --session ${SESSION} snapshot`)}>
          snapshot
        </button>
        <button onClick={() => termRef.current?.send('agent-browser session list')}>
          session list
        </button>
      </div>
      <TerminalShell ref={termRef} height={340} />
    </section>
  );
}

function clampInt(v: string): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Modal for the "✨ AI task" button: the user describes a task, the server's
// agent loop drives the browser (visible in the live preview) and appends each
// successful action to this scenario as an ordinary replayable step. Closing
// the modal does NOT stop a running job — it keeps building server-side.
function AiTaskModal({
  scenarioId,
  onClose,
  onStepsAdded,
}: {
  scenarioId: number;
  onClose: () => void;
  onStepsAdded: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [history, setHistory] = useState<
    Array<{ id: number; prompt: string; status: string; steps_added: number; created_at: string }>
  >([]);
  // Live preview inside the modal. Off until the job reports the freshly-reset
  // browser is up — the screencast WS rejects (and doesn't retry) when it
  // connects while no daemon pid exists, so we key it off the log marker.
  const [previewOn, setPreviewOn] = useState(false);
  const stepsSeen = useRef(0);

  useEffect(() => {
    api
      .agentAvailability()
      .then((a) => setAvailable(a.available && !a.busy))
      .catch(() => setAvailable(false));
    // Saved prompts for this scenario — prefill the most recent one so a bad
    // result can be re-run (delete the wrong steps, tweak the text, go again).
    api
      .listAgentPrompts(scenarioId)
      .then((rows) => {
        setHistory(rows);
        if (rows[0]) setPrompt((p) => p || rows[0]!.prompt);
      })
      .catch(() => undefined);
  }, [scenarioId]);

  // Poll the job while it runs; refresh the step list whenever new steps landed.
  useEffect(() => {
    if (!jobId || status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const j = await api.getAgentTask(jobId);
        setLog(j.log);
        setSummary(j.summary);
        setError(j.error);
        if (j.log.some((l) => l.startsWith('browser ready'))) setPreviewOn(true);
        if (j.stepsAdded !== stepsSeen.current) {
          stepsSeen.current = j.stepsAdded;
          onStepsAdded();
        }
        if (j.status !== 'running') {
          setStatus(j.status);
          onStepsAdded();
        }
      } catch {
        /* transient poll failure — keep trying */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [jobId, status]);

  async function start() {
    const p = prompt.trim();
    if (!p) return;
    setError(null);
    setSummary(null);
    setLog([]);
    stepsSeen.current = 0;
    // The job restarts the browser session; the old preview socket dies with
    // the old daemon, so re-arm and wait for the fresh "browser ready" marker.
    setPreviewOn(false);
    try {
      const r = await api.startAgentTask(scenarioId, p);
      setJobId(r.jobId);
      setStatus('running');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function deletePrompt(id: number) {
    try {
      await api.deleteAgentPrompt(id);
      setHistory((h) => h.filter((x) => x.id !== id));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function clearHistory() {
    if (!confirm('Delete all saved prompts for this scenario?')) return;
    try {
      await api.clearAgentPrompts(scenarioId);
      setHistory([]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && status !== 'running') onClose(); }}
    >
      <div
        style={{
          width: '100%', maxWidth: 640, maxHeight: '85vh', overflow: 'auto',
          background: 'var(--bg, #1b1b1f)', border: '1px solid var(--border, rgba(127,127,127,0.35))',
          borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>✨ AI task</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Describe what the browser should do. The AI performs it live (watch the preview) and each
          action becomes a step in this scenario — replayable with <strong>Play</strong> and
          schedulable on the <strong>Schedules</strong> page.
        </p>
        {available === false && (
          <p className="error" style={{ margin: 0 }}>
            AI tasks unavailable — either AI_GATEWAY_API_KEY is not configured on the server, or
            another AI task is currently running.
          </p>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder='e.g. "Accept the cookie banner, open the vacancies page and take a screenshot of the list"'
          disabled={status === 'running'}
          style={{ resize: 'vertical', width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void start()} disabled={!prompt.trim() || status === 'running' || available === false}>
            {status === 'running' ? 'Running…' : '▶ Run AI task'}
          </button>
          <button
            onClick={() => setPrompt('')}
            disabled={status === 'running' || !prompt}
            title="Empty the textarea to write a new prompt from scratch"
          >
            ✕ Clear
          </button>
          <button onClick={onClose} disabled={false} title={status === 'running' ? 'The task keeps running server-side' : undefined}>
            Close
          </button>
        </div>
        {previewOn && (
          <div>
            <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
              Live browser — watching the agent work:
            </p>
            <PreviewStream session={SESSION} active={previewOn} />
          </div>
        )}
        {history.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>
              Previous prompts for this scenario ({history.length}){' '}
              <button
                onClick={(e) => { e.preventDefault(); void clearHistory(); }}
                disabled={status === 'running'}
                style={{ fontSize: 11, padding: '2px 8px', marginLeft: 8 }}
                title="Delete all saved prompts for this scenario"
              >
                Clear all
              </button>
            </summary>
            <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.map((h) => (
                <li key={h.id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                  <button
                    onClick={() => setPrompt(h.prompt)}
                    disabled={status === 'running'}
                    title="Load this prompt into the textarea"
                    style={{
                      flex: 1, textAlign: 'left', fontSize: 12, padding: '6px 10px',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}
                  >
                    {h.prompt.length > 160 ? h.prompt.slice(0, 160) + '…' : h.prompt}
                    <span className="muted">
                      {' '}— {h.created_at} · {h.status} · {h.steps_added} step{h.steps_added === 1 ? '' : 's'}
                    </span>
                  </button>
                  <button
                    className="btn-danger"
                    onClick={() => void deletePrompt(h.id)}
                    disabled={status === 'running'}
                    title="Delete this saved prompt"
                    style={{ fontSize: 12, padding: '0 10px' }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        {(log.length > 0 || status !== 'idle') && (
          <pre
            style={{
              margin: 0, padding: 12, fontSize: 12, lineHeight: 1.5,
              background: 'rgba(127,127,127,0.08)', borderRadius: 8,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflow: 'auto',
            }}
          >
            {log.join('\n') || '(starting…)'}
          </pre>
        )}
        {status === 'done' && (
          <p style={{ margin: 0, color: '#4ade80', fontWeight: 600 }}>
            ✓ {summary ?? 'Task complete.'} Steps were appended to this scenario.
          </p>
        )}
        {status === 'failed' && (
          <p className="error" style={{ margin: 0 }}>✗ {error ?? 'Task failed.'}</p>
        )}
        {error && status === 'idle' && <p className="error" style={{ margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

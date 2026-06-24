import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  api,
  type A11yNode,
  type A11yTree,
  type Preflight,
  type ScenarioDetail,
  type ScenarioStep,
} from '../lib/api.js';
import { PreviewStream } from '../lib/screencast.js';
import { TerminalShell, type TerminalShellHandle } from '../lib/TerminalShell.js';

interface SelectorStrategy {
  role: string;
  name: string;
  ordinal?: number;
  ancestorPath?: { role: string; name: string }[];
}

const SESSION = 'default';

interface MetaDraft {
  name: string;
  url: string;
  viewport_preset: 'desktop' | 'mobile' | 'both';
  brand: string;
  type: string;
  preflight_id: number | null;
}

function emptyDraft(): MetaDraft {
  return {
    name: '',
    url: '',
    viewport_preset: 'desktop',
    brand: '',
    type: '',
    preflight_id: null,
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
  };
}

function draftsEqual(a: MetaDraft, b: MetaDraft): boolean {
  return (
    a.name === b.name &&
    a.url === b.url &&
    a.viewport_preset === b.viewport_preset &&
    a.brand === b.brand &&
    a.type === b.type &&
    a.preflight_id === b.preflight_id
  );
}

export function ScenarioEditor() {
  const { id } = useParams();
  const scenarioId = Number(id);
  const [data, setData] = useState<ScenarioDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tree, setTree] = useState<A11yTree | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const [savingStep, setSavingStep] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sessionAlive, setSessionAlive] = useState<boolean | null>(null);
  const [playStatus, setPlayStatus] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<number | null>(null);
  const [draft, setDraft] = useState<MetaDraft>(emptyDraft());
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaSavedAt, setMetaSavedAt] = useState<number | null>(null);
  const [preflights, setPreflights] = useState<Preflight[]>([]);
  const termRef = useRef<TerminalShellHandle | null>(null);

  const sensors = useSensors(
    // A small drag threshold so a click on the handle still works as a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  async function takeSnapshot(useUrl: boolean, interactiveOnly = false) {
    if (!data) return;
    setErr(null);
    setSnapshotting(true);
    try {
      const res = await api.snapshot({
        url: useUrl ? data.url : undefined,
        session: SESSION,
        compact: true,
        interactiveOnly,
      });
      setTree(res.tree);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSnapshotting(false);
    }
  }

  async function onStepDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!data || !over || active.id === over.id) return;
    const ids = data.steps.map((s) => s.id);
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from === -1 || to === -1) return;
    const newSteps = arrayMove(data.steps, from, to);
    setData({ ...data, steps: newSteps }); // optimistic
    setSavingStep(true);
    try {
      await api.reorderSteps(scenarioId, newSteps.map((s) => s.id));
    } catch (e: any) {
      setErr(e.message);
      await reload(); // revert to server truth
    } finally {
      setSavingStep(false);
    }
  }

  async function moveStep(stepId: number, direction: 'up' | 'down') {
    if (!data) return;
    setSavingStep(true);
    try {
      await api.moveStep(scenarioId, stepId, direction);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSavingStep(false);
    }
  }

  async function deleteStep(stepId: number) {
    if (!data) return;
    if (!confirm('Delete this step?')) return;
    setSavingStep(true);
    try {
      await api.deleteStep(scenarioId, stepId);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSavingStep(false);
    }
  }

  async function addStep(kind: string, payload: Record<string, unknown>) {
    if (!data) return;
    setSavingStep(true);
    try {
      const position = data.steps.length;
      await api.addStep(scenarioId, { position, kind, payload });
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSavingStep(false);
    }
  }

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
    if (opts.reset) {
      setPlayStatus('Resetting session…');
      setSessionAlive(false);
      try {
        await api.closeSession(SESSION).catch(() => undefined);
        const r = await api.bootstrapSession(SESSION);
        setSessionAlive(r.alive);
        if (!r.alive) {
          setPlayStatus(null);
          setErr('Reset finished but the session did not come back up.');
          return;
        }
      } catch (e: any) {
        setPlayStatus(null);
        setErr(e.message ?? String(e));
        return;
      }
    } else if (!sessionAlive) {
      setPlayStatus('Bootstrapping session…');
      try {
        const r = await api.bootstrapSession(SESSION);
        setSessionAlive(r.alive);
        if (!r.alive) {
          setPlayStatus(null);
          setErr('Session not ready.');
          return;
        }
      } catch (e: any) {
        setPlayStatus(null);
        setErr(e.message ?? String(e));
        return;
      }
    }
    try {
      setPlayStatus('Starting run…');
      const run = await api.startRun(scenarioId);
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
            <span>Use auth from</span>
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
          <h2>Steps</h2>
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
          {data.steps.length === 0 ? (
            <p className="muted">
              No steps yet. Take a snapshot, then click any node to add a step.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onStepDragEnd}
            >
              <SortableContext
                items={data.steps.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                <ol className="step-list">
                  {data.steps.map((s, idx) => (
                    <SortableStep
                      key={s.id}
                      step={s}
                      idx={idx}
                      total={data.steps.length}
                      savingStep={savingStep}
                      onMoveUp={() => moveStep(s.id, 'up')}
                      onMoveDown={() => moveStep(s.id, 'down')}
                      onDelete={() => deleteStep(s.id)}
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          )}

          <div className="actions">
            <button onClick={() => addStep('navigate', { url: data.url })} disabled={savingStep}>
              + navigate ({data.url})
            </button>
            <button
              onClick={() =>
                addStep('screenshot', {
                  label: `step-${data.steps.length}`,
                  fullPage: true,
                })
              }
              disabled={savingStep}
            >
              + screenshot (full page)
            </button>
            <button
              onClick={() =>
                addStep('screenshot', {
                  label: `step-${data.steps.length}`,
                  fullPage: false,
                })
              }
              disabled={savingStep}
            >
              + screenshot (viewport)
            </button>
            <button
              onClick={() =>
                addStep('screenshot', {
                  label: `step-${data.steps.length}`,
                  fullPage: true,
                  viewport: 'mobile',
                })
              }
              disabled={savingStep}
              title="Switch to the mobile device, capture a full-page screenshot, then restore the viewport"
            >
              + screenshot (mobile)
            </button>
            <button
              onClick={() =>
                addStep('screenshot', {
                  label: `step-${data.steps.length}`,
                  fullPage: true,
                  annotate: true,
                })
              }
              disabled={savingStep}
              title="Full-page screenshot with numbered labels overlaid on interactive elements (legend in the run log)"
            >
              + screenshot (annotated)
            </button>
            <button
              onClick={() => addStep('scroll', { toBottom: true })}
              disabled={savingStep}
              title="Scroll the page to the bottom in strides so lazy-loaded images fire"
            >
              + scroll to bottom
            </button>
            <button
              onClick={() => addStep('scroll', { toTop: true })}
              disabled={savingStep}
              title="Jump back to the top of the page (useful before targeting a header element)"
            >
              + scroll to top
            </button>
            <button
              onClick={() => {
                const raw = prompt('Wait how many milliseconds?', '1000');
                if (raw == null) return;
                const ms = Number(raw);
                if (!Number.isFinite(ms) || ms <= 0) {
                  alert('Must be a positive integer');
                  return;
                }
                addStep('wait', { ms: Math.floor(ms) });
              }}
              disabled={savingStep}
            >
              + wait (ms)
            </button>
            <button
              onClick={() => addStep('record_start', {})}
              disabled={savingStep}
              title="Start a video recording from this point in the scenario (drag to position; saved to the Recordings page)"
            >
              + ⏺ start recording
            </button>
            <button
              onClick={() => addStep('record_stop', {})}
              disabled={savingStep}
              title="Stop the video recording and save it"
            >
              + ⏹ stop recording
            </button>
            <button
              onClick={() => addStep('close', {})}
              disabled={savingStep}
              title="Close the browser session (agent-browser close) — useful as a final step to end the scenario cleanly"
            >
              + ✕ close session
            </button>
            <button onClick={runNow} disabled={data.steps.length === 0}>
              ▶ Run now
            </button>
          </div>
        </div>

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
          <div className="actions">
            <button onClick={() => takeSnapshot(true)} disabled={snapshotting}>
              {snapshotting ? 'Snapshotting…' : `Snapshot ${data.url}`}
            </button>
            <button onClick={() => takeSnapshot(false)} disabled={snapshotting}>
              Snapshot current page
            </button>
            <button
              onClick={() => takeSnapshot(false, true)}
              disabled={snapshotting}
              title="Snapshot current page, interactive elements only (-i)"
            >
              Snapshot interactive (-i)
            </button>
          </div>
          {tree && (
            <TreeView
              tree={tree}
              onPickClick={(strategy) => addStep('click', { selector: strategy })}
              onPickType={(strategy) => {
                const text = prompt('Type what?');
                if (text != null) addStep('type', { selector: strategy, text });
              }}
              onPickFill={(strategy) => {
                const value = prompt('Fill with?');
                if (value != null) addStep('fill', { selector: strategy, value });
              }}
              onPickWait={(strategy) => addStep('wait', { selector: strategy })}
              onPickScroll={(strategy) => addStep('scroll', { selector: strategy })}
            />
          )}
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

function SortableStep({
  step,
  idx,
  total,
  savingStep,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  step: ScenarioStep;
  idx: number;
  total: number;
  savingStep: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
  });
  let p: any = {};
  try { p = JSON.parse(step.payload_json); } catch {}
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li ref={setNodeRef} style={style}>
      <button
        className="step-drag"
        title="Drag to reorder"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="step-body">
        <code>{step.kind}</code> {summarizeStep(step.kind, p)}
      </span>
      <button className="step-move" title="Move up" onClick={onMoveUp} disabled={savingStep || idx === 0}>
        ▲
      </button>
      <button
        className="step-move"
        title="Move down"
        onClick={onMoveDown}
        disabled={savingStep || idx === total - 1}
      >
        ▼
      </button>
      <button className="step-del" title="Delete step" onClick={onDelete} disabled={savingStep}>
        ×
      </button>
    </li>
  );
}

function clampInt(v: string): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function summarizeStep(kind: string, p: any): string {
  if (kind === 'navigate') return `→ ${p.url ?? ''}`;
  if (kind === 'click' || kind === 'type' || kind === 'fill') {
    const s = p.selector ?? {};
    const txt = p.text ?? p.value ?? '';
    return `${s.role ?? ''} "${s.name ?? ''}"${txt ? ` ${JSON.stringify(txt)}` : ''}`;
  }
  if (kind === 'screenshot')
    return `${p.label ?? 'screenshot'}${p.fullPage ? ' (full)' : ''}${p.viewport === 'mobile' ? ' (mobile)' : ''}${p.annotate ? ' (annotated)' : ''}`;
  if (kind === 'scroll') {
    if (p.selector) return `into view: ${p.selector.role ?? ''} "${p.selector.name ?? ''}"`;
    if (p.toBottom) return 'to bottom (lazy-load)';
    if (p.toTop) return 'to top';
    const dy = Number(p.dy ?? 0);
    if (dy) return `${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`;
    return '';
  }
  if (kind === 'wait') {
    if (p.selector) return `for ${p.selector.role} "${p.selector.name}"`;
    return `${p.ms ?? 0}ms`;
  }
  if (kind === 'record_start') return '⏺ start video recording';
  if (kind === 'record_stop') return '⏹ stop video recording';
  if (kind === 'close') return '✕ close browser session';
  return JSON.stringify(p);
}

function flatten(
  node: A11yNode,
  depth: number,
  ancestors: A11yNode[],
): { node: A11yNode; depth: number; ancestors: A11yNode[] }[] {
  const out: { node: A11yNode; depth: number; ancestors: A11yNode[] }[] = [];
  if (node.role !== 'root') out.push({ node, depth, ancestors });
  for (const child of node.children) {
    out.push(...flatten(child, depth + 1, [...ancestors, node]));
  }
  return out;
}

function buildStrategy(node: A11yNode, ancestors: A11yNode[], siblings: A11yNode[]): SelectorStrategy {
  const strategy: SelectorStrategy = { role: node.role, name: node.name };
  const sameRoleName = siblings.filter((s) => s.role === node.role && s.name === node.name);
  if (sameRoleName.length > 1) {
    strategy.ordinal = sameRoleName.indexOf(node);
  }
  const landmarkRoles = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form',
  ]);
  const path: { role: string; name: string }[] = [];
  for (const a of ancestors) {
    if (landmarkRoles.has(a.role) && a.name) path.push({ role: a.role, name: a.name });
  }
  if (path.length) strategy.ancestorPath = path;
  return strategy;
}

function TreeView({
  tree,
  onPickClick,
  onPickType,
  onPickFill,
  onPickWait,
  onPickScroll,
}: {
  tree: A11yTree;
  onPickClick: (s: SelectorStrategy) => void;
  onPickType: (s: SelectorStrategy) => void;
  onPickFill: (s: SelectorStrategy) => void;
  onPickWait: (s: SelectorStrategy) => void;
  onPickScroll: (s: SelectorStrategy) => void;
}) {
  const flat = useMemo(() => flatten(tree.root, 0, []), [tree]);
  const allNodes = useMemo(() => flat.map((x) => x.node), [flat]);

  return (
    <ul className="a11y-tree">
      {flat.map((entry, idx) => {
        const { node, depth, ancestors } = entry;
        const strategy = node.ref ? buildStrategy(node, ancestors, allNodes) : null;
        return (
          <li key={idx} style={{ paddingLeft: depth * 14 }}>
            <span className="role">{node.role}</span>
            {node.name && <span className="name">"{node.name}"</span>}
            {node.ref && <span className="ref">{node.ref}</span>}
            {strategy && (
              <span className="picker">
                <button onClick={() => onPickClick(strategy)}>click</button>
                <button onClick={() => onPickType(strategy)}>type</button>
                <button onClick={() => onPickFill(strategy)}>fill</button>
                <button onClick={() => onPickWait(strategy)}>wait</button>
                <button
                  onClick={() => onPickScroll(strategy)}
                  title="Scroll this element into view"
                >
                  scrollIntoView
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

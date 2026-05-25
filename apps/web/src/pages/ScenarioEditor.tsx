import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  type A11yNode,
  type A11yTree,
  type ScenarioDetail,
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
}

function emptyDraft(): MetaDraft {
  return { name: '', url: '', viewport_preset: 'desktop', brand: '', type: '' };
}

function draftFrom(d: ScenarioDetail): MetaDraft {
  return {
    name: d.name,
    url: d.url,
    viewport_preset: d.viewport_preset,
    brand: d.brand ?? '',
    type: d.type ?? '',
  };
}

function draftsEqual(a: MetaDraft, b: MetaDraft): boolean {
  return (
    a.name === b.name &&
    a.url === b.url &&
    a.viewport_preset === b.viewport_preset &&
    a.brand === b.brand &&
    a.type === b.type
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
  const [draft, setDraft] = useState<MetaDraft>(emptyDraft());
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaSavedAt, setMetaSavedAt] = useState<number | null>(null);
  const termRef = useRef<TerminalShellHandle | null>(null);

  useEffect(() => {
    api.sessionStatus(SESSION).then((s) => setSessionAlive(s.alive)).catch(() => undefined);
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

  async function takeSnapshot(useUrl: boolean) {
    if (!data) return;
    setErr(null);
    setSnapshotting(true);
    try {
      const res = await api.snapshot({
        url: useUrl ? data.url : undefined,
        session: SESSION,
        compact: true,
      });
      setTree(res.tree);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSnapshotting(false);
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

  async function playScenario() {
    setErr(null);
    setPlayStatus(null);
    if (!previewActive) setPreviewActive(true);
    if (!sessionAlive) {
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

      <div className="editor-grid">
        <div>
          <h2>Steps</h2>
          {data.steps.length === 0 ? (
            <p className="muted">
              No steps yet. Take a snapshot, then click any node to add a step.
            </p>
          ) : (
            <ol className="step-list">
              {data.steps.map((s, idx) => {
                let p: any = {};
                try { p = JSON.parse(s.payload_json); } catch {}
                return (
                  <li key={s.id}>
                    <span className="step-body">
                      <code>{s.kind}</code> {summarizeStep(s.kind, p)}
                    </span>
                    <button
                      className="step-move"
                      title="Move up"
                      onClick={() => moveStep(s.id, 'up')}
                      disabled={savingStep || idx === 0}
                    >
                      ▲
                    </button>
                    <button
                      className="step-move"
                      title="Move down"
                      onClick={() => moveStep(s.id, 'down')}
                      disabled={savingStep || idx === data.steps.length - 1}
                    >
                      ▼
                    </button>
                    <button
                      className="step-del"
                      title="Delete step"
                      onClick={() => deleteStep(s.id)}
                      disabled={savingStep}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ol>
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
            <button onClick={runNow} disabled={data.steps.length === 0}>
              ▶ Run now
            </button>
          </div>
        </div>

        <div>
          <h2>
            Preview{' '}
            <button onClick={() => setPreviewActive((v) => !v)}>
              {previewActive ? 'stop' : 'start'}
            </button>{' '}
            <button onClick={playScenario} disabled={data.steps.length === 0}>
              ▶ Play scenario
            </button>
            {playStatus && <span className="muted" style={{ marginLeft: 8 }}>{playStatus}</span>}
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

function summarizeStep(kind: string, p: any): string {
  if (kind === 'navigate') return `→ ${p.url ?? ''}`;
  if (kind === 'click' || kind === 'type' || kind === 'fill') {
    const s = p.selector ?? {};
    const txt = p.text ?? p.value ?? '';
    return `${s.role ?? ''} "${s.name ?? ''}"${txt ? ` ${JSON.stringify(txt)}` : ''}`;
  }
  if (kind === 'screenshot') return `${p.label ?? 'screenshot'}${p.fullPage ? ' (full)' : ''}`;
  if (kind === 'scroll') {
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
}: {
  tree: A11yTree;
  onPickClick: (s: SelectorStrategy) => void;
  onPickType: (s: SelectorStrategy) => void;
  onPickFill: (s: SelectorStrategy) => void;
  onPickWait: (s: SelectorStrategy) => void;
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
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

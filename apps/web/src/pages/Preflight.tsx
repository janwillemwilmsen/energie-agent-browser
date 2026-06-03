import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type A11yTree,
  type AuthProfile,
  type Preflight,
  type PreflightStep,
  type SelectorStrategy,
} from '../lib/api.js';
import { PreviewStream } from '../lib/screencast.js';
import { SnapshotPicker } from '../lib/SnapshotPicker.js';

// The /preflight page works against the same `default` daemon scenarios use,
// bound to whichever preflight's --session-name the user is editing. Binding
// is implicit: opening a preflight or taking the first action on a new one
// switches the daemon onto that name and loads its saved state. Matches
// PREFLIGHT_RECORDER_SESSION on the server.
const RECORDER_SESSION = 'default';

interface Draft {
  id: number | null;
  name: string;
  description: string;
  steps: PreflightStep[];
}

function emptyDraft(): Draft {
  return { id: null, name: '', description: '', steps: [] };
}

function summarize(step: PreflightStep): string {
  if (step.kind === 'navigate') return `→ ${step.url}`;
  if (step.kind === 'wait') return `${step.ms}ms`;
  if (step.kind === 'click') return `${step.selector.role} "${step.selector.name}"`;
  if (step.kind === 'type')
    return `${step.selector.role} "${step.selector.name}" ${JSON.stringify(step.text)}`;
  if (step.kind === 'auth-login') return `🔐 auth profile "${step.name}"`;
  return '';
}

export function PreflightPage() {
  const [preflights, setPreflights] = useState<Preflight[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [previewActive, setPreviewActive] = useState(true);
  // What the live daemon is currently bound to (client-side mirror; the
  // authoritative copy is the .session-name marker on disk). null = unknown
  // or unbound. We set this every time we successfully bind, so the UI can
  // show a hint like "Browser: bound to acme-login".
  const [boundTo, setBoundTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // shorthand for an in-flight action
  const [tree, setTree] = useState<A11yTree | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [showAuthForm, setShowAuthForm] = useState(false);

  async function reloadAuthProfiles() {
    try {
      setAuthProfiles(await api.listAuthProfiles());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function reload() {
    try {
      setPreflights(await api.listPreflights());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    reload();
    reloadAuthProfiles();
  }, []);

  const draftDirty = useMemo(() => {
    if (draft.id == null) return draft.name.trim().length > 0 || draft.steps.length > 0;
    const orig = preflights.find((p) => p.id === draft.id);
    if (!orig) return true;
    let origSteps: PreflightStep[] = [];
    try { origSteps = JSON.parse(orig.steps_json); } catch { /* ignore */ }
    return (
      orig.name !== draft.name ||
      orig.description !== draft.description ||
      JSON.stringify(origSteps) !== JSON.stringify(draft.steps)
    );
  }, [draft, preflights]);

  const nameIsTakenLocally = useMemo(() => {
    const n = draft.name.trim();
    if (!n) return false;
    return preflights.some((p) => p.name === n && p.id !== draft.id);
  }, [draft.name, draft.id, preflights]);

  // Make sure the daemon is bound to the draft's --session-name before doing
  // anything that should land in this preflight's slot (exec step, save, etc.).
  // Server-side: a no-op when the daemon is already bound to the same name.
  async function bindDaemonToDraft(): Promise<boolean> {
    const name = draft.name.trim();
    if (!name) {
      setError('Give the preflight a name first.');
      return false;
    }
    if (nameIsTakenLocally && draft.id == null) {
      setError(`A preflight named "${name}" already exists. Pick a different name or open the existing one.`);
      return false;
    }
    if (boundTo === name) return true;
    try {
      setBusy('Binding browser…');
      const r = await api.startPreflightRecorder(name);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      setBoundTo(name);
      return true;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function startNew() {
    setDraft(emptyDraft());
    setTree(null);
    setError(null);
    setShowSaved(false);
  }

  // Opening an existing preflight implies "I want to work with this one" —
  // immediately bind the daemon and load its state so the preview reflects
  // it and any next action lands in the right slot.
  async function loadPreflight(p: Preflight) {
    setError(null);
    setShowSaved(false);
    let steps: PreflightStep[] = [];
    try { steps = JSON.parse(p.steps_json); } catch { /* ignore */ }
    setDraft({ id: p.id, name: p.name, description: p.description, steps });
    setTree(null);
    try {
      setBusy('Loading browser state…');
      const r = await api.startPreflightRecorder(p.name);
      if (!r.ok) setError(r.error);
      else setBoundTo(p.name);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (saving) return;
    const name = draft.name.trim();
    if (!name) {
      setError('Name is required.');
      return;
    }
    // Make sure the daemon is bound to THIS preflight before we save, so the
    // server-side state-save side-effect lands in the right slot.
    if (!(await bindDaemonToDraft())) return;
    setSaving(true);
    setError(null);
    try {
      const saved =
        draft.id == null
          ? await api.createPreflight({
              name,
              description: draft.description,
              steps: draft.steps,
            })
          : await api.updatePreflight(draft.id, {
              name,
              description: draft.description,
              steps: draft.steps,
            });
      setDraft({
        id: saved.id,
        name: saved.name,
        description: saved.description,
        steps: draft.steps,
      });
      setBoundTo(saved.name);
      setShowSaved(true);
      window.setTimeout(() => setShowSaved(false), 3000);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deletePreflight() {
    if (draft.id == null) return;
    if (!confirm(`Soft-delete preflight "${draft.name}"? You can still find its auth.json under ~/.agent-browser/sessions/.`)) return;
    setError(null);
    try {
      await api.deletePreflight(draft.id);
      setDraft(emptyDraft());
      await reload();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function addStep(step: PreflightStep) {
    // Auto-bind before executing — this is what replaces the old Start
    // recording button.
    if (!(await bindDaemonToDraft())) return;
    setError(null);
    setDraft((d) => ({ ...d, steps: [...d.steps, step] }));
    setBusy(`Running ${step.kind}…`);
    try {
      const r = await api.execPreflightStep(step);
      if (!r.ok) setError(`Step failed: ${r.error}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  function removeStep(idx: number) {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== idx) }));
  }

  async function takeSnapshot() {
    setError(null);
    setSnapshotting(true);
    try {
      const res = await api.snapshot({ session: RECORDER_SESSION, compact: true });
      setTree(res.tree);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSnapshotting(false);
    }
  }

  async function replay() {
    if (draft.id == null) {
      setError('Save the preflight first, then replay.');
      return;
    }
    setError(null);
    setReplaying(true);
    if (!previewActive) setPreviewActive(true);
    try {
      const r = await api.replayPreflight(draft.id);
      if (!r.ok) setError(`Replay failed: ${r.error}`);
      else setBoundTo(draft.name.trim());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setReplaying(false);
    }
  }

  function onPickClick(sel: SelectorStrategy) {
    void addStep({ kind: 'click', selector: sel });
  }
  function onPickType(sel: SelectorStrategy) {
    const text = prompt('Type what?');
    if (text == null) return;
    void addStep({ kind: 'type', selector: sel, text });
  }

  const haveName = draft.name.trim().length > 0;
  const stepActionDisabled = !haveName || (nameIsTakenLocally && draft.id == null);

  return (
    <section>
      <h1>Preflights</h1>
      <p className="muted">
        Record a one-time login or cookie-consent flow once. Opening a preflight (or
        taking the first action on a new one) binds the <code>default</code> browser
        to that preflight's <code>--session-name</code> and loads its saved auth state.
        Any scenario that selects this preflight will use that same state on every run.
      </p>

      <div className="session-bar">
        <button onClick={startNew}>+ New preflight</button>
        {preflights.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip ${p.id === draft.id ? 'chip-on' : ''}`}
            onClick={() => loadPreflight(p)}
            title={p.description || undefined}
          >
            {p.name}
          </button>
        ))}
        {preflights.length === 0 && (
          <span className="muted">No saved preflights yet.</span>
        )}
      </div>

      <div className="scenario-meta-form" style={{ maxWidth: 'none' }}>
        <div className="scenario-meta-row">
          <label className="scenario-meta-name">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. acme-login"
              pattern="[A-Za-z0-9._-]+"
              title="letters, digits, dot, dash, underscore"
              required
            />
          </label>
          <label style={{ flex: 2 }}>
            <span>Description</span>
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="What state does this preflight set up?"
            />
          </label>
        </div>
        {nameIsTakenLocally && draft.id == null && (
          <p className="error" style={{ margin: 0 }}>
            A preflight named "{draft.name.trim()}" already exists. Pick a different name
            or open the existing one.
          </p>
        )}
        <div className="scenario-meta-actions">
          <button
            type="button"
            onClick={save}
            disabled={saving || !draft.name.trim() || !draftDirty || (nameIsTakenLocally && draft.id == null)}
            title={
              !draft.name.trim() ? 'Set a name first' :
              !draftDirty ? 'No unsaved changes' :
              draft.id == null ? 'Save this new preflight' : 'Save changes (also captures current browser state)'
            }
          >
            {saving ? 'Saving…' : draft.id == null ? '💾 Save preflight' : '💾 Save changes'}
          </button>
          {showSaved && (
            <span style={{ color: '#4ade80', fontWeight: 600 }}>✓ Saved</span>
          )}
          {draft.id != null && (
            <button
              type="button"
              onClick={replay}
              disabled={replaying || draft.steps.length === 0}
              title="Wipes the saved auth.json under ~/.agent-browser/sessions/<name>, restarts the browser fresh, and re-runs every step from scratch. The fresh login overwrites the wiped state."
            >
              {replaying ? 'Replaying…' : '↻▶ Replay (clean)'}
            </button>
          )}
          {draft.id != null && (
            <button
              type="button"
              className="btn-danger"
              onClick={deletePreflight}
              disabled={saving}
              title="Soft-delete: removes the preflight from the list and from scenario dropdowns. The on-disk auth.json is left in place."
            >
              Delete
            </button>
          )}
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            Browser:{' '}
            {boundTo
              ? <>bound to <code>{boundTo}</code></>
              : <em>not yet bound</em>}
            {busy && <> · {busy}</>}
          </span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <AuthProfilesPanel
        profiles={authProfiles}
        open={showAuthForm}
        onToggleOpen={() => setShowAuthForm((v) => !v)}
        onCreated={async () => {
          await reloadAuthProfiles();
        }}
        onDeleted={async () => {
          await reloadAuthProfiles();
        }}
        onError={setError}
      />

      <div className="editor-grid">
        <div>
          <h2>Steps</h2>
          {draft.steps.length === 0 ? (
            <p className="muted">
              No steps yet. Add a navigate step, then snapshot the page and pick nodes
              to click or type into. Every action runs live against the browser bound
              to <code>{draft.name || '<name>'}</code>, so cookies and localStorage
              accumulate as you go.
            </p>
          ) : (
            <ol className="step-list">
              {draft.steps.map((s, idx) => (
                <li key={idx}>
                  <span className="step-body">
                    <code>{s.kind}</code> {summarize(s)}
                  </span>
                  <button
                    className="step-del"
                    title="Remove step"
                    onClick={() => removeStep(idx)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          )}

          <div className="actions">
            <button
              onClick={() => {
                const url = prompt('Navigate to URL?');
                if (url) void addStep({ kind: 'navigate', url });
              }}
              disabled={stepActionDisabled}
              title={stepActionDisabled ? 'Set a name first' : undefined}
            >
              + navigate
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
                void addStep({ kind: 'wait', ms: Math.floor(ms) });
              }}
              disabled={stepActionDisabled}
              title={stepActionDisabled ? 'Set a name first' : undefined}
            >
              + wait (ms)
            </button>
            {/* Auth login step: replaces the manual click-email/type/click-pw/
                type/click-submit sequence with a single encrypted-credential
                step. If no profiles exist yet, the button opens the create
                form; otherwise it picks from the saved profiles. */}
            <button
              onClick={() => {
                if (authProfiles.length === 0) {
                  setShowAuthForm(true);
                  return;
                }
                const choice = prompt(
                  'Which auth profile? Available: ' +
                    authProfiles.map((p) => p.name).join(', ') +
                    '\n\n(type one of the names above, or leave blank to manage profiles)',
                );
                if (choice == null) return;
                const trimmed = choice.trim();
                if (!trimmed) {
                  setShowAuthForm(true);
                  return;
                }
                const exists = authProfiles.some((p) => p.name === trimmed);
                if (!exists) {
                  setError(`No auth profile named "${trimmed}". Manage profiles below.`);
                  setShowAuthForm(true);
                  return;
                }
                void addStep({ kind: 'auth-login', name: trimmed });
              }}
              disabled={stepActionDisabled}
              title={stepActionDisabled ? 'Set a name first' : 'Single-step encrypted login using a saved auth profile'}
            >
              + auth login
            </button>
          </div>

          <h3 style={{ marginTop: 24 }}>Snapshot &amp; pick</h3>
          <p className="muted">
            Snapshot the current page state, then click <em>click</em> or <em>type</em> on
            a node to add that step. Picking sends the action live against the browser;
            cookies land in <code>{draft.name || '<name>'}</code> automatically.
          </p>
          <div className="actions">
            <button onClick={takeSnapshot} disabled={snapshotting}>
              {snapshotting ? 'Snapshotting…' : 'Snapshot current page'}
            </button>
          </div>
          {tree && (
            <SnapshotPicker
              tree={tree}
              onPickClick={onPickClick}
              onPickType={onPickType}
            />
          )}
        </div>

        <div>
          <h2>
            Preview{' '}
            <button onClick={() => setPreviewActive((v) => !v)}>
              {previewActive ? 'stop' : 'start'}
            </button>
          </h2>
          <PreviewStream session={RECORDER_SESSION} active={previewActive} />
        </div>
      </div>
    </section>
  );
}

// Manages agent-browser's Auth Vault from inside the preflight page. The
// vault stores credentials (encrypted at rest in ~/.agent-browser/auth/) so
// preflight steps can reference them by name instead of embedding plaintext
// passwords in their steps_json. The form intentionally keeps the password
// out of any state that React might keep around longer than necessary —
// we wipe it after a successful save.
function AuthProfilesPanel({
  profiles,
  open,
  onToggleOpen,
  onCreated,
  onDeleted,
  onError,
}: {
  profiles: AuthProfile[];
  open: boolean;
  onToggleOpen: () => void;
  onCreated: () => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameSelector, setUsernameSelector] = useState('');
  const [passwordSelector, setPasswordSelector] = useState('');
  const [submitSelector, setSubmitSelector] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setName('');
    setUrl('https://');
    setUsername('');
    setPassword('');
    setUsernameSelector('');
    setPasswordSelector('');
    setSubmitSelector('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim() || !url.trim() || !username.trim() || !password) {
      onError('Name, URL, username, and password are required.');
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await api.saveAuthProfile({
        name: name.trim(),
        url: url.trim(),
        username: username.trim(),
        password,
        usernameSelector: usernameSelector.trim() || undefined,
        passwordSelector: passwordSelector.trim() || undefined,
        submitSelector: submitSelector.trim() || undefined,
      });
      reset();
      await onCreated();
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function del(profileName: string) {
    if (!confirm(`Delete auth profile "${profileName}"? Any preflight step that references it will fail until you re-create or change the step.`)) return;
    onError(null);
    try {
      await api.deleteAuthProfile(profileName);
      await onDeleted();
    } catch (e: any) {
      onError(e?.message ?? String(e));
    }
  }

  return (
    <details
      className="filter-panel"
      open={open}
      onToggle={(e) => {
        // Sync state when the user clicks the summary themselves.
        if ((e.target as HTMLDetailsElement).open !== open) onToggleOpen();
      }}
      style={{ marginTop: 16 }}
    >
      <summary>
        Auth profiles{' '}
        {profiles.length > 0 && (
          <span className="filter-count">{profiles.length} saved</span>
        )}
      </summary>
      <div className="filter-body">
        <p className="muted" style={{ margin: 0 }}>
          Stored encrypted at rest under <code>~/.agent-browser/auth/&lt;name&gt;.json</code>{' '}
          (AES-GCM, key in <code>~/.agent-browser/.encryption-key</code>). Reference a
          profile from a preflight step with <code>+ auth login</code> instead of embedding
          credentials in steps.
        </p>
        {profiles.length > 0 && (
          <table className="table" style={{ marginTop: 0 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Username</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.name}>
                  <td><code>{p.name}</code></td>
                  <td style={{ wordBreak: 'break-all' }}>{p.url}</td>
                  <td>{p.username}</td>
                  <td>
                    <button
                      className="btn-danger"
                      onClick={() => del(p.name)}
                      style={{ padding: '4px 10px', fontSize: 12 }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={submit} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Add new profile</strong>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
            <input
              placeholder="name (e.g. essent)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[A-Za-z0-9._-]+"
              title="letters, digits, dot, dash, underscore"
              required
            />
            <input
              placeholder="login URL (e.g. https://mijn.essent.nl)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <input
              placeholder="username / email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <input
              placeholder="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>
              Optional CSS selectors (use when agent-browser's defaults can't find the fields)
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
              <input
                placeholder='--username-selector (e.g. input[name="email"])'
                value={usernameSelector}
                onChange={(e) => setUsernameSelector(e.target.value)}
              />
              <input
                placeholder='--password-selector (e.g. input[name="password"])'
                value={passwordSelector}
                onChange={(e) => setPasswordSelector(e.target.value)}
              />
              <input
                placeholder='--submit-selector (e.g. button[type="submit"])'
                value={submitSelector}
                onChange={(e) => setSubmitSelector(e.target.value)}
              />
            </div>
          </details>
          <button type="submit" disabled={busy} style={{ alignSelf: 'flex-start' }}>
            {busy ? 'Saving…' : '💾 Save profile'}
          </button>
        </form>
      </div>
    </details>
  );
}

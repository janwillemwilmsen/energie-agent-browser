import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Preflight, type Scenario, type ScenarioDetail, type ScenarioStep } from '../lib/api.js';
import { makeBundle, toPortableScenario } from '../lib/scenarioIO.js';

// Raw scenario-steps inspector/editor for the Admin section. Unlike the visual
// ScenarioEditor (which builds steps via snapshot picking), this exposes the
// underlying rows directly: position, kind, and the raw payload_json — and lets
// an operator edit them by hand. Useful for fixing a malformed selector,
// tweaking a payload field the UI doesn't surface, or just understanding what a
// scenario actually stores.

// Mirrors the DB CHECK constraint on scenario_steps.kind. Editing a step to any
// other value would be rejected by the server, so we constrain the picker.
const STEP_KINDS = [
  'navigate',
  'click',
  'type',
  'fill',
  'scroll',
  'screenshot',
  'wait',
  'evaluate',
] as const;

interface EditRow {
  id: number;
  position: string; // kept as string for the number input
  kind: string;
  payload: string; // pretty-printed JSON the user edits
  dirty: boolean;
  saving: boolean;
  msg: string | null;
  error: string | null;
}

// Pretty-print stored payload_json. Falls back to the raw text if it isn't
// valid JSON (so a corrupt row is still visible and fixable rather than hidden).
function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function toRow(step: ScenarioStep): EditRow {
  return {
    id: step.id,
    position: String(step.position),
    kind: step.kind,
    payload: prettyPayload(step.payload_json),
    dirty: false,
    saving: false,
    msg: null,
    error: null,
  };
}

export function AdminScenarioSteps() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [preflights, setPreflights] = useState<Preflight[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .listScenarios()
      .then(setScenarios)
      .catch((e) => setErr(e?.message ?? String(e)));
    // Preflights resolve the scenario's preflight_id → name for the portable export.
    api
      .listPreflights()
      .then(setPreflights)
      .catch(() => undefined);
  }, []);

  async function loadScenario(id: number) {
    setSelectedId(id);
    setErr(null);
    setLoading(true);
    setDetail(null);
    try {
      const d = await api.getScenario(id);
      setDetail(d);
      setRows(d.steps.map(toRow));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  function patchRow(id: number, patch: Partial<EditRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveRow(row: EditRow) {
    // Validate the payload JSON client-side so we give a precise error instead
    // of a generic 400 from the server.
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch (e: any) {
      patchRow(row.id, { error: `Invalid JSON: ${e?.message ?? e}`, msg: null });
      return;
    }
    const position = Number(row.position);
    if (!Number.isInteger(position) || position < 0) {
      patchRow(row.id, { error: 'Position must be a non-negative integer.', msg: null });
      return;
    }
    if (selectedId == null) return;
    patchRow(row.id, { saving: true, error: null, msg: null });
    try {
      const updated = await api.updateStep(selectedId, row.id, {
        position,
        kind: row.kind,
        payload,
      });
      // Reflect the server's canonical version back into the row.
      setRows((rs) =>
        rs.map((r) =>
          r.id === row.id
            ? { ...toRow(updated), msg: 'Saved' }
            : r,
        ),
      );
    } catch (e: any) {
      patchRow(row.id, { saving: false, error: e?.message ?? String(e) });
    }
  }

  async function deleteRow(row: EditRow) {
    if (selectedId == null) return;
    if (!confirm(`Delete step #${row.id} (${row.kind}) from this scenario?`)) return;
    try {
      await api.deleteStep(selectedId, row.id);
      setRows((rs) => rs.filter((r) => r.id !== row.id));
    } catch (e: any) {
      patchRow(row.id, { error: e?.message ?? String(e) });
    }
  }

  async function addStep() {
    if (selectedId == null) return;
    setAdding(true);
    setErr(null);
    try {
      const nextPos = rows.reduce((m, r) => Math.max(m, Number(r.position) || 0), -1) + 1;
      // A neutral default; the operator edits it immediately.
      const created = await api.addStep(selectedId, {
        position: nextPos,
        kind: 'wait',
        payload: { ms: 1000 },
      });
      setRows((rs) => [...rs, toRow(created)]);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setAdding(false);
    }
  }

  // Portable export of the current scenario — no ids/timestamps, preflight by
  // name, payloads decoded — ready to paste into Export / import on another
  // instance. (The raw detail dump can't be imported directly; this can.)
  const portableJson = useMemo(() => {
    if (!detail) return '';
    const nameById = new Map(preflights.map((p) => [p.id, p.name] as const));
    return JSON.stringify(makeBundle([toPortableScenario(detail, nameById)]), null, 2);
  }, [detail, preflights]);

  async function copyPortable() {
    try {
      await navigator.clipboard.writeText(portableJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr('Clipboard copy failed — select the text and copy manually.');
    }
  }

  return (
    <section>
      <p>
        <Link to="/admin">← Admin</Link>
      </p>
      <h1>Raw scenario steps</h1>
      <p className="muted">
        Inspect and hand-edit the underlying step rows — position, kind, and the raw{' '}
        <code>payload_json</code>. Changes save straight to the database. There is no
        validation beyond well-formed JSON and a valid step kind, so edit with care.
      </p>

      <label className="admin-scenario-pick">
        <span>Scenario</span>
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v) void loadScenario(Number(v));
          }}
        >
          <option value="" disabled>
            Select a scenario…
          </option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              #{s.id} — {s.name}
            </option>
          ))}
        </select>
      </label>

      {err && <p className="error">{err}</p>}
      {loading && <p className="muted">Loading…</p>}

      {detail && (
        <>
          <p className="muted" style={{ marginBottom: 4 }}>
            <strong>{detail.name}</strong> · <code>{detail.url}</code> ·{' '}
            <Link to={`/scenarios/${detail.id}`}>open in visual editor</Link>
          </p>

          {rows.length === 0 ? (
            <p className="muted">This scenario has no steps yet.</p>
          ) : (
            <ol className="raw-step-list">
              {rows.map((row) => (
                <li key={row.id} className="raw-step">
                  <div className="raw-step-head">
                    <span className="raw-step-id">step #{row.id}</span>
                    <label>
                      <span className="muted">pos</span>
                      <input
                        type="number"
                        min={0}
                        className="raw-step-pos"
                        value={row.position}
                        onChange={(e) =>
                          patchRow(row.id, { position: e.target.value, dirty: true, msg: null })
                        }
                      />
                    </label>
                    <label>
                      <span className="muted">kind</span>
                      <select
                        value={row.kind}
                        onChange={(e) =>
                          patchRow(row.id, { kind: e.target.value, dirty: true, msg: null })
                        }
                      >
                        {STEP_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                        {/* Surface an unexpected stored kind so it's visible/saveable. */}
                        {!STEP_KINDS.includes(row.kind as (typeof STEP_KINDS)[number]) && (
                          <option value={row.kind}>{row.kind} (unknown)</option>
                        )}
                      </select>
                    </label>
                    <span className="raw-step-actions">
                      <button
                        onClick={() => void saveRow(row)}
                        disabled={row.saving || !row.dirty}
                        title={!row.dirty ? 'No changes' : 'Save this step'}
                      >
                        {row.saving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => void deleteRow(row)}
                        disabled={row.saving}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                  <textarea
                    className="raw-step-payload"
                    spellCheck={false}
                    value={row.payload}
                    onChange={(e) =>
                      patchRow(row.id, { payload: e.target.value, dirty: true, msg: null })
                    }
                    rows={Math.min(16, Math.max(3, row.payload.split('\n').length))}
                  />
                  {row.error && <p className="error raw-step-msg">{row.error}</p>}
                  {row.msg && <p className="raw-step-msg saved">{row.msg}</p>}
                </li>
              ))}
            </ol>
          )}

          <div className="actions">
            <button onClick={() => void addStep()} disabled={adding}>
              {adding ? 'Adding…' : '+ Add raw step'}
            </button>
          </div>

          <details className="filter-panel" style={{ marginTop: 16 }}>
            <summary>Portable JSON (copy to migrate this scenario)</summary>
            <div className="filter-body">
              <p className="muted" style={{ marginTop: 0 }}>
                Environment-independent — no database ids or timestamps, preflight referenced by
                name. Paste it into <Link to="/admin/scenarios-io">Export / import scenarios</Link>{' '}
                on another instance to recreate it. To export many at once, use that page directly.
              </p>
              <div className="actions" style={{ marginBottom: 6 }}>
                <button onClick={() => void copyPortable()}>
                  {copied ? '✓ Copied' : 'Copy to clipboard'}
                </button>
              </div>
              <pre className="raw-json">{portableJson}</pre>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

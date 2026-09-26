import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Preflight } from '../lib/api.js';
import {
  importPortablePreflight,
  makePreflightBundle,
  parsePortablePreflights,
  toPortablePreflight,
  type PreflightImportResult,
} from '../lib/preflightIO.js';
import { useResource } from '../lib/resource.js';

// Admin → Export / import preflights. Sibling of AdminScenarioIO: produces a
// portable JSON bundle that can be pasted into another instance's Import box.
// Import preflights BEFORE scenarios on the target — scenario import resolves
// its preflight by name and drops the link when the name isn't found.

export function AdminPreflightIO() {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exportText, setExportText] = useState('');
  const [copied, setCopied] = useState(false);

  const [importText, setImportText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<PreflightImportResult[]>([]);
  const [importErr, setImportErr] = useState<string | null>(null);

  const {
    data: preflights,
    error: err,
    setError: setErr,
    refresh: reloadList,
  } = useResource(() => api.listPreflights(), { initial: [] as Preflight[] });

  function toggle(id: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(preflights.map((p) => p.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  function buildExport() {
    setErr(null);
    setCopied(false);
    // listPreflights already includes steps_json — no per-row fetch needed.
    const chosen = preflights.filter((p) => selected.has(p.id));
    if (chosen.length === 0) {
      setErr('Select at least one preflight to export.');
      return;
    }
    const bundle = makePreflightBundle(chosen.map(toPortablePreflight));
    setExportText(JSON.stringify(bundle, null, 2));
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr('Clipboard copy failed — select the text and copy manually.');
    }
  }

  async function runImport() {
    setImportErr(null);
    setResults([]);
    let parsed;
    try {
      parsed = parsePortablePreflights(importText);
    } catch (e: any) {
      setImportErr(e?.message ?? String(e));
      return;
    }
    if (parsed.length === 0) {
      setImportErr('Nothing to import.');
      return;
    }
    setImporting(true);
    const out: PreflightImportResult[] = [];
    try {
      // Re-read the local preflights so the name clash check uses current data.
      const active = await api.listPreflights();
      for (const p of parsed) {
        try {
          out.push(await importPortablePreflight(p, active, { overwrite }));
        } catch (e: any) {
          setImportErr(`Failed on "${p.name}": ${e?.message ?? e}`);
          break;
        }
      }
    } finally {
      setResults(out);
      setImporting(false);
      await reloadList();
    }
  }

  const stepCount = (p: Preflight) => {
    try {
      const v = JSON.parse(p.steps_json);
      return Array.isArray(v) ? v.length : 0;
    } catch {
      return 0;
    }
  };

  return (
    <section>
      <p className="breadcrumb">
        <Link to="/admin">← Admin</Link>
      </p>
      <h1>Export / import preflights</h1>
      <p className="muted">
        Copy preflights between instances (e.g. dev → production) without touching the
        database directly. Export produces a portable JSON bundle — name, description, steps
        and retry policy; no database ids or timestamps — and Import recreates each preflight
        through the API on this instance. Import preflights <strong>before</strong> the
        scenarios that use them, so <Link to="/admin/scenarios-io">scenario import</Link> can
        resolve them by name.
      </p>
      <p className="muted">
        The captured browser state (cookies / localStorage) is <strong>not</strong> part of the
        export: it is environment-specific and may contain live session tokens. Open the
        imported preflight on <Link to="/preflight">Preflights</Link> and use Replay to build
        it on the target.
      </p>

      {err && <p className="error">{err}</p>}

      <div className="editor-grid">
        {/* ---- Export ---- */}
        <div>
          <h2>Export</h2>
          <div className="actions" style={{ marginBottom: 8 }}>
            <button onClick={selectAll} disabled={preflights.length === 0}>
              Select all
            </button>
            <button onClick={selectNone} disabled={selected.size === 0}>
              Clear
            </button>
            <button onClick={buildExport} disabled={selected.size === 0}>
              Export {selected.size || ''} selected
            </button>
          </div>
          <div className="io-scenario-list">
            {preflights.map((p) => (
              <label key={p.id} className="io-scenario-row">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                />
                <span>
                  <code>#{p.id}</code> {p.name}
                  <span className="muted">
                    {' '}
                    · {stepCount(p)} step{stepCount(p) === 1 ? '' : 's'}
                  </span>
                </span>
              </label>
            ))}
            {preflights.length === 0 && <p className="muted">No preflights.</p>}
          </div>

          {exportText && (
            <>
              <div className="actions" style={{ margin: '12px 0 6px' }}>
                <button onClick={() => void copyExport()}>
                  {copied ? '✓ Copied' : 'Copy to clipboard'}
                </button>
                <span className="muted">Paste this into the Import box on the target instance.</span>
              </div>
              <textarea
                className="raw-step-payload io-textarea"
                spellCheck={false}
                value={exportText}
                onChange={(e) => setExportText(e.target.value)}
                rows={18}
              />
            </>
          )}
        </div>

        {/* ---- Import ---- */}
        <div>
          <h2>Import</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Paste an exported bundle (or a bare array / single preflight). Preflight names are
            unique per instance: a name that already exists here is <strong>skipped</strong>{' '}
            unless you tick overwrite, in which case its steps, description and retry policy
            are replaced (the saved browser state is left alone).
          </p>
          <textarea
            className="raw-step-payload io-textarea"
            spellCheck={false}
            placeholder='{ "_type": "eab.preflights", "version": 1, "preflights": [ … ] }'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={14}
          />
          <div className="actions" style={{ marginTop: 8 }}>
            <button onClick={() => void runImport()} disabled={importing || !importText.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </button>
            <label className="io-scenario-row">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Overwrite preflights that already exist here (same name)
            </label>
          </div>

          {importErr && <p className="error">{importErr}</p>}
          {results.length > 0 && (
            <div className="io-results">
              <p className="raw-step-msg saved">
                Processed {results.length} preflight{results.length === 1 ? '' : 's'}:
              </p>
              <ul>
                {results.map((r) => (
                  <li key={r.name}>
                    {r.preflightId != null && <code>#{r.preflightId}</code>} {r.name} ·{' '}
                    {r.action === 'skipped' ? (
                      <span className="muted">skipped — already exists</span>
                    ) : (
                      <>
                        {r.action} · {r.steps} step{r.steps === 1 ? '' : 's'}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

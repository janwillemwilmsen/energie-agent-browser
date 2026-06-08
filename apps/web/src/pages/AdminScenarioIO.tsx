import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Preflight, type Scenario } from '../lib/api.js';
import {
  importPortableScenario,
  makeBundle,
  parsePortable,
  toPortableScenario,
  type ImportResult,
} from '../lib/scenarioIO.js';

// Admin → Export / import scenarios. Produces a portable JSON bundle that can be
// pasted into another instance's Import box to recreate scenarios there (e.g.
// dev → prod) without touching the database directly.

export function AdminScenarioIO() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [preflights, setPreflights] = useState<Preflight[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exportText, setExportText] = useState('');
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [importErr, setImportErr] = useState<string | null>(null);

  async function reloadLists() {
    const [s, p] = await Promise.all([api.listScenarios(), api.listPreflights()]);
    setScenarios(s);
    setPreflights(p);
  }

  useEffect(() => {
    reloadLists().catch((e) => setErr(e?.message ?? String(e)));
  }, []);

  function toggle(id: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(scenarios.map((s) => s.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  async function buildExport() {
    setErr(null);
    setCopied(false);
    const ids = scenarios.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0) {
      setErr('Select at least one scenario to export.');
      return;
    }
    setExporting(true);
    try {
      const nameById = new Map(preflights.map((p) => [p.id, p.name] as const));
      // listScenarios has no steps — fetch each scenario's detail for them.
      const details = await Promise.all(ids.map((id) => api.getScenario(id)));
      const bundle = makeBundle(details.map((d) => toPortableScenario(d, nameById)));
      setExportText(JSON.stringify(bundle, null, 2));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setExporting(false);
    }
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
      parsed = parsePortable(importText);
    } catch (e: any) {
      setImportErr(e?.message ?? String(e));
      return;
    }
    if (parsed.length === 0) {
      setImportErr('Nothing to import.');
      return;
    }
    setImporting(true);
    const out: ImportResult[] = [];
    try {
      // Re-read the local preflights so name→id resolution uses current data.
      const activePreflights = await api.listPreflights();
      for (const s of parsed) {
        try {
          out.push(await importPortableScenario(s, activePreflights));
        } catch (e: any) {
          setImportErr(`Failed on "${s.name}": ${e?.message ?? e}`);
          break;
        }
      }
    } finally {
      setResults(out);
      setImporting(false);
      await reloadLists().catch(() => undefined);
    }
  }

  return (
    <section>
      <p>
        <Link to="/admin">← Admin</Link>
      </p>
      <h1>Export / import scenarios</h1>
      <p className="muted">
        Copy scenarios between instances (e.g. dev → production) without touching the
        database directly. Export produces a portable JSON bundle — no database ids or
        timestamps, preflights referenced by name — and Import recreates each scenario
        and its steps through the API on this instance.
      </p>

      {err && <p className="error">{err}</p>}

      <div className="editor-grid">
        {/* ---- Export ---- */}
        <div>
          <h2>Export</h2>
          <div className="actions" style={{ marginBottom: 8 }}>
            <button onClick={selectAll} disabled={scenarios.length === 0}>
              Select all
            </button>
            <button onClick={selectNone} disabled={selected.size === 0}>
              Clear
            </button>
            <button onClick={() => void buildExport()} disabled={exporting || selected.size === 0}>
              {exporting ? 'Building…' : `Export ${selected.size || ''} selected`}
            </button>
          </div>
          <div className="io-scenario-list">
            {scenarios.map((s) => (
              <label key={s.id} className="io-scenario-row">
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggle(s.id)}
                />
                <span>
                  <code>#{s.id}</code> {s.name}
                  {s.brand && <span className="tag tag-brand"> {s.brand}</span>}
                </span>
              </label>
            ))}
            {scenarios.length === 0 && <p className="muted">No scenarios.</p>}
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
            Paste an exported bundle (or a bare array / single scenario). Each scenario is
            created <strong>new</strong> here — import does not overwrite or de-duplicate, so
            running it twice makes two copies.
          </p>
          <textarea
            className="raw-step-payload io-textarea"
            spellCheck={false}
            placeholder='{ "_type": "eab.scenarios", "version": 1, "scenarios": [ … ] }'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={14}
          />
          <div className="actions" style={{ marginTop: 8 }}>
            <button onClick={() => void runImport()} disabled={importing || !importText.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>

          {importErr && <p className="error">{importErr}</p>}
          {results.length > 0 && (
            <div className="io-results">
              <p className="raw-step-msg saved">
                Imported {results.length} scenario{results.length === 1 ? '' : 's'}:
              </p>
              <ul>
                {results.map((r) => (
                  <li key={r.scenarioId}>
                    <Link to={`/scenarios/${r.scenarioId}`}>#{r.scenarioId}</Link> {r.name} ·{' '}
                    {r.steps} step{r.steps === 1 ? '' : 's'}
                    {r.warnings.map((w, i) => (
                      <span key={i} className="error" style={{ display: 'block', fontSize: 12 }}>
                        ⚠ {w}
                      </span>
                    ))}
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Run } from '../lib/api.js';

export function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  // Ordered, unbounded selection. Drives both bulk-delete and compare (which
  // requires exactly two, baseline = first picked). Order is preserved.
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Open a specific run's panel when arrived via /runs?run=<id> (e.g. from the
  // editor's play status). Applied once, so the 4s refresh won't fight clicks.
  const appliedRunParam = useRef(false);

  async function load() {
    try {
      setRuns(await api.listRuns());
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (appliedRunParam.current) return;
    const raw = searchParams.get('run');
    if (!raw) return;
    const r = runs.find((x) => x.id === Number(raw));
    if (r) {
      setSelected(r);
      appliedRunParam.current = true;
    }
  }, [runs, searchParams]);

  const brands = useMemo(() => collectTagValues(runs, 'brand'), [runs]);
  const types = useMemo(() => collectTagValues(runs, 'type'), [runs]);

  const visibleRuns = useMemo(() => {
    return runs.filter((r) => {
      const brandOk = selectedBrands.size === 0 || (r.brand != null && selectedBrands.has(r.brand));
      const typeOk = selectedTypes.size === 0 || (r.type != null && selectedTypes.has(r.type));
      return brandOk && typeOk;
    });
  }, [runs, selectedBrands, selectedTypes]);

  function toggle(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  const isSelected = (id: number) => selectedIds.includes(id);

  // Single toggle, or a shift-click range from the previously-clicked row
  // (over the currently visible/filtered rows).
  function toggleSelect(id: number, index: number, shift: boolean) {
    if (shift && lastIndex != null) {
      const [a, b] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
      const rangeIds = visibleRuns.slice(a, b + 1).map((r) => r.id);
      const selecting = !isSelected(id);
      let next = selectedIds.slice();
      if (selecting) {
        for (const rid of rangeIds) if (!next.includes(rid)) next.push(rid);
      } else {
        next = next.filter((x) => !rangeIds.includes(x));
      }
      setSelectedIds(next);
    } else {
      setSelectedIds(isSelected(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
    }
    setLastIndex(index);
  }

  const allVisibleSelected =
    visibleRuns.length > 0 && visibleRuns.every((r) => isSelected(r.id));
  const someVisibleSelected = visibleRuns.some((r) => isSelected(r.id));

  function toggleSelectAll() {
    if (allVisibleSelected) {
      const visible = new Set(visibleRuns.map((r) => r.id));
      setSelectedIds(selectedIds.filter((id) => !visible.has(id)));
    } else {
      const next = selectedIds.slice();
      for (const r of visibleRuns) if (!next.includes(r.id)) next.push(r.id);
      setSelectedIds(next);
    }
  }

  const selectedRows = selectedIds
    .map((id) => runs.find((r) => r.id === id))
    .filter((r): r is Run => !!r);
  const canCompare =
    selectedRows.length === 2 && selectedRows[0]!.scenario_id === selectedRows[1]!.scenario_id;

  async function runComparison() {
    if (!canCompare) return;
    setComparing(true);
    setErr(null);
    try {
      // First picked run is the baseline.
      const [baseline, target] = selectedRows;
      const res = await api.compareRuns(baseline!.scenario_id, {
        baselineRunId: baseline!.id,
        targetRunId: target!.id,
      });
      if (res.created.length === 0) {
        setErr('No matching screenshots between those runs (nothing to diff).');
        return;
      }
      setSelectedIds([]);
      navigate('/diffs');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setComparing(false);
    }
  }

  async function deleteSelected() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} run(s) and their screenshots?`)) return;
    setDeleting(true);
    setErr(null);
    try {
      await api.deleteRuns(selectedIds);
      if (selected && selectedIds.includes(selected.id)) setSelected(null);
      setSelectedIds([]);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDeleting(false);
    }
  }

  async function removeOne(id: number) {
    if (!confirm(`Delete run #${id} and its screenshots?`)) return;
    try {
      await api.deleteRun(id);
      if (selected?.id === id) setSelected(null);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function removeAll() {
    if (!confirm(`Delete ALL ${runs.length} runs and their screenshots?`)) return;
    try {
      await api.deleteAllRuns();
      setSelected(null);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <section>
      <h1>
        Runs{' '}
        {runs.length > 0 && (
          <button onClick={removeAll} style={{ marginLeft: 12, fontSize: 13 }}>
            Delete all
          </button>
        )}
      </h1>
      {err && <p className="error">{err}</p>}

      <details className="filter-panel" open={activeFilterCount > 0}>
        <summary>
          Filter{' '}
          {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount} active</span>}
        </summary>
        <div className="filter-body">
          <div className="filter-group">
            <div className="filter-group-label">Brand</div>
            {brands.length === 0 ? (
              <span className="muted">No brands yet</span>
            ) : (
              <div className="chip-row">
                {brands.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`chip${selectedBrands.has(b) ? ' chip-on' : ''}`}
                    onClick={() => toggle(selectedBrands, b, setSelectedBrands)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="filter-group">
            <div className="filter-group-label">Type</div>
            {types.length === 0 ? (
              <span className="muted">No types yet</span>
            ) : (
              <div className="chip-row">
                {types.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${selectedTypes.has(t) ? ' chip-on' : ''}`}
                    onClick={() => toggle(selectedTypes, t, setSelectedTypes)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="filter-clear"
              onClick={() => {
                setSelectedBrands(new Set());
                setSelectedTypes(new Set());
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </details>

      <div className="compare-bar">
        <span className="muted">
          Tick runs to delete in bulk, or tick exactly two of the same scenario to compare.
        </span>
        {selectedIds.length > 0 && <span>{selectedIds.length} selected</span>}
        {selectedRows.length === 2 && !canCompare && (
          <span className="error">runs must share a scenario to compare</span>
        )}
        <button onClick={runComparison} disabled={!canCompare || comparing}>
          {comparing ? 'Comparing…' : 'Compare runs'}
        </button>
        <button
          className="btn-danger"
          onClick={deleteSelected}
          disabled={selectedIds.length === 0 || deleting}
        >
          {deleting ? 'Deleting…' : `Delete selected (${selectedIds.length})`}
        </button>
        {selectedIds.length > 0 && (
          <button className="diff-tray-clear" onClick={() => setSelectedIds([])}>
            Clear
          </button>
        )}
      </div>

      <div className="runs-grid">
        <table className="table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                  }}
                  onChange={toggleSelectAll}
                  title="Select all (filtered)"
                />
              </th>
              <th>ID</th>
              <th>Scenario</th>
              <th>Name</th>
              <th>Tags</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleRuns.map((r, idx) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                style={{
                  cursor: 'pointer',
                  background: isSelected(r.id)
                    ? 'rgba(56,189,248,0.12)'
                    : selected?.id === r.id
                      ? 'rgba(56,189,248,0.08)'
                      : undefined,
                }}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected(r.id)}
                    onChange={(e) =>
                      toggleSelect(r.id, idx, (e.nativeEvent as MouseEvent).shiftKey)
                    }
                    title="Select run (shift-click for a range)"
                  />
                </td>
                <td>{r.id}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <Link to={`/scenarios/${r.scenario_id}`} title="Edit scenario">
                    {r.scenario_id}
                  </Link>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {r.scenario_name != null ? (
                    <Link to={`/scenarios/${r.scenario_id}`} title="Edit scenario">
                      {r.scenario_name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {r.brand || r.type ? (
                    <span className="run-tags">
                      {r.brand && <span className="run-tag">{r.brand}</span>}
                      {r.type && <span className="run-tag">{r.type}</span>}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <span className={`status status-${r.status}`}>{r.status}</span>
                </td>
                <td>{r.started_at}</td>
                <td>{r.finished_at ?? '—'}</td>
                <td>
                  <button
                    className="step-del"
                    title="Delete run"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeOne(r.id);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            {runs.length > 0 && visibleRuns.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                  No runs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {selected && <RunDetail run={selected} onDelete={removeOne} />}
      </div>
    </section>
  );
}

function RunDetail({ run, onDelete }: { run: Run; onDelete: (id: number) => void }) {
  let screenshots: string[] = [];
  try { screenshots = JSON.parse(run.screenshot_paths_json); } catch {}

  return (
    <div className="run-detail">
      <h2>
        Run #{run.id}{' '}
        <button onClick={() => onDelete(run.id)} style={{ marginLeft: 8, fontSize: 13 }}>
          Delete
        </button>
      </h2>
      <p className="muted">{run.started_at} → {run.finished_at ?? 'in progress'}</p>
      <h3>Log</h3>
      <pre className="run-log">{run.log_text || '(no log yet)'}</pre>
      <h3>Screenshots ({screenshots.length})</h3>
      <div className="screenshots">
        {screenshots.map((name) => (
          <div key={name} className="shot">
            <img src={`/api/runs/${run.id}/screenshots/${name}`} alt={name} />
            <div className="muted">{name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function collectTagValues(runs: Run[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const r of runs) {
    const v = r[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

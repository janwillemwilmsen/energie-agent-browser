import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Scenario } from '../lib/api.js';
import { GroupBySwitch, GroupLabel, groupKey, sortByGroup, type GroupBy } from '../lib/tagGrouping.js';

export function Scenarios() {
  const [items, setItems] = useState<Scenario[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [preset, setPreset] = useState<'desktop' | 'mobile' | 'both'>('desktop');
  const [brand, setBrand] = useState('');
  const [type, setType] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Brand/Type chip filters — same UI and semantics as /runs: within a group
  // any selected value matches (OR), across groups both must match (AND).
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  // Sort / group: 'date' keeps API order; brand / type / both insert group
  // header rows, exactly like /runs and the Dashboard (lib/tagGrouping).
  const [groupBy, setGroupBy] = useState<GroupBy>('date');
  // Which scenario is currently being launched, and a short status line. Runs
  // share the single 'default' session, so only one launch happens at a time.
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  // Capture the id of the most-recently-started run so the "See Runs" link
  // can deep-link to /runs?run=<id>, which the Runs page picks up to open
  // that run's detail panel.
  const [lastRunId, setLastRunId] = useState<number | null>(null);

  async function load() {
    try {
      setItems(await api.listScenarios());
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.createScenario({
        name,
        url,
        viewport_preset: preset,
        brand: brand.trim() || null,
        type: type.trim() || null,
      });
      setName('');
      setUrl('https://');
      setBrand('');
      setType('');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this scenario?')) return;
    await api.deleteScenario(id);
    await load();
  }

  // Kick off a run with a fresh browser session. The server does the reset
  // (close + bootstrap) as part of the run itself, so it can't race with the
  // preview stream or other run triggers.
  async function runScenario(s: Scenario) {
    if (runningId != null) return;
    setErr(null);
    setRunningId(s.id);
    setRunStatus(`Starting run for "${s.name}" (fresh browser)…`);
    try {
      const run = await api.startRun(s.id, { reset: true });
      setLastRunId(run.id);
      setRunStatus(`Run #${run.id} started for "${s.name}".`);
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setRunStatus(null);
    } finally {
      setRunningId(null);
    }
  }

  async function updateTag(s: Scenario, field: 'brand' | 'type', value: string) {
    const next = value.trim() || null;
    if (next === s[field]) return;
    try {
      await api.updateScenario(s.id, { [field]: next } as Partial<Scenario>);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const brands = useMemo(() => collectTagValues(items, 'brand'), [items]);
  const types = useMemo(() => collectTagValues(items, 'type'), [items]);

  const visibleItems = useMemo(() => {
    return items.filter((s) => {
      const brandOk = selectedBrands.size === 0 || (s.brand != null && selectedBrands.has(s.brand));
      const typeOk = selectedTypes.size === 0 || (s.type != null && selectedTypes.has(s.type));
      return brandOk && typeOk;
    });
  }, [items, selectedBrands, selectedTypes]);

  const displayItems = useMemo(() => sortByGroup(visibleItems, groupBy), [visibleItems, groupBy]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of displayItems) {
      const k = groupKey(s, groupBy);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [displayItems, groupBy]);

  function toggle(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  return (
    <section>
      <div className="runs-head">
        <h1>Scenarios</h1>
        <GroupBySwitch value={groupBy} onChange={setGroupBy} />
      </div>
      {err && <p className="error">{err}</p>}
      {runStatus && (
        <p className="muted">
          {runStatus}{' '}
          <Link to={lastRunId != null ? `/runs?run=${lastRunId}` : '/runs'}>See Runs</Link>
        </p>
      )}

      <details className="card">
        <summary><h3>New scenario</h3></summary>
        <form onSubmit={create}>
          <label htmlFor="scenario-name">
            Name
            <input
              id="scenario-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
			  placeholder="Name"
            />
          </label>
          <label htmlFor="scenario-url">
            URL
            <input
              id="scenario-url"
              name="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
			  placeholder="https...."
              required
            />
          </label>
          <label htmlFor="scenario-viewport">
            Viewport
            <select
              id="scenario-viewport"
              name="viewport_preset"
              value={preset}
              onChange={(e) => setPreset(e.target.value as any)}
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label htmlFor="scenario-brand">
            Brand <span className="muted">(used for filtering)</span>
            <input
              id="scenario-brand"
              name="brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Acme"
            />
          </label>
          <label htmlFor="scenario-type">
            Type <span className="muted">(used for filtering)</span>
            <input
              id="scenario-type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="e.g. Checkout flow"
            />
          </label>
          <button type="submit">Create</button>
        </form>
      </details>

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

      <table className="table scenarios-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>URL</th>
            <th>Viewport</th>
            <th>Brand</th>
            <th>Type</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.length > 0 && visibleItems.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                No scenarios match the current filters.
              </td>
            </tr>
          )}
          {displayItems.map((s, idx) => (
            <Fragment key={s.id}>
            {groupBy !== 'date' &&
              (idx === 0 ||
                groupKey(displayItems[idx - 1]!, groupBy) !== groupKey(s, groupBy)) && (
                <tr className="runs-group-row">
                  <td colSpan={7}>
                    <GroupLabel groupBy={groupBy} brand={s.brand} type={s.type} />
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {groupCounts.get(groupKey(s, groupBy))} scenario
                      {groupCounts.get(groupKey(s, groupBy)) === 1 ? '' : 's'}
                    </span>
                  </td>
                </tr>
              )}
            <tr>
              <td data-label="Name">
                <Link to={`/scenarios/${s.id}`}>{s.name}</Link>
              </td>
              <td data-label="URL" className="scenario-url">{s.url}</td>
              <td data-label="Viewport">{s.viewport_preset}</td>
              <td data-label="Brand">
                <input
                  className="inline-tag-input"
                  aria-label={`Brand for ${s.name}`}
                  defaultValue={s.brand ?? ''}
                  placeholder="—"
                  onBlur={(e) => updateTag(s, 'brand', e.target.value)}
                />
              </td>
              <td data-label="Type">
                <input
                  className="inline-tag-input"
                  aria-label={`Type for ${s.name}`}
                  defaultValue={s.type ?? ''}
                  placeholder="—"
                  onBlur={(e) => updateTag(s, 'type', e.target.value)}
                />
              </td>
              <td data-label="Updated">{s.updated_at}</td>
              <td className="scenario-actions">
                {/* Flex lives on an inner wrapper, not the <td>: a flex <td>
                    stops being a table cell, so it wouldn't stretch to the
                    row height and its bottom border fell short of the row. */}
                <div className="scenario-actions-row">
                  <button
                    onClick={() => runScenario(s)}
                    disabled={runningId != null}
                    title="Reset the browser session, then run this scenario"
                  >
                    {runningId === s.id ? 'Running…' : '▶ Run'}
                  </button>
                  <Link to={`/screenshots/timeline/${s.id}`} className="btn-link">
                    Screenshots
                  </Link>
                  <button onClick={() => remove(s.id)} disabled={runningId != null}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Distinct, sorted tag values present in the list (drives the filter chips).
function collectTagValues(items: Scenario[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const s of items) {
    const v = s[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

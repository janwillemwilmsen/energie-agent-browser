import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Run } from '../lib/api.js';

// Per-scenario gallery: one section per scenario that has runs (after the
// global Brand/Type filter), and each section carries its OWN date picker so
// different scenarios can be parked on different days. Default per scenario:
// the day of its latest run. A "reset all" shortcut snaps every section back
// to that latest-per-scenario default.

function toDayKey(iso: string): string {
  // SQLite started_at format is "YYYY-MM-DD HH:MM:SS" (no T, no Z). Take the
  // date prefix; falling back to ISO parsing for safety.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m && m[1]) return m[1];
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function addDays(dayKey: string, n: number): string {
  // Parse as local midnight, shift, format back. Avoids the UTC drift that
  // toISOString() would introduce on day boundaries.
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d! + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function collectTagValues(runs: Run[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const r of runs) {
    const v = r[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

interface ScenarioData {
  scenario_id: number;
  scenario_name: string;
  brand: string | null;
  type: string | null;
  // Days that have at least one run for this scenario, NEWEST first. Used by
  // the per-scenario older/newer buttons.
  populatedDays: string[];
  // Latest run on a given day for this scenario.
  runByDay: Map<string, Run>;
}

export function Screenshots() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  // Per-scenario date selection. Absent → use the scenario's latest day.
  const [dayByScenario, setDayByScenario] = useState<Record<number, string>>({});

  async function load() {
    try {
      setRuns(await api.listRuns());
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
    // Polling keeps the page live while a scheduled run completes.
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  const brands = useMemo(() => collectTagValues(runs, 'brand'), [runs]);
  const types = useMemo(() => collectTagValues(runs, 'type'), [runs]);
  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  // Group runs by scenario, retaining only the latest run per (scenario, day)
  // and the sorted list of days that have any runs for that scenario.
  const scenarios: ScenarioData[] = useMemo(() => {
    // /api/runs returns newest first, so first occurrence per scenario_id per
    // day is the latest for that day — no extra sorting needed.
    const map = new Map<number, ScenarioData>();
    for (const r of runs) {
      // Apply chip filters here so empty scenarios drop out of the list.
      const brandOk = selectedBrands.size === 0 || (r.brand != null && selectedBrands.has(r.brand));
      const typeOk = selectedTypes.size === 0 || (r.type != null && selectedTypes.has(r.type));
      if (!brandOk || !typeOk) continue;

      const day = toDayKey(r.started_at);
      if (!day) continue;
      let s = map.get(r.scenario_id);
      if (!s) {
        s = {
          scenario_id: r.scenario_id,
          scenario_name: r.scenario_name ?? `Scenario ${r.scenario_id}`,
          brand: r.brand ?? null,
          type: r.type ?? null,
          populatedDays: [],
          runByDay: new Map(),
        };
        map.set(r.scenario_id, s);
      }
      if (!s.runByDay.has(day)) {
        s.runByDay.set(day, r);
        s.populatedDays.push(day); // will dedupe + sort at the end
      }
    }
    // Sort populatedDays newest first per scenario.
    for (const s of map.values()) {
      s.populatedDays.sort();
      s.populatedDays.reverse();
    }
    return Array.from(map.values()).sort((a, b) =>
      a.scenario_name.localeCompare(b.scenario_name),
    );
  }, [runs, selectedBrands, selectedTypes]);

  function toggle(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  function setDay(scenarioId: number, day: string | null) {
    setDayByScenario((prev) => {
      const next = { ...prev };
      if (day == null) delete next[scenarioId];
      else next[scenarioId] = day;
      return next;
    });
  }

  function resetAllToLatest() {
    setDayByScenario({});
  }

  return (
    <section>
      <h1>Screenshots</h1>

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

      <div className="screenshots-toolbar">
        <span className="muted">
          Each scenario has its own date picker — newest run is the default. Brand/Type filters
          narrow which scenarios show below.
        </span>
        {Object.keys(dayByScenario).length > 0 && (
          <button
            type="button"
            className="screenshots-today"
            onClick={resetAllToLatest}
            style={{ marginLeft: 'auto' }}
          >
            Reset all to latest
          </button>
        )}
      </div>

      {err && <p className="error">{err}</p>}

      {scenarios.length === 0 && (
        <p className="muted">
          {runs.length === 0
            ? 'No runs yet.'
            : 'No scenarios match the current filters.'}
        </p>
      )}

      {scenarios.map((s) => (
        <ScenarioBlock
          key={s.scenario_id}
          data={s}
          day={dayByScenario[s.scenario_id] ?? s.populatedDays[0] ?? ''}
          onSetDay={(d) => setDay(s.scenario_id, d)}
          onResetToLatest={() => setDay(s.scenario_id, null)}
          isDefaultDay={
            dayByScenario[s.scenario_id] == null ||
            dayByScenario[s.scenario_id] === s.populatedDays[0]
          }
        />
      ))}
    </section>
  );
}

function ScenarioBlock({
  data,
  day,
  onSetDay,
  onResetToLatest,
  isDefaultDay,
}: {
  data: ScenarioData;
  day: string;
  onSetDay: (day: string) => void;
  onResetToLatest: () => void;
  isDefaultDay: boolean;
}) {
  // Per-scenario navigation: older/newer hop to the next-older / next-newer
  // day THIS scenario actually has runs for. Falls back to a calendar step
  // when there's no neighbouring populated day, so the user can scan empty
  // territory if they want.
  function gotoNearer(direction: 'older' | 'newer') {
    const idx = data.populatedDays.indexOf(day);
    if (idx === -1) {
      if (data.populatedDays.length > 0) {
        onSetDay(data.populatedDays[0]!);
        return;
      }
      onSetDay(addDays(day || new Date().toISOString().slice(0, 10), direction === 'older' ? -1 : 1));
      return;
    }
    if (direction === 'older' && idx < data.populatedDays.length - 1) {
      onSetDay(data.populatedDays[idx + 1]!);
    } else if (direction === 'newer' && idx > 0) {
      onSetDay(data.populatedDays[idx - 1]!);
    } else {
      onSetDay(addDays(day, direction === 'older' ? -1 : 1));
    }
  }

  const run = data.runByDay.get(day) ?? null;
  let screenshots: string[] = [];
  if (run) {
    try { screenshots = JSON.parse(run.screenshot_paths_json); } catch { /* malformed */ }
  }

  const latestDay = data.populatedDays[0] ?? '';
  const atNewest = day === latestDay;

  return (
    <article className="ss-block">
      <header className="ss-block-head">
        <h2 style={{ margin: 0 }}>
          <Link to={`/scenarios/${data.scenario_id}`}>{data.scenario_name}</Link>
        </h2>
        {run && (
          <span className={`status status-${run.status}`}>{run.status}</span>
        )}
        {data.brand && <span className="tag tag-brand">{data.brand}</span>}
        {data.type && <span className="tag tag-type">{data.type}</span>}
        <Link
          to={`/screenshots/timeline/${data.scenario_id}`}
          className="ss-timeline-link"
          title="Compare this scenario's screenshots across runs"
        >
          ◷ timeline
        </Link>

        <div className="screenshots-day" style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={() => gotoNearer('older')}
            title="Jump to this scenario's previous day with screenshots"
          >
            ◀ older
          </button>
          <input
            type="date"
            value={day}
            onChange={(e) => onSetDay(e.target.value || latestDay)}
          />
          <button
            type="button"
            onClick={() => gotoNearer('newer')}
            disabled={atNewest}
            title="Jump to this scenario's next day with screenshots"
          >
            newer ▶
          </button>
          {!isDefaultDay && (
            <button
              type="button"
              className="screenshots-today"
              onClick={onResetToLatest}
              title="Reset this scenario to its latest run day"
            >
              latest
            </button>
          )}
        </div>
      </header>

      {run ? (
        <>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
            <Link to={`/runs?run=${run.id}`} title="Open this run on the Runs page">
              Run #{run.id} · {run.started_at}
            </Link>
            {screenshots.length > 0 && <> · {screenshots.length} screenshot{screenshots.length === 1 ? '' : 's'}</>}
          </p>
          {screenshots.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              This run produced no screenshots.
            </p>
          ) : (
            <div className="ss-grid">
              {screenshots.map((name) => (
                <a
                  key={name}
                  href={`/api/runs/${run.id}/screenshots/${name}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ss-card"
                  title={name + ' (click to open full size)'}
                >
                  <img
                    src={`/api/runs/${run.id}/screenshots/${name}`}
                    alt={name}
                    loading="lazy"
                  />
                  <figcaption>{name}</figcaption>
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No run on <strong>{day}</strong>.{' '}
          {latestDay && latestDay !== day && (
            <>
              Latest run was on{' '}
              <button
                type="button"
                className="filter-clear"
                style={{ display: 'inline-block' }}
                onClick={() => onSetDay(latestDay)}
              >
                {latestDay}
              </button>
              .
            </>
          )}
        </p>
      )}
    </article>
  );
}

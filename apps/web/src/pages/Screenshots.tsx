import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseScreenshotMetas, screenshotMetaFor } from '@eab/shared';
import { api, type RunDay, type Scenario } from '../lib/api.js';
import { useResource, usePolling } from '../lib/resource.js';
import { ScreenshotViewer } from '../lib/ScreenshotViewer.js';
import { CanvasSurface, ScreenshotCanvas, runGroup, type CanvasGroup } from '../lib/ScreenshotCanvas.js';
import { matchesTags, NO_TAGS, TagFilter, tagsActive, tagValues, type TagSelection } from '../lib/TagFilter.js';

// Per-scenario gallery: one section per scenario that has runs (after the
// global Brand/Type filter), and each section carries its OWN day dropdown
// (listing only days with runs) so different scenarios can be parked on
// different days. Default per scenario:
// the day of its latest run. A "reset all" shortcut snaps every section back
// to that latest-per-scenario default.
//
// Data: /api/runs/daily (the latest run per scenario per day, all history) so
// a scenario that has not run lately still has its section; /api/runs is a
// window over the newest runs and would drop it. The Brand/Type chips come
// from the scenarios themselves, so every tag in use is offered — even one
// whose scenarios have no runs yet.

interface ScenarioData {
  scenario_id: number;
  scenario_name: string;
  brand: string | null;
  type: string | null;
  // Days that have at least one run for this scenario, NEWEST first. Used by
  // the per-scenario day dropdown.
  populatedDays: string[];
  // Latest run on a given day for this scenario.
  runByDay: Map<string, RunDay>;
}

const SORT_KEY = 'eab.screenshots.sort';

export function Screenshots() {
  const [tags, setTags] = useState<TagSelection>(NO_TAGS);
  // Per-scenario date selection. Absent → use the scenario's latest day.
  const [dayByScenario, setDayByScenario] = useState<Record<number, string>>({});
  // Section order: by the scenario's latest run (newest first) or by name.
  const [sort, setSort] = useState<'lastRun' | 'name'>(() => {
    try { return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'lastRun'; } catch { return 'lastRun'; }
  });
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sort); } catch { /* ignore */ }
  }, [sort]);
  // The canvas over everything shown: one row per scenario's displayed run.
  const [canvasAll, setCanvasAll] = useState(false);

  const { data: runs, error: err, setError: setErr, refresh: load } = useResource(
    () => api.listRunsDaily(),
    { initial: [] as RunDay[] },
  );
  const { data: allScenarios } = useResource(() => api.listScenarios(), { initial: [] as Scenario[] });
  // Polling keeps the page live while a scheduled run completes.
  usePolling(load, 6000);

  const brands = useMemo(() => tagValues(allScenarios, 'brand'), [allScenarios]);
  const types = useMemo(() => tagValues(allScenarios, 'type'), [allScenarios]);
  const activeFilterCount = tagsActive(tags);
  const selectedBrands = tags.brands;
  const selectedTypes = tags.types;

  // Group the daily rows by scenario: one run per (scenario, day) already,
  // plus the sorted list of days that have any runs for that scenario.
  const scenarios: ScenarioData[] = useMemo(() => {
    const map = new Map<number, ScenarioData>();
    for (const r of runs) {
      // Apply chip filters here so empty scenarios drop out of the list.
      if (!matchesTags(r, tags)) continue;

      const day = r.day;
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
    const byName = (a: ScenarioData, b: ScenarioData) => a.scenario_name.localeCompare(b.scenario_name);
    // Last run: the start time of the scenario's newest run, newest first.
    const lastRun = (s: ScenarioData) => Date.parse(s.runByDay.get(s.populatedDays[0] ?? '')?.started_at ?? '') || 0;
    return Array.from(map.values()).sort((a, b) =>
      sort === 'lastRun' ? lastRun(b) - lastRun(a) || byName(a, b) : byName(a, b),
    );
  }, [runs, tags, sort]);

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

  // What is actually on screen after filtering + per-scenario day choice: the
  // run shown for each scenario and its screenshot files. Drives the counter
  // and the zip download.
  const shown = useMemo(() => {
    const items: { scenarioId: number; scenarioName: string; run: RunDay; runId: number; names: string[] }[] = [];
    for (const s of scenarios) {
      const day = dayByScenario[s.scenario_id] ?? s.populatedDays[0] ?? '';
      const run = s.runByDay.get(day);
      if (!run) continue;
      let names: string[] = [];
      try { names = JSON.parse(run.screenshot_paths_json); } catch { /* malformed */ }
      items.push({ scenarioId: s.scenario_id, scenarioName: s.scenario_name, run, runId: run.id, names });
    }
    return items;
  }, [scenarios, dayByScenario]);
  // The same, as canvas rows (page order).
  const canvasGroups = useMemo<CanvasGroup[]>(
    () => shown.map((it) => ({ ...runGroup(it.run, it.scenarioName), key: `${it.scenarioId}/${it.runId}` })),
    [shown],
  );
  const shownScreenshots = shown.reduce((n, it) => n + it.names.length, 0);

  const [downloading, setDownloading] = useState(false);
  async function downloadZip() {
    const items = shown.filter((it) => it.names.length > 0).map((it) => ({ runId: it.runId, names: it.names }));
    if (!items.length) return;
    setDownloading(true);
    setErr(null);
    try {
      const { blob, filename } = await api.downloadScreenshotsZip(items);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section>
      <h1>Screenshots</h1>
      <p className="muted" style={{ marginTop: 0 }} aria-live="polite">
        {activeFilterCount === 0 ? (
          <>
            Showing all scenarios and screenshots (if available). Filter on 'Brand' and/or 'Type' to
            select specific scenarios and screenshots. <br/>
			Each scenario has its own day dropdown (only days with screenshots) — newest run is the
          default.
          </>
        ) : (
          <>
            Showing scenarios and screenshots (if available) for{' '}
            {selectedBrands.size > 0 && (
              <>
                brand{selectedBrands.size === 1 ? '' : 's'}{' '}
                <strong>{Array.from(selectedBrands).sort((a, b) => a.localeCompare(b)).join(', ')}</strong>
              </>
            )}
            {selectedBrands.size > 0 && selectedTypes.size > 0 && ' and '}
            {selectedTypes.size > 0 && (
              <>
                type{selectedTypes.size === 1 ? '' : 's'}{' '}
                <strong>{Array.from(selectedTypes).sort((a, b) => a.localeCompare(b)).join(', ')}</strong>
              </>
            )}
            .{' '}
            <button
              type="button"
              className="filter-clear"
              style={{ display: 'inline-block' }}
              onClick={() => setTags(NO_TAGS)}
            >
              Clear filters
            </button>{' '}
            to show all.
          </>
        )}
      </p>

      <div className="screenshots-toolbar" style={{ marginBottom: 12 }}>
        <span className="ss-counter" aria-live="polite">
          <strong>{scenarios.length}</strong> scenario{scenarios.length === 1 ? '' : 's'} ·{' '}
          <strong>{shownScreenshots}</strong> screenshot{shownScreenshots === 1 ? '' : 's'}
          {activeFilterCount > 0 && <span className="muted"> (filtered)</span>}
        </span>
        <label className="screenshots-sort" style={{ marginLeft: 'auto' }}>
          <span className="muted">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'lastRun' | 'name')} title="Order of the scenarios below">
            <option value="lastRun">last run, newest first</option>
            <option value="name">name</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setCanvasAll(true)}
          disabled={shownScreenshots === 0}
          title="Open every run shown below on one canvas, a row per scenario: pan and zoom through all of them"
        >
          Canvas ({shown.filter((it) => it.names.length > 0).length})
        </button>
        <button
          type="button"
          onClick={() => void downloadZip()}
          disabled={downloading || shownScreenshots === 0}
          title="Download the screenshots shown below (one folder per scenario/run) as a zip"
        >
          {downloading ? 'Preparing zip…' : `Download (${shownScreenshots})`}
        </button>
      </div>

      <TagFilter brands={brands} types={types} selection={tags} onChange={setTags} />

      <div className="screenshots-toolbar">
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

      {canvasAll && (
        <CanvasSurface
          title={activeFilterCount === 0 ? 'All scenarios' : [...selectedBrands, ...selectedTypes].join(', ')}
          groups={canvasGroups.filter((g) => g.names.length > 0)}
          note={canvasGroups.every((g) => g.names.length === 0) ? 'None of the shown runs produced screenshots.' : null}
          onClose={() => setCanvasAll(false)}
        />
      )}
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
  const run = data.runByDay.get(day) ?? null;
  let screenshots: string[] = [];
  if (run) {
    try { screenshots = JSON.parse(run.screenshot_paths_json); } catch { /* malformed */ }
  }
  const metas = parseScreenshotMetas(run?.screenshot_meta_json);
  // Index of the screenshot open in the viewer; closed when null or when the
  // shown run changes.
  const [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => setViewing(null), [run?.id]);
  // The canvas: this run's screenshots on a pan-and-zoom surface, with a run switcher.
  const [canvas, setCanvas] = useState(false);

  const latestDay = data.populatedDays[0] ?? '';

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
        {run && (
          <button
            type="button"
            className="ss-timeline-link"
            onClick={() => setCanvas(true)}
            title="Open this run's screenshots on a full-screen canvas: pan, zoom, switch runs"
          >
            ⊞ canvas
          </button>
        )}

        <div className="screenshots-day" style={{ marginLeft: 'auto' }}>
          <select
            value={data.populatedDays.includes(day) ? day : ''}
            onChange={(e) => onSetDay(e.target.value || latestDay)}
            title="Pick a day this scenario has screenshots for"
          >
            {/* Placeholder only shows if the selected day has no run (e.g. stale
                selection after a filter change); picking any option clears it. */}
            {!data.populatedDays.includes(day) && <option value="">No run on {day}</option>}
            {data.populatedDays.map((d, i) => (
              <option key={d} value={d}>
                {d}
                {i === 0 ? ' (latest)' : ''}
              </option>
            ))}
          </select>
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
            <Link
              to={`/runs?run=${run.id}`}
              className="ss-run-link"
              title="Open this run on the Runs page"
            >
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
              {screenshots.map((name, i) => (
                <a
                  key={name}
                  href={api.runScreenshotUrl(run.id, name)}
                  className="ss-card"
                  title={name + ' (click to view; ⌘/Ctrl-click opens the file)'}
                  onClick={(e) => {
                    // A plain click opens the viewer; a modified click keeps
                    // the browser's open-in-new-tab behaviour on the file.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    setViewing(i);
                  }}
                >
                  <img
                    src={api.runScreenshotUrl(run.id, name, { w: 480 })}
                    alt={name}
                    loading="lazy"
                    decoding="async"
                  />
                  <figcaption>{name}</figcaption>
                </a>
              ))}
            </div>
          )}
          {viewing != null && (
            <ScreenshotViewer
              items={screenshots.map((name) => ({ runId: run.id, name, meta: screenshotMetaFor(name, metas) }))}
              index={viewing}
              onIndex={setViewing}
              onClose={() => setViewing(null)}
            />
          )}
          {canvas && (
            <ScreenshotCanvas
              scenarioId={data.scenario_id}
              scenarioName={data.scenario_name}
              initialRunId={run.id}
              onClose={() => setCanvas(false)}
            />
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

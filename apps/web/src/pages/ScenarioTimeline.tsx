import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { parseSlot, slotDisplayLabel, slotKey } from '@eab/shared';
import { api, type Run, type Scenario } from '../lib/api.js';
import { ScreenshotCanvas } from '../lib/ScreenshotCanvas.js';

export function ScenarioTimeline() {
  const { id } = useParams();
  const scenarioId = Number(id);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // The run open on the canvas (pan-and-zoom view of its screenshots), if any.
  const [canvasRun, setCanvasRun] = useState<number | null>(null);

  async function removeRun(runId: number) {
    if (!confirm(`Delete run #${runId} with its screenshots, texts and video recording?`)) return;
    setErr(null);
    try {
      await api.deleteRun(runId);
      setRuns((cur) => cur.filter((r) => r.id !== runId));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    if (!scenarioId) return;
    Promise.all([api.getScenario(scenarioId), api.listScenarioRuns(scenarioId)])
      .then(([s, r]) => {
        setScenario(s);
        setRuns(r);
      })
      .catch((e) => setErr(e.message));
  }, [scenarioId]);

  // Columns: the completed runs, newest on the left (the server lists them
  // oldest first). Rows: one per slot key, in capture order (see buildMatrix).
  const completedRuns = useMemo(
    () => runs
      .filter((r) => r.status === 'success' || r.status === 'failed')
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id),
    [runs],
  );
  const matrix = useMemo(() => buildMatrix(completedRuns), [completedRuns]);

  if (err && !scenario) return <p className="error">{err}</p>;
  if (!scenario) return <p>Loading…</p>;

  return (
    <section>
      <p className="breadcrumb">
        <Link to="/screenshots">← Screenshots</Link>
        <Link to="/">Dashboard</Link>
        <Link to={`/scenarios/${scenarioId}`}>Editor</Link>
      </p>
      <h1>{scenario.name}</h1>
      <p className="muted">
        {scenario.brand && <span className="tag tag-brand">{scenario.brand}</span>}{' '}
        {scenario.type && <span className="tag tag-type">{scenario.type}</span>}{' '}
        &mdash; {scenario.url}
      </p>
      {completedRuns[0] && (
        <p>
          <button
            type="button"
            className="ss-timeline-link"
            onClick={() => setCanvasRun(completedRuns[0]!.id)}
            title="Open the latest run's screenshots on a full-screen canvas: pan, zoom, switch runs"
          >
            ⊞ canvas
          </button>
        </p>
      )}
      {err && <p className="error">{err}</p>}

      {completedRuns.length === 0 ? (
        <p className="muted">No completed runs yet.</p>
      ) : (
        <div className="timeline-scroll">
          <table className="timeline-table">
            <thead>
              <tr>
                <th className="timeline-row-head">Step</th>
                {completedRuns.map((r) => (
                  <th key={r.id} className="timeline-col-head">
                    <div className="timeline-col-date">{formatDate(r.started_at)}</div>
                    <div>
                      <span className={`status status-${r.status}`}>{r.status}</span>{' '}
                      <Link to={`/runs?run=${r.id}`} className="muted">
                        #{r.id}
                      </Link>{' '}
                      <button
                        className="step-del"
                        title="Open this run on the canvas"
                        onClick={() => setCanvasRun(r.id)}
                      >
                        ⊞
                      </button>{' '}
                      <button
                        className="step-del"
                        title="Delete run"
                        onClick={() => void removeRun(r.id)}
                      >
                        🗑
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.key}>
                  <td className="timeline-row-head">
                    <div className="timeline-step-label">{row.label}</div>
                  </td>
                  {completedRuns.map((r) => {
                    const file = matrix.byRun[r.id]?.get(row.key);
                    return (
                      <td key={r.id} className="timeline-cell">
                        {file ? (
                          <a
                            href={api.runScreenshotUrl(r.id, file)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <img
                              src={api.runScreenshotUrl(r.id, file, { w: 480 })}
                              alt={`${row.label} from run ${r.id}`}
                              loading="lazy"
                              decoding="async"
                            />
                          </a>
                        ) : (
                          <div className="timeline-cell-empty">—</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canvasRun != null && (
        <ScreenshotCanvas
          scenarioId={scenarioId}
          scenarioName={scenario.name}
          initialRunId={canvasRun}
          onClose={() => setCanvasRun(null)}
        />
      )}
    </section>
  );
}

interface Matrix {
  rows: { key: string; label: string }[];
  byRun: Record<number, Map<string, string>>;
}

/**
 * A row per screenshot slot so the same step from different runs lines up
 * horizontally. Rows follow capture order, oldest at the top: the filename
 * stamp (`YYYYMMDD-HHMMSS-label-viewport.png`) within a run, older files by
 * their `NNN-` position. `runs` arrive newest first, so the newest run sets
 * the order and slots that only older runs still have are appended after,
 * in their own order.
 */
function buildMatrix(runs: Run[]): Matrix {
  const byRun: Record<number, Map<string, string>> = {};
  const rowMap = new Map<string, string>();

  for (const r of runs) {
    let shots: string[] = [];
    try {
      shots = JSON.parse(r.screenshot_paths_json) as string[];
    } catch {
      /* ignore */
    }
    const map = new Map<string, string>();
    for (const filename of [...shots].sort(compareCapture)) {
      // Screenshots with the same label + viewport share a row across runs,
      // whatever their position, stamp or format (the slot protocol's key).
      const key = slotKey(filename);
      const label = slotDisplayLabel(filename);
      if (!rowMap.has(key)) rowMap.set(key, label);
      map.set(key, filename);
    }
    byRun[r.id] = map;
  }

  const rows = Array.from(rowMap.entries()).map(([key, label]) => ({ key, label }));
  return { rows, byRun };
}

/** Capture order within one run: by stamp, then by the older files' position, then by name. */
function compareCapture(a: string, b: string): number {
  const pa = parseSlot(a);
  const pb = parseSlot(b);
  const sa = pa?.stamp ?? '';
  const sb = pb?.stamp ?? '';
  if (sa !== sb) return sa.localeCompare(sb);
  const na = pa?.position ?? Number.MAX_SAFE_INTEGER;
  const nb = pb?.position ?? Number.MAX_SAFE_INTEGER;
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

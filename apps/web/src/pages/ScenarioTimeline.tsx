import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Run, type Scenario } from '../lib/api.js';

export function ScenarioTimeline() {
  const { id } = useParams();
  const scenarioId = Number(id);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function removeRun(runId: number) {
    if (!confirm(`Delete run #${runId} and its screenshots?`)) return;
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

  // Build a row-per-screenshot-filename matrix so the same step from different
  // runs lines up horizontally. Filenames are `NNN-YYYYMMDD-HHMMSS-label-viewport.png`
  // (see runner.ts); stripping the position + timestamp leaves a stable key shared
  // across runs (older un-stamped `NNN-label-viewport.png` files still match).
  const matrix = useMemo(() => buildMatrix(runs), [runs]);

  if (err && !scenario) return <p className="error">{err}</p>;
  if (!scenario) return <p>Loading…</p>;

  const completedRuns = runs.filter((r) => r.status === 'success' || r.status === 'failed');

  return (
    <section>
      <p>
        <Link to="/screenshots">← Screenshots</Link>{' '}
        <span className="muted">/</span>{' '}
        <Link to="/">Dashboard</Link>{' '}
        <span className="muted">/</span>{' '}
        <Link to={`/scenarios/${scenarioId}`}>Editor</Link>
      </p>
      <h1>{scenario.name}</h1>
      <p className="muted">
        {scenario.brand && <span className="tag tag-brand">{scenario.brand}</span>}{' '}
        {scenario.type && <span className="tag tag-type">{scenario.type}</span>}{' '}
        &mdash; {scenario.url}
      </p>
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
                            href={`/api/runs/${r.id}/screenshots/${encodeURIComponent(file)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <img
                              src={`/api/runs/${r.id}/screenshots/${encodeURIComponent(file)}`}
                              alt={`${row.label} from run ${r.id}`}
                              loading="lazy"
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
    </section>
  );
}

interface Matrix {
  rows: { key: string; label: string }[];
  byRun: Record<number, Map<string, string>>;
}

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
    for (const filename of shots) {
      // Strip the leading position (and per-run timestamp) so screenshots with
      // the same label/viewport from different runs share a row.
      const key = stripPosition(filename);
      const label = labelFromFilename(filename);
      if (!rowMap.has(key)) rowMap.set(key, label);
      map.set(key, filename);
    }
    byRun[r.id] = map;
  }

  const rows = Array.from(rowMap.entries())
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { rows, byRun };
}

// Strip the leading position and the optional per-run YYYYMMDD-HHMMSS stamp.
// "003-20260606-143025-checkout-mobile.png" -> "checkout-mobile.png"
// "003-checkout-mobile.png" (older, un-stamped)  -> "checkout-mobile.png"
const SLOT_PREFIX_RE = /^\d+-(?:\d{8}-\d{6}-)?/;

function stripPosition(filename: string): string {
  return filename.replace(SLOT_PREFIX_RE, '');
}

function labelFromFilename(filename: string): string {
  // "003-20260606-143025-checkout-mobile.png" -> "checkout (mobile)"
  const base = filename.replace(/\.png$/i, '').replace(SLOT_PREFIX_RE, '');
  const m = base.match(/^(.+)-(desktop|mobile)$/);
  if (m) return `${m[1]} (${m[2]})`;
  return base;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

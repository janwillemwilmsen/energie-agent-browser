import { useEffect, useState } from 'react';
import { api, type Run } from '../lib/api.js';

export function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

      <div className="runs-grid">
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Scenario</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                style={{
                  cursor: 'pointer',
                  background: selected?.id === r.id ? 'rgba(56,189,248,0.08)' : undefined,
                }}
              >
                <td>{r.id}</td>
                <td>{r.scenario_id}</td>
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

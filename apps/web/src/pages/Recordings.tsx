import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Recording } from '../lib/api.js';
import { MediabunnyPlayer } from '../lib/MediabunnyPlayer.js';

// Lists run recordings (webm) with the same Brand/Type chip filters as the Runs
// page, plays them via Mediabunny, and allows deletion.

function collectTagValues(items: Recording[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const r of items) {
    const v = r[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function fmtSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Recordings() {
  const [items, setItems] = useState<Recording[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  async function load() {
    try {
      setItems(await api.listRecordings());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    load();
    // Keep the list fresh as runs finish and produce recordings.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const brands = useMemo(() => collectTagValues(items, 'brand'), [items]);
  const types = useMemo(() => collectTagValues(items, 'type'), [items]);
  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  const visible = useMemo(
    () =>
      items.filter((r) => {
        const brandOk = selectedBrands.size === 0 || (r.brand != null && selectedBrands.has(r.brand));
        const typeOk = selectedTypes.size === 0 || (r.type != null && selectedTypes.has(r.type));
        return brandOk && typeOk;
      }),
    [items, selectedBrands, selectedTypes],
  );

  function toggle(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  async function remove(id: number) {
    if (!confirm('Delete this recording and its video file?')) return;
    setErr(null);
    try {
      await api.deleteRecording(id);
      setItems((cur) => cur.filter((r) => r.id !== id));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  return (
    <section>
      <h1>Recordings</h1>
      <p className="muted">
        Videos of scenario runs. Enable <strong>🎥 Record this scenario</strong> in a scenario's
        editor to capture a <code>.webm</code> on each run.
      </p>

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

      {err && <p className="error">{err}</p>}

      {visible.length === 0 ? (
        <p className="muted">
          {items.length === 0
            ? 'No recordings yet. Enable recording on a scenario and run it.'
            : 'No recordings match the current filters.'}
        </p>
      ) : (
        <div className="rec-grid">
          {visible.map((r) => (
            <article key={r.id} className="rec-card">
              <header className="rec-card-head">
                <strong>
                  {r.scenario_id != null ? (
                    <Link to={`/scenarios/${r.scenario_id}`}>
                      {r.scenario_name ?? `Scenario ${r.scenario_id}`}
                    </Link>
                  ) : (
                    r.scenario_name ?? 'Unknown scenario'
                  )}
                </strong>
                {r.brand && <span className="tag tag-brand">{r.brand}</span>}
                {r.type && <span className="tag tag-type">{r.type}</span>}
                <button
                  className="step-del"
                  title="Delete recording"
                  onClick={() => void remove(r.id)}
                  style={{ marginLeft: 'auto' }}
                >
                  🗑
                </button>
              </header>

              <MediabunnyPlayer src={api.recordingVideoUrl(r.id)} />

              <footer className="rec-card-foot muted">
                {r.run_id != null && (
                  <Link to={`/runs?run=${r.run_id}`} title="Open the run">
                    run #{r.run_id}
                  </Link>
                )}{' '}
                · {r.created_at} · {fmtSize(r.size_bytes)} ·{' '}
                <a href={api.recordingVideoUrl(r.id)} download>
                  download
                </a>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type RecordingStorageItem,
  type RunStorageItem,
  type StorageCleanupAction,
  type StorageSummary,
} from '../lib/api.js';

// Admin → Storage. Shows what the SQLite database and the on-disk artifacts
// (run screenshots, recordings, diff images, caches) take up, and lets an
// operator reclaim space: delete the biggest runs/recordings (single or
// multi-select), drop regenerable caches, remove orphans, VACUUM.

function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
  const s = iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtInt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}

const GROUP_COLORS: Record<string, string> = {
  db: '#a78bfa',
  screenshots: '#38bdf8',
  recordings: '#f472b6',
  diffs: '#fbbf24',
  thumbs: '#34d399',
  preview: '#94a3b8',
  logs: '#64748b',
};

const TOP_N = 25;

const STATUS_FILTERS: { value: string; label: string; title: string }[] = [
  { value: 'success', label: 'success', title: 'Finished successfully' },
  { value: 'failed', label: 'failed', title: 'Finished with a failure' },
  { value: 'running', label: 'running', title: 'Still running or queued (cannot be deleted)' },
  { value: 'orphan', label: 'orphan', title: 'Files on disk without a database row, or rows whose file is missing' },
];
const AGE_FILTERS = [7, 30, 90, 180];
const SIZE_FILTERS = [
  { bytes: 1024 * 1024, label: '1 MB' },
  { bytes: 5 * 1024 * 1024, label: '5 MB' },
  { bytes: 10 * 1024 * 1024, label: '10 MB' },
  { bytes: 25 * 1024 * 1024, label: '25 MB' },
];

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string → ms.
function parseSqliteDate(iso: string | null): number | null {
  if (!iso) return null;
  const s = iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function collectTagValues(items: { brand: string | null; type: string | null }[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const it of items) {
    const v = it[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function AdminStorage() {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [runs, setRuns] = useState<RunStorageItem[]>([]);
  const [recs, setRecs] = useState<RecordingStorageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Bulk-selection state for the two tables.
  const [selRuns, setSelRuns] = useState<Set<number>>(new Set());
  const [selRecs, setSelRecs] = useState<Set<string>>(new Set()); // key: id or file path
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [showAllRecs, setShowAllRecs] = useState(false);

  // Filters — shared by the runs and recordings tables below, same Brand/Type
  // chips as the Runs/Recordings pages plus status and age, so a specific
  // slice (e.g. "all failed Essent runs older than 30 days") can be selected
  // and deleted in one go.
  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedStatus, setSelectedStatus] = useState<Set<string>>(new Set());
  const [olderThanDays, setOlderThanDays] = useState<number | null>(null);
  const [minBytes, setMinBytes] = useState<number | null>(null);

  async function load() {
    setErr(null);
    setLoading(true);
    try {
      const [s, r, v] = await Promise.all([api.storageSummary(), api.storageRuns(), api.storageRecordings()]);
      setSummary(s);
      setRuns(r);
      setRecs(v);
      setSelRuns(new Set());
      setSelRecs(new Set());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Wrap an action: clear messages, mark busy, report, reload.
  async function run(key: string, fn: () => Promise<string>) {
    setErr(null);
    setNotice(null);
    setBusy(key);
    try {
      const msg = await fn();
      setNotice(msg);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  // ---- Actions -----------------------------------------------------------

  async function cleanup(action: StorageCleanupAction, label: string, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    await run(`cleanup:${action}`, async () => {
      const r = await api.storageCleanup(action);
      return `${label}: ${fmtInt(r.count)} item(s), freed ${fmtSize(r.freedBytes)}.`;
    });
  }

  async function deleteRunIds(ids: number[], label: string) {
    if (!ids.length) return;
    const total = runs
      .filter((r) => ids.includes(r.runId))
      .reduce((n, r) => n + r.bytes + r.thumbBytes, 0);
    if (
      !confirm(
        `Delete ${label} (${fmtSize(total)} of screenshots)?\n\nThis removes the run row(s) and their screenshot folder(s). Video recordings are kept and stay listed on the Recordings page.`,
      )
    ) {
      return;
    }
    await run('runs:delete', async () => {
      const r = await api.storageDeleteRuns(ids);
      const skipped = r.skippedRunning ? ` (${r.skippedRunning} still running — skipped)` : '';
      return `Deleted ${fmtInt(ids.length - r.skippedRunning)} run(s), freed ${fmtSize(r.freedBytes)}${skipped}.`;
    });
  }

  async function deleteRecItems(items: RecordingStorageItem[], label: string) {
    if (!items.length) return;
    const total = items.reduce((n, r) => n + r.bytes, 0);
    if (!confirm(`Delete ${label} (${fmtSize(total)})? The video file(s) are removed permanently.`)) return;
    const ids = items.filter((r) => r.id != null).map((r) => r.id as number);
    const files = items.filter((r) => r.id == null).map((r) => r.filePath);
    await run('recs:delete', async () => {
      const r = await api.storageDeleteRecordings({ ids, files });
      return `Deleted ${fmtInt(r.deleted)} recording(s), freed ${fmtSize(r.freedBytes)}.`;
    });
  }

  // ---- Derived -----------------------------------------------------------

  const dbBytes = summary ? summary.db.fileBytes + summary.db.walBytes + summary.db.shmBytes : 0;
  const bar = useMemo(() => {
    if (!summary) return [];
    const parts = [
      { key: 'db', label: 'Database', bytes: dbBytes },
      ...summary.groups.map((g) => ({ key: g.key, label: g.label, bytes: g.bytes })),
    ].filter((p) => p.bytes > 0);
    const total = parts.reduce((n, p) => n + p.bytes, 0) || 1;
    return parts.map((p) => ({ ...p, pct: (p.bytes / total) * 100 }));
  }, [summary, dbBytes]);

  const groupByKey = useMemo(() => {
    const m = new Map<string, StorageSummary['groups'][number]>();
    for (const g of summary?.groups ?? []) m.set(g.key, g);
    return m;
  }, [summary]);

  const brands = useMemo(() => collectTagValues([...runs, ...recs], 'brand'), [runs, recs]);
  const types = useMemo(() => collectTagValues([...runs, ...recs], 'type'), [runs, recs]);
  const ageCutoff = olderThanDays != null ? Date.now() - olderThanDays * 86400000 : null;

  function tagsOk(item: { brand: string | null; type: string | null }): boolean {
    const brandOk = selectedBrands.size === 0 || (item.brand != null && selectedBrands.has(item.brand));
    const typeOk = selectedTypes.size === 0 || (item.type != null && selectedTypes.has(item.type));
    return brandOk && typeOk;
  }
  function ageOk(iso: string | null): boolean {
    if (ageCutoff == null) return true;
    const t = parseSqliteDate(iso);
    // Undated items (orphan folders) never match an age filter.
    return t != null && t < ageCutoff;
  }

  const filteredRuns = useMemo(
    () =>
      runs.filter((r) => {
        if (!tagsOk(r)) return false;
        if (selectedStatus.size > 0) {
          const s = r.orphan ? 'orphan' : r.status === 'running' || r.status === 'queued' ? 'running' : r.status ?? 'orphan';
          if (!selectedStatus.has(s)) return false;
        }
        if (!ageOk(r.startedAt)) return false;
        if (minBytes != null && r.bytes + r.thumbBytes < minBytes) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, selectedBrands, selectedTypes, selectedStatus, ageCutoff, minBytes],
  );
  const filteredRecs = useMemo(
    () =>
      recs.filter((r) => {
        if (!tagsOk(r)) return false;
        if (selectedStatus.size > 0) {
          // Recordings have no run status; only the "orphan" bucket applies.
          if (!(selectedStatus.has('orphan') && (r.orphan || r.missing))) return false;
        }
        if (!ageOk(r.createdAt)) return false;
        if (minBytes != null && r.bytes < minBytes) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recs, selectedBrands, selectedTypes, selectedStatus, ageCutoff, minBytes],
  );
  const filteredRunBytes = filteredRuns.reduce((n, r) => n + r.bytes + r.thumbBytes, 0);
  const filteredRecBytes = filteredRecs.reduce((n, r) => n + r.bytes, 0);
  const activeFilterCount =
    selectedBrands.size + selectedTypes.size + selectedStatus.size + (olderThanDays != null ? 1 : 0) + (minBytes != null ? 1 : 0);
  function clearFilters() {
    setSelectedBrands(new Set());
    setSelectedTypes(new Set());
    setSelectedStatus(new Set());
    setOlderThanDays(null);
    setMinBytes(null);
  }
  function toggleIn(set: Set<string>, value: string, setter: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  // Changing a filter drops now-hidden rows from the selection, so "Delete
  // selected" only ever removes what's on screen.
  useEffect(() => {
    const ids = new Set(filteredRuns.map((r) => r.runId));
    setSelRuns((cur) => {
      const next = new Set([...cur].filter((id) => ids.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [filteredRuns]);
  useEffect(() => {
    const keys = new Set(filteredRecs.map(recKey));
    setSelRecs((cur) => {
      const next = new Set([...cur].filter((k) => keys.has(k)));
      return next.size === cur.size ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRecs]);

  const visibleRuns = showAllRuns ? filteredRuns : filteredRuns.slice(0, TOP_N);
  const visibleRecs = showAllRecs ? filteredRecs : filteredRecs.slice(0, TOP_N);
  const recKey = (r: RecordingStorageItem) => (r.id != null ? `id:${r.id}` : `file:${r.filePath}`);
  const selectedRunBytes = runs
    .filter((r) => selRuns.has(r.runId))
    .reduce((n, r) => n + r.bytes + r.thumbBytes, 0);
  const selectedRecItems = recs.filter((r) => selRecs.has(recKey(r)));
  const selectedRecBytes = selectedRecItems.reduce((n, r) => n + r.bytes, 0);

  function toggleRun(id: number) {
    setSelRuns((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // "Select all" covers every FILTERED row, not just the visible top-N — so
  // filter → select all → delete works on the whole slice.
  function toggleAllRuns() {
    const ids = filteredRuns.filter((r) => r.status !== 'running' && r.status !== 'queued').map((r) => r.runId);
    const all = ids.length > 0 && ids.every((id) => selRuns.has(id));
    setSelRuns(all ? new Set() : new Set(ids));
  }
  function toggleRec(key: string) {
    setSelRecs((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAllRecs() {
    const keys = filteredRecs.map(recKey);
    const all = keys.length > 0 && keys.every((k) => selRecs.has(k));
    setSelRecs(all ? new Set() : new Set(keys));
  }

  const thumbs = groupByKey.get('thumbs');
  const preview = groupByKey.get('preview');
  const logs = groupByKey.get('logs');

  // ---- Render ------------------------------------------------------------

  return (
    <section className="storage-page">
      <p>
        <Link to="/admin">← Admin</Link>
      </p>
      <h1>Storage</h1>
      <p className="muted">
        Disk usage of the SQLite database and the files under <code>{summary?.dataDir ?? 'data/'}</code>{' '}
        (run screenshots, video recordings, diff images, caches). Delete old or large runs and recordings
        here to free space.
      </p>

      <div className="actions" style={{ marginBottom: 12 }}>
        <button onClick={() => void load()} disabled={loading || busy != null}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {summary && (
          <span className="muted" style={{ alignSelf: 'center' }}>
            Total <strong>{fmtSize(summary.totalBytes)}</strong> · measured {fmtDate(summary.generatedAt)}
          </span>
        )}
      </div>

      {err && <p className="error">{err}</p>}
      {notice && <p className="storage-notice">{notice}</p>}

      {summary && (
        <>
          {/* ---- Overview bar + cards ---- */}
          <div className="storage-bar" title="Share of total disk usage">
            {bar.map((p) => (
              <div
                key={p.key}
                className="storage-bar-seg"
                style={{ width: `${Math.max(p.pct, 0.4)}%`, background: GROUP_COLORS[p.key] ?? '#94a3b8' }}
                title={`${p.label}: ${fmtSize(p.bytes)} (${p.pct.toFixed(1)}%)`}
              />
            ))}
          </div>
          <div className="storage-legend">
            {bar.map((p) => (
              <span key={p.key}>
                <i style={{ background: GROUP_COLORS[p.key] ?? '#94a3b8' }} /> {p.label}{' '}
                <strong>{fmtSize(p.bytes)}</strong>
              </span>
            ))}
          </div>

          <div className="storage-cards">
            <div className="storage-card">
              <div className="storage-card-head">
                <i style={{ background: GROUP_COLORS.db }} />
                <strong>Database</strong>
                <span className="storage-card-size">{fmtSize(dbBytes)}</span>
              </div>
              <div className="muted">
                <code>sqlite.db</code> {fmtSize(summary.db.fileBytes)}
                {summary.db.walBytes > 0 && <> · WAL {fmtSize(summary.db.walBytes)}</>}
                {summary.db.shmBytes > 0 && <> · shm {fmtSize(summary.db.shmBytes)}</>}
              </div>
              <div className="muted">
                {fmtInt(summary.db.pageCount)} pages × {summary.db.pageSize} B ·{' '}
                {fmtInt(summary.db.freePages)} free ({fmtSize(summary.db.reclaimableBytes)} reclaimable)
              </div>
              <div className="muted">Run log text: {fmtSize(summary.db.runLogBytes)}</div>
            </div>
            {summary.groups.map((g) => (
              <div className="storage-card" key={g.key}>
                <div className="storage-card-head">
                  <i style={{ background: GROUP_COLORS[g.key] ?? '#94a3b8' }} />
                  <strong>{g.label}</strong>
                  <span className="storage-card-size">{fmtSize(g.bytes)}</span>
                </div>
                <div className="muted">
                  <code>{g.dir}/</code> · {fmtInt(g.files)} file(s)
                  {g.cache && <> · regenerable cache</>}
                </div>
              </div>
            ))}
          </div>

          {/* ---- Database tables ---- */}
          <details className="storage-details">
            <summary>Database tables ({summary.db.tables.length})</summary>
            <table className="table storage-table-compact">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="num">Rows</th>
                  <th className="num">Size (incl. indexes)</th>
                </tr>
              </thead>
              <tbody>
                {summary.db.tables.map((t) => (
                  <tr key={t.name}>
                    <td><code>{t.name}</code></td>
                    <td className="num">{fmtInt(t.rows)}</td>
                    <td className="num">{fmtSize(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          {/* ---- Maintenance ---- */}
          <h2>Maintenance</h2>
          <div className="storage-maint">
            <MaintRow
              title="Clear thumbnail cache"
              desc={`WebP thumbnails generated for the dashboard/screenshot grids (${fmtSize(thumbs?.bytes)}, ${fmtInt(thumbs?.files)} files). Regenerated on demand.`}
              busy={busy === 'cleanup:thumbs'}
              disabled={busy != null || !thumbs?.files}
              onClick={() => void cleanup('thumbs', 'Thumbnail cache cleared')}
            />
            <MaintRow
              title="Clear live-preview scratch"
              desc={`Temporary JPEG frames from the live preview (${fmtSize(preview?.bytes)}, ${fmtInt(preview?.files)} files).`}
              busy={busy === 'cleanup:preview'}
              disabled={busy != null || !preview?.files}
              onClick={() => void cleanup('preview', 'Preview scratch cleared')}
            />
            <MaintRow
              title="Delete agent-browser logs"
              desc={`Per-session daemon logs (${fmtSize(logs?.bytes)}, ${fmtInt(logs?.files)} files). Logs held open by a live daemon are skipped.`}
              busy={busy === 'cleanup:logs'}
              disabled={busy != null || !logs?.files}
              onClick={() =>
                void cleanup('logs', 'Logs deleted', 'Delete all agent-browser daemon logs? They are only needed for debugging session problems.')
              }
            />
            <MaintRow
              title="Remove orphan screenshot folders"
              desc={`Screenshot folders with no matching run row (${fmtInt(summary.orphans.screenshotDirs)} folder(s), ${fmtSize(summary.orphans.screenshotBytes)}). Also listed in the runs table below as “orphan”.`}
              busy={busy === 'cleanup:orphan-screenshots'}
              disabled={busy != null || !summary.orphans.screenshotDirs}
              danger
              onClick={() => void cleanup('orphan-screenshots', 'Orphan screenshot folders removed', 'Remove all screenshot folders that no run references?')}
            />
            <MaintRow
              title="Remove orphan diff images"
              desc={`Files under diffs/ not referenced by any artifact row (${fmtInt(summary.orphans.diffFiles)} file(s), ${fmtSize(summary.orphans.diffBytes)}).`}
              busy={busy === 'cleanup:orphan-diffs'}
              disabled={busy != null || !summary.orphans.diffFiles}
              danger
              onClick={() => void cleanup('orphan-diffs', 'Orphan diff images removed', 'Remove all diff images that no artifact references?')}
            />
            <MaintRow
              title="Drop recording rows with missing files"
              desc={`Recording entries whose .webm is gone from disk (${fmtInt(summary.orphans.missingRecordingRows)}). Removes the dead entries from the Recordings page.`}
              busy={busy === 'cleanup:missing-recordings'}
              disabled={busy != null || !summary.orphans.missingRecordingRows}
              onClick={() => void cleanup('missing-recordings', 'Dead recording rows removed')}
            />
            <MaintRow
              title="Compact database (VACUUM)"
              desc={`Rebuilds sqlite.db to release free pages and truncates the WAL. About ${fmtSize(summary.db.reclaimableBytes + summary.db.walBytes)} reclaimable. Safe; briefly blocks other writes.`}
              busy={busy === 'cleanup:vacuum'}
              disabled={busy != null}
              onClick={() => void cleanup('vacuum', 'Database compacted')}
            />
          </div>
        </>
      )}

      {/* ---- Filters (apply to both tables below) ---- */}
      <h2>Filters</h2>
      <p className="muted">
        Narrow the runs and recordings tables below; the header checkbox then selects everything that
        matches, so a whole slice can be deleted in one go.
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
                    onClick={() => toggleIn(selectedBrands, b, setSelectedBrands)}
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
                    onClick={() => toggleIn(selectedTypes, t, setSelectedTypes)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="filter-group">
            <div className="filter-group-label">Status</div>
            <div className="chip-row">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={`chip${selectedStatus.has(s.value) ? ' chip-on' : ''}`}
                  title={s.title}
                  onClick={() => toggleIn(selectedStatus, s.value, setSelectedStatus)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <div className="filter-group-label">Older than</div>
            <div className="chip-row">
              {AGE_FILTERS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip${olderThanDays === d ? ' chip-on' : ''}`}
                  onClick={() => setOlderThanDays(olderThanDays === d ? null : d)}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <div className="filter-group-label">Larger than</div>
            <div className="chip-row">
              {SIZE_FILTERS.map((s) => (
                <button
                  key={s.bytes}
                  type="button"
                  className={`chip${minBytes === s.bytes ? ' chip-on' : ''}`}
                  onClick={() => setMinBytes(minBytes === s.bytes ? null : s.bytes)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button type="button" className="filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </details>

      {/* ---- Runs by size ---- */}
      <h2>Runs by disk usage</h2>
      <p className="muted">
        Screenshot folders per run, largest first. Deleting a run removes its row and screenshots;
        recordings are kept (delete them below).
        {activeFilterCount > 0 && (
          <>
            {' '}Showing <strong>{fmtInt(filteredRuns.length)}</strong> of {fmtInt(runs.length)} runs
            ({fmtSize(filteredRunBytes)}).
          </>
        )}
      </p>
      <div className="actions">
        <button
          className="btn-danger"
          disabled={busy != null || selRuns.size === 0}
          onClick={() => void deleteRunIds([...selRuns], `${fmtInt(selRuns.size)} selected run(s)`)}
        >
          {busy === 'runs:delete' ? 'Deleting…' : `Delete selected (${fmtInt(selRuns.size)}, ${fmtSize(selectedRunBytes)})`}
        </button>
        {filteredRuns.length > TOP_N && (
          <button onClick={() => setShowAllRuns((v) => !v)}>
            {showAllRuns ? `Show top ${TOP_N}` : `Show all ${fmtInt(filteredRuns.length)}`}
          </button>
        )}
      </div>
      {!loading && filteredRuns.length === 0 ? (
        <p className="muted">{runs.length === 0 ? 'No runs.' : 'No runs match the current filters.'}</p>
      ) : (
        <div className="storage-table-wrap">
          <table className="table storage-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all (filtered)"
                    title="Select all (filtered)"
                    checked={filteredRuns.length > 0 && filteredRuns.every((r) => selRuns.has(r.runId) || r.status === 'running' || r.status === 'queued')}
                    onChange={toggleAllRuns}
                  />
                </th>
                <th>Run</th>
                <th>Scenario</th>
                <th>Started</th>
                <th>Status</th>
                <th className="num">Screenshots</th>
                <th className="num">Files</th>
                <th className="num">Thumbs</th>
                <th className="num">Log</th>
                <th className="num">Recordings</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((r) => {
                const live = r.status === 'running' || r.status === 'queued';
                return (
                  <tr key={r.runId} className={r.orphan ? 'storage-orphan' : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selRuns.has(r.runId)}
                        disabled={live}
                        onChange={() => toggleRun(r.runId)}
                      />
                    </td>
                    <td>#{r.runId}</td>
                    <td>
                      {r.orphan ? (
                        <span className="muted">orphan folder (no run row)</span>
                      ) : (
                        <>
                          {r.scenarioName ?? <span className="muted">(deleted scenario)</span>}
                          {(r.brand || r.type) && (
                            <span className="muted"> · {[r.brand, r.type].filter(Boolean).join(' / ')}</span>
                          )}
                        </>
                      )}
                    </td>
                    <td>{fmtDate(r.startedAt)}</td>
                    <td>
                      {r.status ? <span className={`status status-${r.status}`}>{r.status}</span> : '—'}
                    </td>
                    <td className="num"><strong>{fmtSize(r.bytes)}</strong></td>
                    <td className="num">{fmtInt(r.files)}</td>
                    <td className="num">{fmtSize(r.thumbBytes)}</td>
                    <td className="num">{fmtSize(r.logBytes)}</td>
                    <td className="num">{r.recordingBytes ? fmtSize(r.recordingBytes) : '—'}</td>
                    <td>
                      <button
                        className="btn-danger"
                        disabled={busy != null || live}
                        title={live ? 'Run is still in progress' : 'Delete this run and its screenshots'}
                        onClick={() => void deleteRunIds([r.runId], `run #${r.runId}`)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Recordings by size ---- */}
      <h2>Recordings by disk usage</h2>
      <p className="muted">
        Video files, largest first. Files on disk without a database row are marked “orphan”.
        {activeFilterCount > 0 && (
          <>
            {' '}Showing <strong>{fmtInt(filteredRecs.length)}</strong> of {fmtInt(recs.length)} recordings
            ({fmtSize(filteredRecBytes)}).
          </>
        )}
      </p>
      <div className="actions">
        <button
          className="btn-danger"
          disabled={busy != null || selectedRecItems.length === 0}
          onClick={() => void deleteRecItems(selectedRecItems, `${fmtInt(selectedRecItems.length)} selected recording(s)`)}
        >
          {busy === 'recs:delete'
            ? 'Deleting…'
            : `Delete selected (${fmtInt(selectedRecItems.length)}, ${fmtSize(selectedRecBytes)})`}
        </button>
        {filteredRecs.length > TOP_N && (
          <button onClick={() => setShowAllRecs((v) => !v)}>
            {showAllRecs ? `Show top ${TOP_N}` : `Show all ${fmtInt(filteredRecs.length)}`}
          </button>
        )}
      </div>
      {!loading && filteredRecs.length === 0 ? (
        <p className="muted">{recs.length === 0 ? 'No recordings.' : 'No recordings match the current filters.'}</p>
      ) : (
        <div className="storage-table-wrap">
          <table className="table storage-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all (filtered)"
                    title="Select all (filtered)"
                    checked={filteredRecs.length > 0 && filteredRecs.every((r) => selRecs.has(recKey(r)))}
                    onChange={toggleAllRecs}
                  />
                </th>
                <th>Recording</th>
                <th>Scenario</th>
                <th>Run</th>
                <th>Created</th>
                <th>File</th>
                <th className="num">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleRecs.map((r) => {
                const key = recKey(r);
                return (
                  <tr key={key} className={r.orphan || r.missing ? 'storage-orphan' : undefined}>
                    <td>
                      <input type="checkbox" checked={selRecs.has(key)} onChange={() => toggleRec(key)} />
                    </td>
                    <td>{r.id != null ? `#${r.id}` : <span className="muted">orphan file</span>}</td>
                    <td>
                      {r.scenarioName ?? (
                        <span className="muted">{r.scenarioId != null ? `scenario ${r.scenarioId}` : '—'}</span>
                      )}
                      {(r.brand || r.type) && (
                        <span className="muted"> · {[r.brand, r.type].filter(Boolean).join(' / ')}</span>
                      )}
                    </td>
                    <td>{r.runId != null ? `#${r.runId}` : '—'}</td>
                    <td>{fmtDate(r.createdAt)}</td>
                    <td className="storage-file">
                      <code title={r.filePath}>{r.filePath.split('/').pop()}</code>
                      {r.missing && <span className="error"> (file missing)</span>}
                    </td>
                    <td className="num"><strong>{fmtSize(r.bytes)}</strong></td>
                    <td>
                      <button
                        className="btn-danger"
                        disabled={busy != null}
                        onClick={() => void deleteRecItems([r], r.id != null ? `recording #${r.id}` : r.filePath)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MaintRow(props: {
  title: string;
  desc: string;
  busy: boolean;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="storage-maint-row">
      <div>
        <strong>{props.title}</strong>
        <div className="muted">{props.desc}</div>
      </div>
      <div className="storage-maint-actions">
        <button className={props.danger ? 'btn-danger' : undefined} onClick={props.onClick} disabled={props.disabled}>
          {props.busy ? 'Working…' : 'Run'}
        </button>
      </div>
    </div>
  );
}

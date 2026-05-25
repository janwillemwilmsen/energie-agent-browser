import { useEffect, useMemo, useState } from 'react';
import { api, type Artifact, type Comparison } from '../lib/api.js';

function pct(ratio: number | null): string {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(2)}%`;
}

function statusClass(status: Comparison['status']): string {
  if (status === 'ok') return 'status-success';
  if (status === 'size_mismatch') return 'status-queued';
  return 'status-failed';
}

// Leading NNN of the slot label (e.g. "002-cart-desktop.png" -> 2) so per-run
// screenshots sort in scenario step order.
function slotPosition(c: Comparison): number {
  const label = c.baseline?.label ?? c.target?.label ?? c.diff?.label ?? '';
  const m = /^(\d+)/.exec(label);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

interface DiffGroup {
  key: string;
  scenarioId: number | null;
  baselineRunId: number | null;
  targetRunId: number | null;
  comparisons: Comparison[];
}

export function Diffs() {
  const [items, setItems] = useState<Comparison[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Up to two artifacts staged for a new (re-)comparison.
  const [selection, setSelection] = useState<Artifact[]>([]);
  // Source runs that still exist, so we know whether "Delete run" is offered.
  const [liveRunIds, setLiveRunIds] = useState<Set<number>>(new Set());
  const [scenarioNames, setScenarioNames] = useState<Map<number, string>>(new Map());

  async function load() {
    try {
      const [comparisons, runs, scenarios] = await Promise.all([
        api.listComparisons(),
        api.listRuns(),
        api.listScenarios(),
      ]);
      setItems(comparisons);
      setLiveRunIds(new Set(runs.map((r) => r.id)));
      setScenarioNames(new Map(scenarios.map((s) => [s.id, s.name])));
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Group comparisons that share the same (baseline run -> target run) pair.
  // Comparisons without a clean run pair (e.g. a diff-of-diffs) stand alone.
  const groups = useMemo<DiffGroup[]>(() => {
    const map = new Map<string, DiffGroup>();
    for (const c of items) {
      const b = c.baseline?.source_run_id ?? null;
      const t = c.target?.source_run_id ?? null;
      const key = b != null && t != null ? `pair:${b}->${t}` : `solo:${c.id}`;
      let g = map.get(key);
      if (!g) {
        g = { key, scenarioId: c.scenario_id, baselineRunId: b, targetRunId: t, comparisons: [] };
        map.set(key, g);
      }
      g.comparisons.push(c);
    }
    const out = Array.from(map.values());
    for (const g of out) g.comparisons.sort((a, b) => slotPosition(a) - slotPosition(b));
    // Newest run-pairs first (highest comparison id in the group).
    out.sort((a, b) => maxId(b.comparisons) - maxId(a.comparisons));
    return out;
  }, [items]);

  async function deleteRun(runId: number) {
    if (
      !confirm(
        `Delete run #${runId} and its screenshots? Existing diffs keep their own copies and stay viewable.`,
      )
    )
      return;
    try {
      await api.deleteRun(runId);
      setLiveRunIds((cur) => {
        const next = new Set(cur);
        next.delete(runId);
        return next;
      });
    } catch (e: any) {
      setErr(e.message);
    }
  }

  function toggleSelect(a: Artifact) {
    setSelection((cur) => {
      if (cur.some((x) => x.id === a.id)) return cur.filter((x) => x.id !== a.id);
      if (cur.length >= 2) return [cur[1]!, a];
      return [...cur, a];
    });
  }

  const isSelected = (id: number) => selection.some((x) => x.id === id);

  async function compareSelected() {
    if (selection.length !== 2) return;
    setBusy(true);
    setErr(null);
    try {
      const [baseline, target] = selection;
      await api.createComparison({
        scenarioId: baseline!.scenario_id ?? undefined,
        baseline: { artifactId: baseline!.id },
        target: { artifactId: target!.id },
      });
      setSelection([]);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm(`Delete comparison #${id}?`)) return;
    try {
      await api.deleteComparison(id);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  function deleteRunButton(kind: 'baseline' | 'target', runId: number | null) {
    if (runId == null) return null;
    if (!liveRunIds.has(runId)) {
      return <span className="muted diff-run-deleted">{kind} run #{runId} deleted</span>;
    }
    return (
      <button
        className="diff-del-run"
        title={`Delete the ${kind} run + its screenshots (these diffs are kept)`}
        onClick={() => deleteRun(runId)}
      >
        Delete {kind} run #{runId}
      </button>
    );
  }

  return (
    <section>
      <h1>Diffs</h1>
      <p className="muted">
        Visual comparisons of run screenshots, grouped per run pair. Select two images (baseline,
        target, or a previous diff) to compare them — diffs can themselves be diffed again.
      </p>
      {err && <p className="error">{err}</p>}

      {selection.length > 0 && (
        <div className="diff-tray">
          <span>
            {selection.length === 1 ? '1 image selected — pick one more.' : '2 images selected.'}
          </span>
          {selection.map((a) => (
            <img key={a.id} className="diff-tray-thumb" src={api.artifactImageUrl(a.id)} alt="" />
          ))}
          <button onClick={compareSelected} disabled={selection.length !== 2 || busy}>
            {busy ? 'Comparing…' : 'Compare these 2'}
          </button>
          <button className="diff-tray-clear" onClick={() => setSelection([])}>
            Clear
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="muted">
          No comparisons yet. Go to the Runs page, select two runs of the same scenario, and click
          “Compare runs”.
        </p>
      ) : (
        <div className="diff-groups">
          {groups.map((g) => {
            const total = g.comparisons.length;
            const changed = g.comparisons.filter((c) => (c.mismatch_ratio ?? 0) > 0).length;
            const maxRatio = Math.max(0, ...g.comparisons.map((c) => c.mismatch_ratio ?? 0));
            const isPair = g.baselineRunId != null && g.targetRunId != null;
            const scenarioLabel =
              g.scenarioId != null
                ? scenarioNames.get(g.scenarioId) ?? `Scenario #${g.scenarioId}`
                : null;
            return (
              <div key={g.key} className="diff-group">
                <div className="diff-group-head">
                  {scenarioLabel && <strong>{scenarioLabel}</strong>}
                  <span className="diff-group-pair">
                    {isPair ? `run #${g.baselineRunId} → run #${g.targetRunId}` : 'ad-hoc comparison'}
                  </span>
                  <span className="muted">
                    {total} screenshot{total === 1 ? '' : 's'} · {changed} changed · max{' '}
                    {pct(maxRatio)}
                  </span>
                  <span className="diff-group-actions">
                    {deleteRunButton('baseline', g.baselineRunId)}
                    {deleteRunButton('target', g.targetRunId)}
                  </span>
                </div>

                <div className="diff-list">
                  {g.comparisons.map((c) => (
                    <div key={c.id} className="diff-card">
                      <div className="diff-card-head">
                        <span className={`status ${statusClass(c.status)}`}>{c.status}</span>
                        <strong>{pct(c.mismatch_ratio)} changed</strong>
                        {c.baseline?.label && <code>{c.baseline.label}</code>}
                        <span className="muted">#{c.id}</span>
                        <button
                          className="step-del"
                          title="Delete comparison"
                          onClick={() => remove(c.id)}
                        >
                          ×
                        </button>
                      </div>
                      {c.note && <p className="muted diff-note">{c.note}</p>}
                      <div className="diff-images">
                        <DiffImage
                          title="Baseline"
                          artifact={c.baseline}
                          selected={c.baseline ? isSelected(c.baseline.id) : false}
                          onToggle={toggleSelect}
                        />
                        <DiffImage
                          title="Target"
                          artifact={c.target}
                          selected={c.target ? isSelected(c.target.id) : false}
                          onToggle={toggleSelect}
                        />
                        <DiffImage
                          title="Diff"
                          artifact={c.diff}
                          selected={c.diff ? isSelected(c.diff.id) : false}
                          onToggle={toggleSelect}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function maxId(comparisons: Comparison[]): number {
  return comparisons.reduce((m, c) => Math.max(m, c.id), 0);
}

function DiffImage({
  title,
  artifact,
  selected,
  onToggle,
}: {
  title: string;
  artifact: Artifact | null;
  selected: boolean;
  onToggle: (a: Artifact) => void;
}) {
  return (
    <figure className={`diff-figure${selected ? ' selected' : ''}`}>
      <figcaption>
        {title}
        {artifact && (
          <button className="diff-pick" onClick={() => onToggle(artifact)}>
            {selected ? '✓ selected' : 'select'}
          </button>
        )}
      </figcaption>
      {artifact ? (
        <img src={api.artifactImageUrl(artifact.id)} alt={title} />
      ) : (
        <div className="diff-missing">missing</div>
      )}
    </figure>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Artifact, type Comparison, type ComparisonRun, type Scenario } from '../lib/api.js';
import { useResource } from '../lib/resource.js';
import { matchesTags, NO_TAGS, TagFilter, tagsActive, tagValues, type TagSelection } from '../lib/TagFilter.js';

// One <details> per run pair: the summary line carries scenario, both runs
// with their dates, and the change figures; the screenshots unfold on demand
// so a long history stays scannable. Baseline is the run the comparison was
// made against (the older run when made by Auto diff; the first-picked run
// on the Runs page) — the dates make that visible.

function pct(ratio: number | null): string {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(2)}%`;
}

function statusClass(status: Comparison['status']): string {
  if (status === 'ok') return 'status-success';
  if (status === 'size_mismatch') return 'status-queued';
  return 'status-failed';
}

// Order within a run: the slot name starts with the capture stamp (older files:
// the step position), so a plain string compare on the baseline's name is
// capture order either way.
function slotOrder(c: Comparison): string {
  return c.baseline?.label ?? c.target?.label ?? c.diff?.label ?? '';
}

interface DiffGroup {
  key: string;
  scenarioId: number | null;
  baselineRunId: number | null;
  targetRunId: number | null;
  /** The runs as they are now; null when deleted since. */
  baselineRun: ComparisonRun | null;
  targetRun: ComparisonRun | null;
  comparisons: Comparison[];
}

export function Diffs() {
  const [busy, setBusy] = useState(false);
  // Brand / Type of the scenario behind each pair.
  const [tags, setTags] = useState<TagSelection>(NO_TAGS);

  const { data, error: err, setError: setErr, refresh: load } = useResource(
    async () => {
      const [comparisons, scenarios] = await Promise.all([api.listComparisons(), api.listScenarios()]);
      return { items: comparisons, scenarios: new Map(scenarios.map((s) => [s.id, s])) };
    },
    { initial: { items: [] as Comparison[], scenarios: new Map<number, Scenario>() } },
  );
  const { items, scenarios } = data;
  const allScenarios = useMemo(() => Array.from(scenarios.values()), [scenarios]);
  const brands = useMemo(() => tagValues(allScenarios, 'brand'), [allScenarios]);
  const types = useMemo(() => tagValues(allScenarios, 'type'), [allScenarios]);

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
        g = {
          key, scenarioId: c.scenario_id, baselineRunId: b, targetRunId: t,
          baselineRun: c.baseline_run, targetRun: c.target_run, comparisons: [],
        };
        map.set(key, g);
      }
      g.comparisons.push(c);
    }
    const out = Array.from(map.values());
    for (const g of out) g.comparisons.sort((a, b) => slotOrder(a).localeCompare(slotOrder(b)));
    // Newest run-pairs first (highest comparison id in the group).
    out.sort((a, b) => maxId(b.comparisons) - maxId(a.comparisons));
    return out;
  }, [items]);
  // The tag filter works on the pair's scenario; an ad-hoc pair without one
  // only shows while no filter is active.
  const shown = useMemo(
    () => tagsActive(tags) === 0
      ? groups
      : groups.filter((g) => g.scenarioId != null && matchesTags(scenarios.get(g.scenarioId) ?? {}, tags)),
    [groups, scenarios, tags],
  );

  async function deleteRun(runId: number) {
    if (!confirm(`Delete run #${runId} with its screenshots, texts and video recording?\n\nThe diffs keep their own copies and stay viewable.`)) return;
    try {
      await api.deleteRun(runId);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function removeOne(id: number) {
    if (!confirm(`Delete this diff (#${id})?\n\nThe runs and their screenshots are not touched.`)) return;
    try {
      await api.deleteComparison(id);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function removeGroup(g: DiffGroup) {
    const n = g.comparisons.length;
    if (!confirm(`Delete ${n === 1 ? 'this diff result' : `these ${n} diff results`}?\n\nThe runs and their screenshots are not touched.`)) return;
    setBusy(true);
    try {
      for (const c of g.comparisons) await api.deleteComparison(c.id);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Diffs</h1>
      <p className="muted">
        Select two runs to compare screenshots on the <Link className="link" to="/runs">Runs</Link> page, or turn on
        Auto diff in the scenario settings.
      </p>
      {err && <p className="error">{err}</p>}

      {items.length > 0 && <TagFilter brands={brands} types={types} selection={tags} onChange={setTags} />}
      {items.length > 0 && tagsActive(tags) > 0 && (
        <p className="muted" aria-live="polite">
          {shown.length} of {groups.length} run pair{groups.length === 1 ? '' : 's'} match the filter.
        </p>
      )}

      {items.length === 0 ? (
        <p className="muted">No comparisons yet.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No run pairs match the current filters.</p>
      ) : (
        <div className="diff-groups">
          {shown.map((g, i) => {
            const total = g.comparisons.length;
            const changed = g.comparisons.filter((c) => (c.mismatch_ratio ?? 0) > 0).length;
            const maxRatio = Math.max(0, ...g.comparisons.map((c) => c.mismatch_ratio ?? 0));
            const isPair = g.baselineRunId != null && g.targetRunId != null;
            const scenario = g.scenarioId != null ? scenarios.get(g.scenarioId) : undefined;
            const scenarioLabel =
              g.scenarioId != null ? scenario?.name ?? `Scenario #${g.scenarioId}` : 'ad-hoc';
            const newerBaseline =
              g.baselineRun && g.targetRun && g.baselineRun.started_at > g.targetRun.started_at;
            return (
              // all closed by default; the rest unfold on click.
              <details key={g.key} className="diff-group">
                <summary className="diff-group-summary">
                  <strong>{scenarioLabel}</strong>
                  {scenario?.brand && <span className="tag tag-brand">{scenario.brand}</span>}
                  {scenario?.type && <span className="tag tag-type">{scenario.type}</span>}
                  {isPair ? (
                    <span className="diff-group-pair">
                      <RunRef kind="baseline" id={g.baselineRunId!} run={g.baselineRun} />
                      <span className="muted"> → </span>
                      <RunRef kind="target" id={g.targetRunId!} run={g.targetRun} />
                    </span>
                  ) : (
                    <span className="diff-group-pair">ad-hoc comparison</span>
                  )}
                  <span className={changed > 0 ? 'diff-group-changed' : 'muted'}>
                    {total} screenshot{total === 1 ? '' : 's'} · {changed === 0 ? 'no changes' : `${changed} changed`} · max {pct(maxRatio)}
                  </span>
                </summary>

                <div className="diff-group-actions">
                  {newerBaseline && (
                    <span className="muted">baseline is the newer run here (compared the other way round)</span>
                  )}
                  <span className="diff-group-actions-right">
                    <RunDeleteButton kind="baseline" id={g.baselineRunId} run={g.baselineRun} onDelete={deleteRun} />
                    <RunDeleteButton kind="target" id={g.targetRunId} run={g.targetRun} onDelete={deleteRun} />
                    <button
                      className="diff-del-group"
                      disabled={busy}
                      title="Remove these diff results (the runs and their screenshots stay)"
                      onClick={() => void removeGroup(g)}
                    >
                      Delete diff results
                    </button>
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
                        <button className="step-del" title="Delete this diff" onClick={() => void removeOne(c.id)}>
                          ×
                        </button>
                      </div>
                      {c.note && <p className="muted diff-note">{c.note}</p>}
                      <div className="diff-images">
                        <DiffImage title={`Baseline · run #${g.baselineRunId ?? '?'}`} artifact={c.baseline} />
                        <DiffImage title={`Target · run #${g.targetRunId ?? '?'}`} artifact={c.target} />
                        <DiffImage title="Diff" artifact={c.diff} />
                      </div>
                    </div>
                  ))}
                </div>
              </details>
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

// "baseline run #12 · 2026-10-07 07:00" — or "(deleted)" when the run is gone.
function RunRef({ kind, id, run }: { kind: 'baseline' | 'target'; id: number; run: ComparisonRun | null }) {
  return (
    <span title={run ? `${kind} run #${id}, started ${run.started_at} (${run.status})` : `${kind} run #${id} has been deleted; the diff keeps its copy`}>
      <span className="muted">{kind} </span>run #{id}
      {run ? <span className="muted"> · {run.started_at.slice(0, 16)}</span> : <span className="muted"> (deleted)</span>}
    </span>
  );
}

function RunDeleteButton({
  kind, id, run, onDelete,
}: { kind: 'baseline' | 'target'; id: number | null; run: ComparisonRun | null; onDelete: (id: number) => void }) {
  if (id == null || !run) return null;
  return (
    <button
      className="diff-del-run"
      title={`Delete the ${kind} run #${id} (${run.started_at}) with its screenshots, texts and video recording — these diffs stay`}
      onClick={() => onDelete(id)}
    >
      Delete {kind} run #{id}
    </button>
  );
}

function DiffImage({ title, artifact }: { title: string; artifact: Artifact | null }) {
  return (
    <figure className="diff-figure">
      <figcaption>{title}</figcaption>
      {artifact ? (
        <a href={api.artifactImageUrl(artifact.id)} target="_blank" rel="noreferrer" title="Open full size">
          <img src={api.artifactImageUrl(artifact.id)} alt={title} loading="lazy" />
        </a>
      ) : (
        <div className="diff-missing">missing</div>
      )}
    </figure>
  );
}

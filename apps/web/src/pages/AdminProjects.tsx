import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, Scenario } from '@eab/shared';
import { api } from '../lib/api.js';
import { useProject } from '../lib/project.js';
import { useResource } from '../lib/resource.js';

// Admin → Projects: create, rename, recolour and reorder projects, delete an
// empty one, and move scenarios between projects — by brand/type in bulk
// (how an existing instance gets split up) or one by one.

const SWATCHES = ['#38bdf8', '#34d399', '#fbbf24', '#c084fc', '#a3e635', '#fb923c', '#f472b6', '#94a3b8'];

export function AdminProjects() {
  const { projects, refresh: refreshProjects, projectId: activeId, setProjectId } = useProject();
  const { data: scenarios, refresh: refreshScenarios, error: loadError } = useResource(() => api.listAllScenarios(), {
    initial: [] as Scenario[],
  });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      await Promise.all([refreshProjects(), refreshScenarios()]);
      setNote(label);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  // --- create ---
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(SWATCHES[0]!);

  // --- move ---
  const brands = useMemo(() => distinct(scenarios.map((s) => s.brand)), [scenarios]);
  const types = useMemo(() => distinct(scenarios.map((s) => s.type)), [scenarios]);
  const [moveBy, setMoveBy] = useState<'brand' | 'type' | 'scenario'>('brand');
  const [moveValue, setMoveValue] = useState('');
  const [moveTarget, setMoveTarget] = useState<number | ''>('');
  useEffect(() => { setMoveValue(''); }, [moveBy]);
  const moveCount = useMemo(() => {
    if (!moveValue) return 0;
    if (moveBy === 'brand') return scenarios.filter((s) => s.brand === moveValue).length;
    if (moveBy === 'type') return scenarios.filter((s) => s.type === moveValue).length;
    return 1;
  }, [scenarios, moveBy, moveValue]);

  const byProject = useMemo(() => {
    const m = new Map<number, Scenario[]>();
    for (const s of scenarios) (m.get(s.project_id) ?? m.set(s.project_id, []).get(s.project_id)!).push(s);
    return m;
  }, [scenarios]);

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">Admin</Link> / Projects</p>
      <h1>Projects</h1>
      <p className="muted">
        A project separates topics and brands: the switcher at the top of every page shows one project's
        scenarios, runs, screenshots, schedules and threads. Brand and Type stay as tags inside a project.
        Preflights are shared across projects unless a project is set on them.
      </p>
      {(error || loadError) && <p className="error">{error ?? loadError}</p>}
      {note && <p className="muted">{note}</p>}

      <table className="projects-table">
        <thead>
          <tr>
            <th></th>
            <th>Project</th>
            <th>Scenarios</th>
            <th>Schedules</th>
            <th>Preflights</th>
            <th>Last run</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p, i) => (
            <ProjectRow
              key={p.id}
              project={p}
              scenarios={byProject.get(p.id) ?? []}
              active={activeId === p.id}
              first={i === 0}
              last={i === projects.length - 1}
              busy={busy}
              onOpen={() => setProjectId(p.id)}
              onSave={(body) => act(`Saved ${body.name ?? p.name}.`, () => api.updateProject(p.id, body))}
              onMove={(dir) => {
                const order = projects.map((x) => x.id);
                const j = i + dir;
                if (j < 0 || j >= order.length) return;
                [order[i], order[j]] = [order[j]!, order[i]!];
                void act('Order saved.', () => api.reorderProjects(order));
              }}
              onDelete={() => {
                if (!confirm(`Delete project "${p.name}"? It must be empty.`)) return;
                void act(`Deleted ${p.name}.`, async () => {
                  await api.deleteProject(p.id);
                  if (activeId === p.id) setProjectId(null);
                });
              }}
            />
          ))}
        </tbody>
      </table>

      <div className="card projects-card">
        <h3>New project</h3>
        <form
          className="projects-form"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            void act(`Created ${name}.`, async () => {
              await api.createProject({ name, color: newColor });
              setNewName('');
            });
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name, e.g. Essent" maxLength={80} />
          <ColorPicker value={newColor} onChange={setNewColor} />
          <button type="submit" disabled={busy || !newName.trim()}>Create</button>
        </form>
      </div>

      <div className="card projects-card">
        <h3>Move scenarios</h3>
        <p className="muted">
          Everything that hangs off a scenario (runs, screenshots, diffs, recordings) moves with it. A schedule
          moves when its whole chain ends up in one project; a chain that would span two is left where it is
          and reported.
        </p>
        <form
          className="projects-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (moveTarget === '' || !moveValue) return;
            const target = projects.find((p) => p.id === moveTarget)!;
            void act('', async () => {
              const r = await api.moveScenariosToProject(
                moveTarget,
                moveBy === 'scenario' ? { scenario_ids: [Number(moveValue)] } : moveBy === 'brand' ? { brand: moveValue } : { type: moveValue },
              );
              setMoveValue('');
              setNote(
                `Moved ${r.moved} scenario${r.moved === 1 ? '' : 's'} to ${target.name}` +
                (r.schedules.updated.length ? `, ${r.schedules.updated.length} schedule${r.schedules.updated.length === 1 ? '' : 's'} followed` : '') +
                (r.schedules.mixed.length ? `; schedule${r.schedules.mixed.length === 1 ? '' : 's'} #${r.schedules.mixed.join(', #')} now span${r.schedules.mixed.length === 1 ? 's' : ''} projects — edit the chain` : '') +
                '.',
              );
            });
          }}
        >
          <select value={moveBy} onChange={(e) => setMoveBy(e.target.value as typeof moveBy)} title="Pick scenarios by">
            <option value="brand">every scenario with brand</option>
            <option value="type">every scenario with type</option>
            <option value="scenario">one scenario</option>
          </select>
          <select value={moveValue} onChange={(e) => setMoveValue(e.target.value)} title="Which">
            <option value="">—</option>
            {moveBy === 'brand' && brands.map((b) => <option key={b} value={b}>{b} ({scenarios.filter((s) => s.brand === b).length})</option>)}
            {moveBy === 'type' && types.map((t) => <option key={t} value={t}>{t} ({scenarios.filter((s) => s.type === t).length})</option>)}
            {moveBy === 'scenario' && [...scenarios].sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {projects.find((p) => p.id === s.project_id)?.name ?? '?'}</option>
            ))}
          </select>
          <span className="muted">→</span>
          <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value === '' ? '' : Number(e.target.value))} title="Target project">
            <option value="">project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="submit" disabled={busy || moveTarget === '' || !moveValue}>
            Move{moveCount ? ` ${moveCount}` : ''}
          </button>
        </form>
      </div>
    </section>
  );
}

function ProjectRow({
  project: p, scenarios, active, first, last, busy, onOpen, onSave, onMove, onDelete,
}: {
  project: Project;
  scenarios: Scenario[];
  active: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onOpen: () => void;
  onSave: (body: { name?: string; color?: string | null }) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [color, setColor] = useState(p.color ?? '');
  useEffect(() => { setName(p.name); setColor(p.color ?? ''); }, [p.name, p.color]);
  const empty = !(p.scenario_count || p.schedule_count);
  return (
    <tr className={active ? 'projects-row-active' : undefined}>
      <td><span className="project-dot" style={{ background: p.color ?? 'var(--border)' }} aria-hidden /></td>
      <td>
        {editing ? (
          <form
            className="projects-inline"
            onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim() || p.name, color: color || null }); setEditing(false); }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            <ColorPicker value={color} onChange={setColor} allowNone />
            <button type="submit" disabled={busy}>Save</button>
            <button type="button" className="scenario-meta-cancel" onClick={() => { setEditing(false); setName(p.name); setColor(p.color ?? ''); }}>Cancel</button>
          </form>
        ) : (
          <>
            <strong>{p.name}</strong>
            {p.id === 1 && <span className="muted"> · default</span>}
            {active && <span className="muted"> · active</span>}
            {scenarios.length > 0 && (
              <div className="muted projects-names" title={scenarios.map((s) => s.name).join('\n')}>
                {scenarios.slice(0, 4).map((s) => s.name).join(' · ')}{scenarios.length > 4 ? ` · +${scenarios.length - 4}` : ''}
              </div>
            )}
          </>
        )}
      </td>
      <td>{p.scenario_count ?? 0}</td>
      <td>{p.schedule_count ?? 0}</td>
      <td>{p.preflight_count ?? 0}</td>
      <td className="muted">{p.last_run_at ? p.last_run_at.slice(0, 16) : '—'}</td>
      <td className="projects-actions">
        <button type="button" className="chip" onClick={onOpen} disabled={active} title="Switch the app to this project">open</button>
        <button type="button" className="chip" onClick={() => setEditing(true)} disabled={editing}>rename</button>
        <button type="button" className="chip" onClick={() => onMove(-1)} disabled={first || busy} title="Move up in the switcher">↑</button>
        <button type="button" className="chip" onClick={() => onMove(1)} disabled={last || busy} title="Move down in the switcher">↓</button>
        <button
          type="button"
          className="chip"
          onClick={onDelete}
          disabled={busy || p.id === 1 || !empty}
          title={p.id === 1 ? 'The default project stays' : empty ? 'Delete this empty project' : 'Move its scenarios and schedules out first'}
        >
          delete
        </button>
      </td>
    </tr>
  );
}

function ColorPicker({ value, onChange, allowNone }: { value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <span className="projects-swatches" role="radiogroup" aria-label="Colour">
      {allowNone && (
        <button type="button" role="radio" aria-checked={value === ''} className={`projects-swatch${value === '' ? ' on' : ''}`}
          style={{ background: 'transparent' }} onClick={() => onChange('')} title="No colour">×</button>
      )}
      {SWATCHES.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} className={`projects-swatch${value === c ? ' on' : ''}`}
          style={{ background: c }} onClick={() => onChange(c)} title={c} />
      ))}
    </span>
  );
}

function distinct(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v && v.trim() !== ''))).sort((a, b) => a.localeCompare(b));
}

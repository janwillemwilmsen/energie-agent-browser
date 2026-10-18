import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Settings2 } from 'lucide-react';
import { useProject } from './project.js';

// The project switcher at the top of every page: which project the app is
// scoped to, with "All projects" as the unscoped view. Ctrl/⌘+P focuses it.

export function ProjectSwitcher() {
  const { projects, projectId, project, setProjectId, loaded } = useProject();
  const ref = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const count = project?.scenario_count;
  const scenarios = projects.reduce((n, p) => n + (p.scenario_count ?? 0), 0);

  return (
    <div className="project-bar">
      <span className="project-dot" style={{ background: project?.color ?? 'var(--accent)' }} aria-hidden>
        {!project && <FolderKanban size={12} />}
      </span>
      <label className="project-switcher">
        <span className="sr-only">Project</span>
        <select
          ref={ref}
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value === '' ? null : Number(e.target.value))}
          title="Which project the app shows (Ctrl/⌘+P)"
          disabled={!loaded}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <span className="muted project-meta">
        {project
          ? `${count ?? 0} scenario${count === 1 ? '' : 's'}${project.last_run_at ? ` · last run ${formatAgo(project.last_run_at)}` : ''}`
          : loaded ? `${projects.length} project${projects.length === 1 ? '' : 's'} · ${scenarios} scenario${scenarios === 1 ? '' : 's'}` : ''}
      </span>
      <Link to="/admin/projects" className="project-manage" title="Manage projects">
        <Settings2 size={15} aria-hidden />
      </Link>
    </div>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

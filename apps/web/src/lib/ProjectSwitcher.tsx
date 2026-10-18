import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FolderKanban, Settings2 } from 'lucide-react';
import { useProject } from './project.js';

// The project switcher: a small box at the top right of every page that
// shows project-scoped data — which project the app is scoped to, with
// "All projects" as the unscoped view. Not on the admin and docs pages,
// which are global. Ctrl/⌘+P focuses it.

const HIDDEN_PREFIXES = ['/admin', '/docs'];

export function ProjectSwitcher() {
  const { projects, projectId, project, setProjectId, loaded } = useProject();
  const { pathname } = useLocation();
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

  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return null;

  return (
    <div className="project-bar">
      <div className="project-box" title={project ? `Project: ${project.name}` : 'All projects'}>
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
        <Link to="/admin/projects" className="project-manage" title="Manage projects">
          <Settings2 size={15} aria-hidden />
        </Link>
      </div>
    </div>
  );
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Project } from '@eab/shared';
import { api } from './api.js';
import { activeProjectId, setActiveProjectId } from './projectScope.js';

// The project scope of the UI: which project the switcher has selected (null
// = all projects), the list to choose from, and the setter. The request
// layer reads the same value through lib/projectScope.ts, so every API call
// made while a project is active is scoped to it; the app shell remounts the
// page on a change so each page refetches.

interface ProjectContextValue {
  projects: Project[];
  /** The active project's id, or null for all projects. */
  projectId: number | null;
  project: Project | null;
  setProjectId: (id: number | null) => void;
  /** Reload the list (after the admin page changed it). */
  refresh: () => Promise<void>;
  loaded: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setId] = useState<number | null>(() => activeProjectId());
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      // A remembered project that no longer exists falls back to "all".
      setId((cur) => (cur != null && !list.some((p) => p.id === cur) ? (setActiveProjectId(null), null) : cur));
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const setProjectId = useCallback((id: number | null) => {
    setActiveProjectId(id);
    setId(id);
  }, []);

  const value = useMemo<ProjectContextValue>(() => ({
    projects,
    projectId,
    project: projects.find((p) => p.id === projectId) ?? null,
    setProjectId,
    refresh,
    loaded,
  }), [projects, projectId, setProjectId, refresh, loaded]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const v = useContext(ProjectContext);
  if (!v) throw new Error('useProject outside ProjectProvider');
  return v;
}

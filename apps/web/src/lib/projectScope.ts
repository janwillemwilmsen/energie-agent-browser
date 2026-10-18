// The active project, as the request layer sees it: a plain module (no React)
// so lib/request.ts can read it without importing the provider. The provider
// in lib/project.tsx owns the state and writes through setActiveProjectId.
//
// null = "all projects": no header is sent and the server lists everything.

const KEY = 'eab.project';
export const PROJECT_HEADER = 'X-Project-Id';

let active: number | null = readStored();

function readStored(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    const n = v == null ? NaN : Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function activeProjectId(): number | null {
  return active;
}

export function setActiveProjectId(id: number | null): void {
  active = id;
  try {
    if (id == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(id));
  } catch { /* ignore */ }
}

/** The header every API request carries; none when all projects are in scope. */
export function projectHeaders(): Record<string, string> {
  return active == null ? {} : { [PROJECT_HEADER]: String(active) };
}

export interface Scenario {
  id: number;
  name: string;
  url: string;
  viewport_preset: 'desktop' | 'mobile' | 'both';
  brand: string | null;
  type: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScenarioCard extends Scenario {
  latest_run_id: number | null;
  latest_run_started_at: string | null;
  latest_run_status: 'queued' | 'running' | 'success' | 'failed' | null;
  latest_screenshot: string | null;
}

export interface ScenarioStep {
  id: number;
  scenario_id: number;
  position: number;
  kind: string;
  payload_json: string;
}

export type ScenarioDetail = Scenario & { steps: ScenarioStep[] };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  // Only declare a JSON body when we're actually sending one — Fastify rejects
  // an empty body with Content-Type: application/json as 400 Bad Request.
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Schedule {
  id: number;
  scenario_id: number;
  cron_expr: string;
  enabled: 0 | 1 | boolean;
  last_run_at: string | null;
  last_status: string | null;
}

export interface Run {
  id: number;
  scenario_id: number;
  started_at: string;
  finished_at: string | null;
  status: 'queued' | 'running' | 'success' | 'failed';
  log_text: string;
  screenshot_paths_json: string;
}

export interface A11yNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  children: A11yNode[];
}
export interface A11yTree {
  root: A11yNode;
  capturedAt: string;
  url: string;
}
export interface SnapshotResponse {
  tree: A11yTree;
  raw: { origin: string; refs: Record<string, { role: string; name: string }>; snapshot: string };
}

export const api = {
  listScenarios: () => req<Scenario[]>('/api/scenarios'),
  listScenarioCards: () => req<ScenarioCard[]>('/api/scenarios/cards'),
  listScenarioRuns: (id: number) =>
    req<Run[]>(`/api/scenarios/${id}/runs`),
  getScenario: (id: number) => req<ScenarioDetail>(`/api/scenarios/${id}`),
  snapshot: (body: { url?: string; session?: string; compact?: boolean; interactiveOnly?: boolean }) =>
    req<SnapshotResponse>('/api/snapshot', { method: 'POST', body: JSON.stringify(body) }),
  startRun: (scenarioId: number) =>
    req<Run>(`/api/scenarios/${scenarioId}/run`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listRuns: () => req<Run[]>('/api/runs'),
  getRun: (id: number) => req<Run>(`/api/runs/${id}`),
  deleteRun: (id: number) => req<void>(`/api/runs/${id}`, { method: 'DELETE' }),
  deleteAllRuns: () => req<void>('/api/runs', { method: 'DELETE' }),
  listSchedules: () => req<Schedule[]>('/api/schedules'),
  createSchedule: (body: { scenario_id: number; cron_expr: string; enabled: boolean }) =>
    req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: (id: number, body: Partial<{ scenario_id: number; cron_expr: string; enabled: boolean }>) =>
    req<Schedule>(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSchedule: (id: number) =>
    req<void>(`/api/schedules/${id}`, { method: 'DELETE' }),
  createScenario: (
    body: Pick<Scenario, 'name' | 'url' | 'viewport_preset'> &
      Partial<Pick<Scenario, 'brand' | 'type'>>,
  ) => req<Scenario>('/api/scenarios', { method: 'POST', body: JSON.stringify(body) }),
  updateScenario: (
    id: number,
    body: Partial<Pick<Scenario, 'name' | 'url' | 'viewport_preset' | 'brand' | 'type'>>,
  ) => req<Scenario>(`/api/scenarios/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteScenario: (id: number) =>
    req<void>(`/api/scenarios/${id}`, { method: 'DELETE' }),
  addStep: (
    scenarioId: number,
    body: { position: number; kind: string; payload: unknown },
  ) =>
    req<ScenarioStep>(`/api/scenarios/${scenarioId}/steps`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateStep: (
    scenarioId: number,
    stepId: number,
    body: { position: number; kind: string; payload: unknown },
  ) =>
    req<ScenarioStep>(`/api/scenarios/${scenarioId}/steps/${stepId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteStep: (scenarioId: number, stepId: number) =>
    req<void>(`/api/scenarios/${scenarioId}/steps/${stepId}`, { method: 'DELETE' }),
  moveStep: (scenarioId: number, stepId: number, direction: 'up' | 'down') =>
    req<{ moved: boolean; reason: 'ok' | 'at_edge' | 'not_found' }>(
      `/api/scenarios/${scenarioId}/steps/${stepId}/move`,
      { method: 'POST', body: JSON.stringify({ direction }) },
    ),
  sessionStatus: (name: string) =>
    req<{ name: string; alive: boolean; pid: number | null }>(
      `/api/sessions/${encodeURIComponent(name)}/status`,
    ),
  bootstrapSession: (name: string) =>
    req<{ name: string; alive: boolean; pid: number | null }>(
      `/api/sessions/${encodeURIComponent(name)}/bootstrap`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  closeSession: (name: string) =>
    req<{ name: string; closed: boolean }>(
      `/api/sessions/${encodeURIComponent(name)}/close`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};

export interface EmailRecipient {
  id: number;
  email: string;
  scenarioIds: number[];
  successScenarioIds: number[];
  dailyDigest: boolean;
}

export interface Scenario {
  id: number;
  name: string;
  url: string;
  viewport_preset: 'desktop' | 'mobile' | 'both';
  brand: string | null;
  type: string | null;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
  preflight_id: number | null;
  preflight_mode: 'steps' | 'cookies';
  record_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface Recording {
  id: number;
  scenario_id: number | null;
  run_id: number | null;
  file_path: string;
  size_bytes: number | null;
  created_at: string;
  // Joined from the scenario by GET /api/recordings.
  scenario_name?: string | null;
  brand?: string | null;
  type?: string | null;
}

export interface Preflight {
  id: number;
  name: string;
  description: string;
  steps_json: string;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PreflightRetryPolicy {
  retries?: number;
  retry_wait_before_ms?: number;
  retry_wait_after_ms?: number;
  restart_on_failure?: number;
}

export interface SelectorStrategy {
  role: string;
  name: string;
  textContains?: string;
  ordinal?: number;
  ancestorPath?: { role: string; name: string }[];
  // Raw agent-browser locator (#id, .class, css, [data-testid=…], text=…,
  // xpath=…). When set, the server targets it directly instead of resolving
  // role/name against the accessibility tree.
  locator?: string;
}

export type PreflightStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'click'; selector: SelectorStrategy }
  | { kind: 'type'; selector: SelectorStrategy; text: string }
  | { kind: 'select'; selector: SelectorStrategy; value: string }
  | { kind: 'auth-login'; name: string };

export interface AuthProfile {
  name: string;
  url: string;
  username: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
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
  // Ordered chain of scenarios this schedule runs sequentially.
  scenario_ids: number[];
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
  // Joined from the scenario by GET /api/runs (absent on the single-run endpoint).
  scenario_name?: string | null;
  brand?: string | null;
  type?: string | null;
}

export interface Artifact {
  id: number;
  kind: 'run_screenshot' | 'diff';
  file_path: string;
  scenario_id: number | null;
  source_run_id: number | null;
  label: string | null;
  viewport: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface Comparison {
  id: number;
  scenario_id: number | null;
  baseline_artifact_id: number;
  target_artifact_id: number;
  diff_artifact_id: number | null;
  threshold: number;
  mismatch_ratio: number | null;
  status: 'ok' | 'size_mismatch' | 'error';
  note: string | null;
  created_at: string;
  baseline: Artifact | null;
  target: Artifact | null;
  diff: Artifact | null;
}

export type ArtifactRef = { artifactId: number } | { runId: number; slot: string };

export interface CompareRunsResult {
  created: Comparison[];
  matched: string[];
  onlyBaseline: string[];
  onlyTarget: string[];
}

export interface BrowserlessHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  docs: {
    url: string;
    status: number | null;
    ok: boolean;
    error: string | null;
  };
  version: {
    browser: string | null;
    protocolVersion: string | null;
    userAgent: string | null;
    webSocketDebuggerUrl: string | null;
  } | null;
  cdp: {
    configuredUrl: string;
  };
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

export interface SessionState {
  name: string;
  file: string;
  sizeBytes: number;
  modifiedAt: string;
  inUse: boolean;
}

export const api = {
  listScenarios: () => req<Scenario[]>('/api/scenarios'),
  listScenarioCards: () => req<ScenarioCard[]>('/api/scenarios/cards'),
  listScenarioRuns: (id: number) =>
    req<Run[]>(`/api/scenarios/${id}/runs`),
  getScenario: (id: number) => req<ScenarioDetail>(`/api/scenarios/${id}`),
  snapshot: (body: { url?: string; session?: string; compact?: boolean; interactiveOnly?: boolean }) =>
    req<SnapshotResponse>('/api/snapshot', { method: 'POST', body: JSON.stringify(body) }),
  startRun: (scenarioId: number, opts: { reset?: boolean } = {}) =>
    req<Run>(`/api/scenarios/${scenarioId}/run`, {
      method: 'POST',
      body: JSON.stringify({ reset: opts.reset ?? false }),
    }),
  listRuns: () => req<Run[]>('/api/runs'),
  getRun: (id: number) => req<Run>(`/api/runs/${id}`),
  deleteRun: (id: number) => req<void>(`/api/runs/${id}`, { method: 'DELETE' }),
  deleteAllRuns: () => req<void>('/api/runs', { method: 'DELETE' }),
  deleteRuns: (ids: number[]) =>
    req<{ deleted: number }>('/api/runs/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  listRecordings: () => req<Recording[]>('/api/recordings'),
  deleteRecording: (id: number) =>
    req<void>(`/api/recordings/${id}`, { method: 'DELETE' }),
  recordingVideoUrl: (id: number) => `/api/recordings/${id}/video`,
  serverTime: () =>
    req<{ now: string; timezone: string; offsetMinutes: number }>('/api/time'),
  listSchedules: () => req<Schedule[]>('/api/schedules'),
  createSchedule: (body: { scenario_ids: number[]; cron_expr: string; enabled: boolean }) =>
    req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: (id: number, body: Partial<{ scenario_ids: number[]; cron_expr: string; enabled: boolean }>) =>
    req<Schedule>(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSchedule: (id: number) =>
    req<void>(`/api/schedules/${id}`, { method: 'DELETE' }),
  createScenario: (
    body: Pick<Scenario, 'name' | 'url' | 'viewport_preset'> &
      Partial<Pick<Scenario, 'brand' | 'type' | 'preflight_id'>>,
  ) => req<Scenario>('/api/scenarios', { method: 'POST', body: JSON.stringify(body) }),
  updateScenario: (
    id: number,
    body: Partial<
      Pick<
        Scenario,
        | 'name'
        | 'url'
        | 'viewport_preset'
        | 'brand'
        | 'type'
        | 'retries'
        | 'retry_wait_before_ms'
        | 'retry_wait_after_ms'
        | 'restart_on_failure'
        | 'preflight_id'
        | 'preflight_mode'
        | 'record_enabled'
      >
    >,
  ) => req<Scenario>(`/api/scenarios/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  listPreflights: () => req<Preflight[]>('/api/preflights'),
  getPreflight: (id: number) => req<Preflight>(`/api/preflights/${id}`),
  createPreflight: (
    body: { name: string; description?: string; steps?: PreflightStep[] } & PreflightRetryPolicy,
  ) =>
    req<Preflight>('/api/preflights', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePreflight: (
    id: number,
    body: { name?: string; description?: string; steps?: PreflightStep[] } & PreflightRetryPolicy,
  ) =>
    req<Preflight>(`/api/preflights/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deletePreflight: (id: number) =>
    req<void>(`/api/preflights/${id}`, { method: 'DELETE' }),
  startPreflightRecorder: (name: string) =>
    req<{ ok: true; session: string; sessionName: string } | { ok: false; error: string }>(
      '/api/preflights/recorder/start',
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  stopPreflightRecorder: () =>
    req<{ ok: true }>('/api/preflights/recorder/stop', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  execPreflightStep: (step: PreflightStep) =>
    req<{ ok: true } | { ok: false; error: string }>(
      '/api/preflights/recorder/exec-step',
      { method: 'POST', body: JSON.stringify({ step }) },
    ),
  replayPreflight: (id: number) =>
    req<{ ok: true } | { ok: false; error: string }>(
      `/api/preflights/${id}/replay`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  listAuthProfiles: () => req<AuthProfile[]>('/api/auth-profiles'),
  saveAuthProfile: (body: {
    name: string;
    url: string;
    username: string;
    password: string;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
  }) =>
    req<AuthProfile>('/api/auth-profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  authMe: () => req<{ authenticated: boolean; enabled: boolean }>('/api/auth/me'),
  authLogin: (username: string, password: string) =>
    req<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  authLogout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  agentAvailability: () =>
    req<{ available: boolean; busy: boolean }>('/api/agent-tasks/availability'),
  startAgentTask: (scenarioId: number, prompt: string) =>
    req<{ jobId: string }>(`/api/scenarios/${scenarioId}/agent-task`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  getAgentTask: (jobId: string) =>
    req<{
      id: string;
      scenarioId: number;
      status: 'running' | 'done' | 'failed';
      log: string[];
      stepsAdded: number;
      summary: string | null;
      error: string | null;
    }>(`/api/agent-tasks/${jobId}`),
  listAgentPrompts: (scenarioId: number) =>
    req<Array<{
      id: number;
      prompt: string;
      model: string;
      status: 'running' | 'done' | 'failed';
      steps_added: number;
      created_at: string;
    }>>(`/api/scenarios/${scenarioId}/agent-prompts`),
  deleteAgentPrompt: (promptId: number) =>
    req<void>(`/api/agent-prompts/${promptId}`, { method: 'DELETE' }),
  clearAgentPrompts: (scenarioId: number) =>
    req<{ deleted: number }>(`/api/scenarios/${scenarioId}/agent-prompts`, { method: 'DELETE' }),
  getAiSettings: () =>
    req<{
      model: string;
      source: 'setting' | 'env' | 'default';
      defaultModel: string;
      envModel: string | null;
      available: boolean;
    }>('/api/admin/ai-settings'),
  saveAiSettings: (model: string) =>
    req<{ model: string; source: string }>('/api/admin/ai-settings', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  listAiModels: () => req<{ models: string[] }>('/api/admin/ai-models'),
  pushVapidKey: () => req<{ publicKey: string }>('/api/push/vapid-public-key'),
  pushSubscribe: (body: {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    scenarioIds: number[];
    successScenarioIds: number[];
  }) => req<{ ok: true }>('/api/push/subscribe', { method: 'POST', body: JSON.stringify(body) }),
  pushStatus: (endpoint: string) =>
    req<{ subscribed: boolean; scenarioIds: number[]; successScenarioIds: number[] }>('/api/push/status', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
  pushUnsubscribe: (endpoint: string) =>
    req<{ ok: true }>('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: (endpoint: string) =>
    req<{ ok: true }>('/api/push/test', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  emailStatus: () => req<{ enabled: boolean; from: string }>('/api/email/status'),
  listEmailRecipients: () => req<EmailRecipient[]>('/api/email/recipients'),
  addEmailRecipient: (email: string) =>
    req<EmailRecipient>('/api/email/recipients', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  updateEmailRecipient: (
    id: number,
    body: { scenarioIds: number[]; successScenarioIds: number[]; dailyDigest: boolean },
  ) =>
    req<EmailRecipient>(`/api/email/recipients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteEmailRecipient: (id: number) =>
    req<void>(`/api/email/recipients/${id}`, { method: 'DELETE' }),
  sendEmailTest: (id: number) =>
    req<{ ok: true }>(`/api/email/recipients/${id}/test`, { method: 'POST' }),
  sendEmailDigest: () =>
    req<{ ok: true; sent: number; runCount: number; errors: string[] }>(
      '/api/email/digest/send',
      { method: 'POST' },
    ),
  updateAuthSelectors: (
    name: string,
    body: { usernameSelector?: string; passwordSelector?: string; submitSelector?: string },
  ) =>
    req<AuthProfile>(`/api/auth-profiles/${encodeURIComponent(name)}/selectors`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAuthProfile: (name: string) =>
    req<void>(`/api/auth-profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
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
  reorderSteps: (scenarioId: number, order: number[]) =>
    req<{ reordered: boolean; steps: ScenarioStep[] }>(
      `/api/scenarios/${scenarioId}/steps/reorder`,
      { method: 'POST', body: JSON.stringify({ order }) },
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
  browserlessHealth: () =>
    req<BrowserlessHealth>('/api/browserless/health'),
  listComparisons: (scenarioId?: number) =>
    req<Comparison[]>(
      `/api/comparisons${scenarioId != null ? `?scenario_id=${scenarioId}` : ''}`,
    ),
  getComparison: (id: number) => req<Comparison>(`/api/comparisons/${id}`),
  createComparison: (body: {
    scenarioId?: number;
    threshold?: number;
    baseline: ArtifactRef;
    target: ArtifactRef;
  }) => req<Comparison>('/api/comparisons', { method: 'POST', body: JSON.stringify(body) }),
  deleteComparison: (id: number) =>
    req<void>(`/api/comparisons/${id}`, { method: 'DELETE' }),
  compareRuns: (
    scenarioId: number,
    body: { baselineRunId: number; targetRunId: number; threshold?: number },
  ) =>
    req<CompareRunsResult>(`/api/scenarios/${scenarioId}/compare-runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  artifactImageUrl: (id: number) => `/api/artifacts/${id}/image`,
  listSessionStates: () => req<SessionState[]>('/api/session-states'),
  deleteSessionState: (name: string) =>
    req<void>(`/api/session-states/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

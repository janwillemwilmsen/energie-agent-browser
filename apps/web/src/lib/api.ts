import type { A11yTree, AuthProfile, Preflight, PreflightStep, Run, Scenario, Schedule, ScenarioStep } from '@eab/shared';
import { request as req, requestRaw } from './request.js';

export { ApiError, errorMessage, onUnauthenticated } from './request.js';

export interface EmailRecipient {
  id: number;
  email: string;
  scenarioIds: number[];
  successScenarioIds: number[];
  dailyDigest: boolean;
  weeklyDigest: boolean;
  monthlyDigest: boolean;
}

export type DigestPeriod = 'daily' | 'weekly' | 'monthly';


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


export interface PreflightRetryPolicy {
  retries?: number;
  retry_wait_before_ms?: number;
  retry_wait_after_ms?: number;
  restart_on_failure?: number;
}

// Step vocabulary and the accessibility-tree shapes are owned by the shared
// package (the same schemas the server validates with); re-exported here so
// pages keep one import path.
export type {
  A11yNode,
  A11yTree,
  AuthProfile,
  Preflight,
  PreflightStep,
  Run,
  RunStatus,
  Scenario,
  ScenarioStep,
  Schedule,
  ScenarioStepPayload,
  SelectorStrategy,
  FindBy,
  FindLocator,
  StepKind,
  StepPayload,
} from '@eab/shared';


export interface ScenarioCard extends Scenario {
  latest_run_id: number | null;
  latest_run_started_at: string | null;
  latest_run_status: 'queued' | 'running' | 'success' | 'failed' | null;
  latest_screenshot: string | null;
}

export type ScenarioDetail = Scenario & { steps: ScenarioStep[] };



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

// Which browser the session daemon drives. Mirrors the server's BackendSchema
// (agentBrowser/backend.ts); secrets come back redacted as `••••xxxx`, and
// sending that hint back on save means "keep the stored value".
export type BrowserBackend =
  | { kind: 'local'; executablePath: string }
  | { kind: 'cdp'; url: string; token: string }
  | {
      kind: 'browserless-cloud';
      apiKey: string;
      apiUrl: string;
      browserType: 'chromium' | 'chrome';
      ttlMs: number;
      stealth: boolean;
    }
  | { kind: 'browserbase'; apiKey: string };
export type BrowserBackendKind = BrowserBackend['kind'];

export interface BrowserSettings {
  backend: BrowserBackend;
  source: 'setting' | 'env';
  envBackend: BrowserBackend;
  cloudPrefill: Partial<Extract<BrowserBackend, { kind: 'browserless-cloud' }>>;
  browserbasePrefill: { apiKey?: string };
  stealthEnabled: boolean;
}

// The active backend plus a reachability probe. `remote` is null for the
// local backend (nothing to probe — `doctor` is the real check there).
export interface BrowserHealth {
  kind: BrowserBackendKind;
  source: 'setting' | 'env';
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  // The exact CLI line that boots the shared session (mirrors the driver).
  bootstrapCommand: string;
  session: { alive: boolean; pid: number | null };
  // Local only; null → agent-browser auto-detects its installed browser.
  executablePath: string | null;
  remote: {
    configuredUrl: string;
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
  } | null;
}

export interface BrowserTestResult {
  ok: boolean;
  kind: BrowserBackendKind;
  ms: number;
  steps: Array<{ step: string; ok: boolean; detail: string; ms: number }>;
}

export interface DoctorResult {
  kind: BrowserBackendKind;
  exitCode: number;
  timedOut: boolean;
  checks: Array<{ category: string; id: string; message: string; status: string; fix?: string }> | null;
  raw: string | null;
}

// --- Ask (LLM review of scenarios) --------------------------------------------
export interface AskScenario {
  id: number;
  name: string;
  url: string;
  brand: string | null;
  type: string | null;
  viewport_preset: string;
  run: { id: number; status: string; startedAt: string; screenshots: number; thumb: string | null } | null;
}

export interface AskUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface AskMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  withContext: boolean;
  usage: AskUsage | null;
  error: string | null;
  createdAt: string;
}

export interface AskModel {
  id: string;
  name: string;
  vision: boolean;
  contextWindow: number | null;
}

export interface AskPreset {
  id: number;
  label: string;
  prompt: string;
  position: number;
}

export interface AskThreadSummary {
  id: number;
  title: string;
  scenarioIds: number[];
  runIds: (number | null)[];
  /** '' = follows the admin default. */
  model: string;
  effectiveModel: string;
  /** Asset keys removed from the context. */
  excluded: string[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastReply: string;
}

export interface AskAsset {
  file: string;
  /** "<runId>/<file>" — what the thread's `excluded` list holds. */
  key: string;
  excluded: boolean;
  url: string | null;
}

export interface AskContext {
  scenarioId: number;
  name: string;
  url: string;
  viewport: string;
  runId: number | null;
  runStatus: string | null;
  runStartedAt: string | null;
  steps: string[];
  screenshots: (AskAsset & { thumb: string | null })[];
  texts: (AskAsset & { bytes: number })[];
}

export interface AskThread extends Omit<AskThreadSummary, 'messageCount' | 'lastReply'> {
  messages: AskMessage[];
  context: AskContext[];
}

export type AskStreamEvent =
  | { userMessageId: number }
  | { delta: string }
  | { done: true; messageId: number; usage: AskUsage | null; error: string | null };

/** A preflight as listed, with its scenario usage. */
export interface PreflightListRow extends Preflight {
  /** The scenarios that have this preflight attached. */
  scenarios: { id: number; name: string }[];
  scenario_count: number;
  /** Names of the scenarios using it, " · "-joined; null when none. */
  scenario_names: string | null;
}

// A run parked at a `pause` step (GET /api/runs/paused, GET /api/runs/:id).
export interface PausedRun {
  runId: number;
  scenarioId: number;
  position: number;
  label: string | null;
  since: string;
  timeoutMs: number;
  deadline: string;
}

// A page text saved by a save_text step (GET /api/scenarios/:id/texts).
export interface ScenarioText {
  runId: number;
  startedAt: string;
  status: string;
  file: string;
  label: string;
  viewport: string;
  bytes: number;
}

export interface InstallJob {
  args: string[];
  running: boolean;
  log: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
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

// Admin → Storage (GET /api/storage and friends).
export interface StorageGroup {
  key: string;
  label: string;
  dir: string;
  bytes: number;
  files: number;
  cache?: boolean;
}
export interface StorageTable {
  name: string;
  rows: number | null;
  bytes: number | null;
}
export interface StorageSummary {
  dataDir: string;
  totalBytes: number;
  db: {
    file: string;
    fileBytes: number;
    walBytes: number;
    shmBytes: number;
    pageSize: number;
    pageCount: number;
    freePages: number;
    reclaimableBytes: number;
    runLogBytes: number;
    tables: StorageTable[];
  };
  groups: StorageGroup[];
  orphans: {
    screenshotDirs: number;
    screenshotBytes: number;
    diffFiles: number;
    diffBytes: number;
    missingRecordingRows: number;
  };
  generatedAt: string;
}
export interface RunStorageItem {
  runId: number;
  scenarioId: number | null;
  scenarioName: string | null;
  brand: string | null;
  type: string | null;
  status: string | null;
  startedAt: string | null;
  bytes: number;
  files: number;
  thumbBytes: number;
  logBytes: number;
  recordingBytes: number;
  orphan: boolean;
}
export interface RecordingStorageItem {
  id: number | null;
  scenarioId: number | null;
  scenarioName: string | null;
  brand: string | null;
  type: string | null;
  runId: number | null;
  filePath: string;
  bytes: number;
  createdAt: string | null;
  missing: boolean;
  orphan: boolean;
}
export interface AuthStorageFile {
  name: string;
  file: string;
  bytes: number;
  modifiedAt: string;
}
export interface AuthStorage {
  dir: string;
  profiles: AuthStorageFile[];
  sessionStates: (AuthStorageFile & { inUse: boolean })[];
  encryptionKeyExists: boolean;
}
export type StorageCleanupAction =
  | 'thumbs'
  | 'preview'
  | 'logs'
  | 'orphan-screenshots'
  | 'orphan-diffs'
  | 'missing-recordings'
  | 'vacuum';
export const api = {
  listScenarios: () => req<Scenario[]>('/api/scenarios'),
  listScenarioCards: () => req<ScenarioCard[]>('/api/scenarios/cards'),
  listScenarioRuns: (id: number) =>
    req<Run[]>(`/api/scenarios/${id}/runs`),
  getScenario: (id: number) => req<ScenarioDetail>(`/api/scenarios/${id}`),
  snapshot: (body: { url?: string; session?: string; compact?: boolean; interactiveOnly?: boolean }) =>
    req<SnapshotResponse>('/api/snapshot', { method: 'POST', body: JSON.stringify(body) }),
  startRun: (scenarioId: number, opts: { reset?: boolean; skipResources?: boolean } = {}) =>
    req<Run>(`/api/scenarios/${scenarioId}/run`, {
      method: 'POST',
      body: JSON.stringify({ reset: opts.reset ?? false, skipResources: opts.skipResources ?? false }),
    }),
  listRuns: () => req<Run[]>('/api/runs'),
  getRun: (id: number) => req<Run & { pause: PausedRun | null }>(`/api/runs/${id}`),
  pausedRuns: () => req<PausedRun[]>('/api/runs/paused'),
  resumeRun: (id: number) => req<{ ok: true }>(`/api/runs/${id}/resume`, { method: 'POST' }),
  abortRun: (id: number) => req<{ ok: true }>(`/api/runs/${id}/abort`, { method: 'POST' }),
  deleteRun: (id: number) => req<void>(`/api/runs/${id}`, { method: 'DELETE' }),
  deleteAllRuns: () => req<void>('/api/runs', { method: 'DELETE' }),
  deleteRuns: (ids: number[]) =>
    req<{ deleted: number; skippedRunning: number }>('/api/runs/delete', {
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
  copyScenario: (id: number, body: { name?: string; viewport_preset?: Scenario['viewport_preset'] }) =>
    req<Scenario>(`/api/scenarios/${id}/copy`, { method: 'POST', body: JSON.stringify(body) }),
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
  listPreflights: () => req<PreflightListRow[]>('/api/preflights'),
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
      askModel: string;
      askSource: 'setting' | 'agent';
    }>('/api/admin/ai-settings'),
  saveAiSettings: (model: string) =>
    req<{ model: string; source: string }>('/api/admin/ai-settings', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  listAiModels: () => req<{ models: string[] }>('/api/admin/ai-models'),
  getAiCredits: () =>
    req<{ credits: { balance: string; totalUsed: string } | null; error: string | null }>(
      '/api/admin/ai-credits',
    ),
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
    body: {
      scenarioIds: number[];
      successScenarioIds: number[];
      dailyDigest: boolean;
      weeklyDigest: boolean;
      monthlyDigest: boolean;
    },
  ) =>
    req<EmailRecipient>(`/api/email/recipients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteEmailRecipient: (id: number) =>
    req<void>(`/api/email/recipients/${id}`, { method: 'DELETE' }),
  sendEmailTest: (id: number) =>
    req<{ ok: true }>(`/api/email/recipients/${id}/test`, { method: 'POST' }),
  sendEmailDigest: (period: DigestPeriod = 'daily') =>
    req<{ ok: true; sent: number; runCount: number; errors: string[] }>(
      '/api/email/digest/send',
      { method: 'POST', body: JSON.stringify({ period }) },
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
  browserHealth: () =>
    req<BrowserHealth>('/api/browser/health'),
  getBrowserSettings: () => req<BrowserSettings>('/api/admin/browser'),
  saveBrowserSettings: (backend: BrowserBackend | null) =>
    req<{ backend: BrowserBackend; source: 'setting' | 'env' }>('/api/admin/browser', {
      method: 'PUT',
      body: JSON.stringify({ backend }),
    }),
  testBrowser: () => req<BrowserTestResult>('/api/admin/browser/test', { method: 'POST' }),
  browserDoctor: () => req<DoctorResult>('/api/admin/browser/doctor'),
  startBrowserInstall: (withDeps: boolean) =>
    req<{ started: true; args: string[] }>('/api/admin/browser/install', {
      method: 'POST',
      body: JSON.stringify({ withDeps }),
    }),
  browserInstallStatus: () => req<InstallJob>('/api/admin/browser/install'),
  saveAskModel: (model: string) =>
    req<{ model: string; source: 'setting' | 'agent' }>('/api/admin/ai-settings/ask', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  scenarioTexts: (scenarioId: number) => req<ScenarioText[]>(`/api/scenarios/${scenarioId}/texts`),
  runText: async (runId: number, file: string): Promise<string> => {
    const res = await requestRaw(`/api/runs/${runId}/texts/${encodeURIComponent(file)}`);
    return res.text();
  },
  saveRunText: (runId: number, file: string, content: string) =>
    req<{ file: string; bytes: number }>(`/api/runs/${runId}/texts/${encodeURIComponent(file)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  askScenarios: () => req<AskScenario[]>('/api/ask/scenarios'),
  askThreads: () => req<AskThreadSummary[]>('/api/ask/threads'),
  askThread: (id: number) => req<AskThread>(`/api/ask/threads/${id}`),
  createAskThread: (body: { title?: string; scenarioIds: number[]; runIds?: (number | null)[]; model?: string }) =>
    req<AskThreadSummary>('/api/ask/threads', { method: 'POST', body: JSON.stringify(body) }),
  updateAskThread: (id: number, body: { title?: string; model?: string; excluded?: string[] }) =>
    req<AskThreadSummary>(`/api/ask/threads/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  askModels: () =>
    req<{ models: AskModel[]; default: string; defaultSource: 'setting' | 'agent' }>('/api/ask/models'),
  askPresets: () => req<AskPreset[]>('/api/ask/presets'),
  createAskPreset: (body: { label: string; prompt: string }) =>
    req<AskPreset>('/api/ask/presets', { method: 'POST', body: JSON.stringify(body) }),
  updateAskPreset: (id: number, body: { label?: string; prompt?: string; position?: number }) =>
    req<AskPreset>(`/api/ask/presets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteAskPreset: (id: number) => req<void>(`/api/ask/presets/${id}`, { method: 'DELETE' }),
  deleteAskThread: (id: number) => req<void>(`/api/ask/threads/${id}`, { method: 'DELETE' }),
  // Streams the assistant reply as SSE frames; `onEvent` gets each parsed frame.
  askSend: async (
    id: number,
    text: string,
    onEvent: (ev: AskStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await requestRaw(`/api/ask/threads/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(5)) as AskStreamEvent); } catch { /* skip malformed frame */ }
      }
    }
  },
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
  // A Run's screenshot bytes; `w` (and `h`) ask for a cached WebP thumbnail.
  // The one place the web builds this URL, so the filename is always encoded.
  runScreenshotUrl: (runId: number, name: string, size?: { w?: number; h?: number }) => {
    const q = size?.w ? `?w=${size.w}${size.h ? `&h=${size.h}` : ''}` : '';
    return `/api/runs/${runId}/screenshots/${encodeURIComponent(name)}${q}`;
  },
  listSessionStates: () => req<SessionState[]>('/api/session-states'),
  deleteSessionState: (name: string) =>
    req<void>(`/api/session-states/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // Zip of run screenshots (Screenshots page → Download). Returns the blob +
  // the server-suggested filename; the caller triggers the browser download.
  downloadScreenshotsZip: async (
    items: { runId: number; names?: string[] }[],
  ): Promise<{ blob: Blob; filename: string }> => {
    const res = await requestRaw('/api/screenshots/zip', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? 'screenshots.zip' };
  },
  storageSummary: () => req<StorageSummary>('/api/storage'),
  storageRuns: () => req<RunStorageItem[]>('/api/storage/runs'),
  storageAuth: () => req<AuthStorage>('/api/storage/auth'),
  storageRecordings: () => req<RecordingStorageItem[]>('/api/storage/recordings'),
  storageDeleteRuns: (ids: number[], withRecordings = false) =>
    req<{ deletedRows: number; freedBytes: number; skippedRunning: number }>('/api/storage/runs/delete', {
      method: 'POST',
      body: JSON.stringify({ ids, withRecordings }),
    }),
  storageDeleteRecordings: (body: { ids?: number[]; files?: string[] }) =>
    req<{ deleted: number; freedBytes: number }>('/api/storage/recordings/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  storageCleanup: (action: StorageCleanupAction) =>
    req<{ action: string; count: number; freedBytes: number }>('/api/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  getEnv: () =>
    req<{
      path: string;
      exists: boolean;
      updatedAt: string | null;
      entries: { key: string; value: string; secret: boolean }[];
    }>('/api/admin/env'),
  saveEnv: (entries: { key: string; value: string }[]) =>
    req<{ ok: boolean; restartRequired: boolean; backupPath: string }>('/api/admin/env', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
};

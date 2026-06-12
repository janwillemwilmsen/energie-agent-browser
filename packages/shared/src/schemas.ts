import { z } from 'zod';

export const ViewportPreset = z.enum(['desktop', 'mobile', 'both']);
export type ViewportPreset = z.infer<typeof ViewportPreset>;

export const SelectorStrategy = z.object({
  role: z.string(),
  name: z.string(),
  textContains: z.string().optional(),
  ordinal: z.number().int().nonnegative().optional(),
  ancestorPath: z
    .array(z.object({ role: z.string(), name: z.string() }))
    .optional(),
});
export type SelectorStrategy = z.infer<typeof SelectorStrategy>;

export const StepKind = z.enum([
  'navigate',
  'click',
  'type',
  'fill',
  'scroll',
  'screenshot',
  'wait',
  'evaluate',
]);
export type StepKind = z.infer<typeof StepKind>;

const StepNavigate = z.object({ kind: z.literal('navigate'), url: z.string().url() });
const StepClick = z.object({ kind: z.literal('click'), selector: SelectorStrategy });
const StepType = z.object({
  kind: z.literal('type'),
  selector: SelectorStrategy,
  text: z.string(),
});
const StepFill = z.object({
  kind: z.literal('fill'),
  selector: SelectorStrategy,
  value: z.string(),
});
const StepScroll = z.object({
  kind: z.literal('scroll'),
  selector: SelectorStrategy.optional(),
  dx: z.number().default(0),
  dy: z.number().default(0),
  // When true, the runner loops `scroll down` calls with short pauses to
  // trigger IntersectionObserver-based lazy loaders, instead of using dy/dx.
  toBottom: z.boolean().optional(),
  // When true, jump back to the top of the page in one call.
  toTop: z.boolean().optional(),
});
const StepScreenshot = z.object({
  kind: z.literal('screenshot'),
  label: z.string().default('screenshot'),
  fullPage: z.boolean().default(true),
  // When 'mobile', the runner temporarily switches to the mobile device,
  // captures, then restores the run's viewport.
  viewport: z.enum(['mobile']).optional(),
  // Overlay numbered labels on interactive elements (agent-browser --annotate).
  annotate: z.boolean().optional(),
});
const StepWait = z.object({
  kind: z.literal('wait'),
  // Either a fixed delay (ms) or wait until a selector resolves.
  ms: z.number().int().positive().optional(),
  selector: SelectorStrategy.optional(),
});
const StepEvaluate = z.object({ kind: z.literal('evaluate'), js: z.string() });

export const StepPayload = z.discriminatedUnion('kind', [
  StepNavigate,
  StepClick,
  StepType,
  StepFill,
  StepScroll,
  StepScreenshot,
  StepWait,
  StepEvaluate,
]);
export type StepPayload = z.infer<typeof StepPayload>;

export const Scenario = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  url: z.string().url(),
  viewport_preset: ViewportPreset,
  brand: z.string().nullable(),
  type: z.string().nullable(),
  retries: z.number().int().nonnegative(),
  retry_wait_before_ms: z.number().int().nonnegative(),
  retry_wait_after_ms: z.number().int().nonnegative(),
  restart_on_failure: z.number().int().nonnegative(),
  // FK to preflights(id). When set, the runner ensures the 'default' daemon is
  // running with --session-name = the preflight's name, so the browser starts
  // with its cookies/localStorage already restored.
  preflight_id: z.number().int().nullable(),
  // 0/1: record a .webm of each run via agent-browser record start/stop.
  record_enabled: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Scenario = z.infer<typeof Scenario>;

export const ScenarioCreate = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  viewport_preset: ViewportPreset,
  brand: z.string().trim().min(1).nullable().optional(),
  type: z.string().trim().min(1).nullable().optional(),
  retries: z.number().int().min(0).optional(),
  retry_wait_before_ms: z.number().int().min(0).optional(),
  retry_wait_after_ms: z.number().int().min(0).optional(),
  restart_on_failure: z.number().int().min(0).optional(),
  preflight_id: z.number().int().nullable().optional(),
  record_enabled: z.number().int().min(0).max(1).optional(),
});
export type ScenarioCreate = z.infer<typeof ScenarioCreate>;

export const ScenarioUpdate = ScenarioCreate.partial();
export type ScenarioUpdate = z.infer<typeof ScenarioUpdate>;

// Preflight name doubles as agent-browser --session-name. Stays safe in CLI
// args and as a filename under ~/.agent-browser/sessions/.
export const PreflightName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'use letters, digits, dot, dash, underscore only');

// Auth-profile name doubles as agent-browser's auth subcommand argument and
// the filename under ~/.agent-browser/auth/. Same charset constraint as
// PreflightName so it's safe in a CLI arg and on disk.
export const AuthProfileName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'use letters, digits, dot, dash, underscore only');

export const PreflightStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().url() }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive() }),
  z.object({ kind: z.literal('click'), selector: SelectorStrategy }),
  z.object({ kind: z.literal('type'), selector: SelectorStrategy, text: z.string() }),
  // Single-form login via agent-browser's encrypted Auth Vault. The actual
  // username + password live in ~/.agent-browser/auth/<name>.json (AES-GCM
  // encrypted), keeping credentials out of preflight steps_json in the DB.
  z.object({ kind: z.literal('auth-login'), name: AuthProfileName }),
]);
export type PreflightStep = z.infer<typeof PreflightStep>;

// Mirror of `agent-browser auth list` / `auth show` output. Passwords are
// never returned by the API; the only place they're stored is the encrypted
// on-disk file managed by agent-browser itself.
export const AuthProfile = z.object({
  name: z.string(),
  url: z.string(),
  username: z.string(),
});
export type AuthProfile = z.infer<typeof AuthProfile>;

export const AuthProfileCreate = z.object({
  name: AuthProfileName,
  url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  // Optional CSS selector overrides — agent-browser's heuristics handle most
  // forms, but you can pin them when the page doesn't follow conventions.
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
});
export type AuthProfileCreate = z.infer<typeof AuthProfileCreate>;

export const Preflight = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  steps_json: z.string(),
  // Retry/restart policy, applied when the preflight runs as a whole (Replay,
  // or as a scenario's preflight prefix). Mirrors the scenario columns.
  retries: z.number().int().nonnegative(),
  retry_wait_before_ms: z.number().int().nonnegative(),
  retry_wait_after_ms: z.number().int().nonnegative(),
  restart_on_failure: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type Preflight = z.infer<typeof Preflight>;

export const PreflightCreate = z.object({
  name: PreflightName,
  description: z.string().optional(),
  steps: z.array(PreflightStep).optional(),
  retries: z.number().int().min(0).optional(),
  retry_wait_before_ms: z.number().int().min(0).optional(),
  retry_wait_after_ms: z.number().int().min(0).optional(),
  restart_on_failure: z.number().int().min(0).optional(),
});
export type PreflightCreate = z.infer<typeof PreflightCreate>;

export const PreflightUpdate = z.object({
  name: PreflightName.optional(),
  description: z.string().optional(),
  steps: z.array(PreflightStep).optional(),
  retries: z.number().int().min(0).optional(),
  retry_wait_before_ms: z.number().int().min(0).optional(),
  retry_wait_after_ms: z.number().int().min(0).optional(),
  restart_on_failure: z.number().int().min(0).optional(),
});
export type PreflightUpdate = z.infer<typeof PreflightUpdate>;

export const ScenarioStep = z.object({
  id: z.number().int(),
  scenario_id: z.number().int(),
  position: z.number().int().nonnegative(),
  kind: StepKind,
  payload_json: z.string(),
});
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const Schedule = z.object({
  id: z.number().int(),
  scenario_id: z.number().int(),
  cron_expr: z.string(),
  enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  last_status: z.string().nullable(),
});
export type Schedule = z.infer<typeof Schedule>;

export const RunStatus = z.enum(['queued', 'running', 'success', 'failed']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: z.number().int(),
  scenario_id: z.number().int(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  status: RunStatus,
  log_text: z.string(),
  screenshot_paths_json: z.string(),
});
export type Run = z.infer<typeof Run>;

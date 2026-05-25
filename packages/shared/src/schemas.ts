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
});
export type ScenarioCreate = z.infer<typeof ScenarioCreate>;

export const ScenarioUpdate = ScenarioCreate.partial();
export type ScenarioUpdate = z.infer<typeof ScenarioUpdate>;

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

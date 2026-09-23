import { z } from 'zod';

export const ViewportPreset = z.enum(['desktop', 'mobile', 'both']);
export type ViewportPreset = z.infer<typeof ViewportPreset>;

// agent-browser's semantic locators (`agent-browser find <by> <value> …`):
// Playwright-style getByRole / getByText / getByLabel / … resolved in the live
// page by the browser tool itself, not against our snapshot of the a11y tree.
// Pierces shadow DOM, auto-waits, and matches names as a case-insensitive
// substring unless `exact`.
export const FindBy = z.enum(['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid']);
export type FindBy = z.infer<typeof FindBy>;

export const FindLocator = z.object({
  by: FindBy,
  // The role, text, label, placeholder, alt text, title or data-testid.
  value: z.string().min(1),
  // Accessible-name filter; only meaningful with by: 'role'.
  name: z.string().optional(),
  // Exact, case-sensitive match instead of a case-insensitive substring.
  exact: z.boolean().optional(),
});
export type FindLocator = z.infer<typeof FindLocator>;

export const SelectorStrategy = z.object({
  role: z.string(),
  name: z.string(),
  textContains: z.string().optional(),
  ordinal: z.number().int().nonnegative().optional(),
  ancestorPath: z
    .array(z.object({ role: z.string(), name: z.string() }))
    .optional(),
  // Precise, raw agent-browser locator that bypasses role/name resolution
  // entirely: "#id", ".class", "div > button", "[data-testid='x']",
  // "text=Submit", "xpath=//button[@type='submit']". Use it when several
  // elements share the same role+name and ordinal/ancestorPath can't tell
  // them apart reliably. role/name stay as the human-readable label.
  locator: z.string().optional(),
  // Semantic locator, run through `agent-browser find`. Takes precedence over
  // locator and role/name. Only click, fill, check and wait Steps support it —
  // those are the actions `find` offers.
  find: FindLocator.optional(),
});
export type SelectorStrategy = z.infer<typeof SelectorStrategy>;

export const StepKind = z.enum([
  'navigate',
  'click',
  'type',
  'fill',
  // Pick an option in a native <select> dropdown (agent-browser select).
  // Options of a closed select have no box model, so they can't be clicked.
  'select',
  // State-aware checkbox steps (agent-browser check/uncheck). Unlike click —
  // which toggles blindly — these assert the desired end state and are a no-op
  // when the box is already there, so retries/re-runs can't flip it back.
  'check',
  'uncheck',
  'scroll',
  'screenshot',
  'wait',
  'evaluate',
  // Bracket steps that start/stop a video recording of the run. Place them
  // anywhere in the sequence to record just the slice you care about; the
  // runner taps the live screencast (see StreamRecorder), so stealth is kept.
  'record_start',
  'record_stop',
  // Tear down the browser session (agent-browser close). Useful as a final step
  // to end a scenario cleanly; later steps re-bootstrap the session on demand.
  'close',
  // Send a key or chord to the focused element (agent-browser press <key>):
  // Enter, Tab, Escape, Space, ArrowDown, Control+a, … No selector — focus
  // comes from the previous step (a click or fill).
  'press',
]);
export type StepKind = z.infer<typeof StepKind>;

export const AuthProfileName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'use letters, digits, dot, dash, underscore only');

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
// selector targets the <select> element itself (role "combobox" in the
// snapshot), NOT one of its options; value is the option's label or value.
const StepSelect = z.object({
  kind: z.literal('select'),
  selector: SelectorStrategy,
  value: z.string(),
});
const StepCheck = z.object({ kind: z.literal('check'), selector: SelectorStrategy });
const StepUncheck = z.object({ kind: z.literal('uncheck'), selector: SelectorStrategy });
const StepScroll = z.object({
  kind: z.literal('scroll'),
  selector: SelectorStrategy.optional(),
  dx: z.number().optional(),
  // Pixels to scroll; the Step executor defaults to 400 when absent.
  dy: z.number().optional(),
  // When true, the runner loops `scroll down` calls with short pauses to
  // trigger IntersectionObserver-based lazy loaders, instead of using dy/dx.
  toBottom: z.boolean().optional(),
  // When true, jump back to the top of the page in one call.
  toTop: z.boolean().optional(),
});
const StepScreenshot = z.object({
  kind: z.literal('screenshot'),
  // Falls back to `step-<position>` when absent.
  label: z.string().optional(),
  fullPage: z.boolean().default(true),
  // When 'mobile', the runner temporarily switches to the mobile device,
  // captures, then restores the run's viewport.
  viewport: z.enum(['mobile']).optional(),
  // Overlay numbered labels on interactive elements (agent-browser --annotate).
  annotate: z.boolean().optional(),
  // Output format. png (default) is lossless; jpeg/webp are lossy but much
  // smaller. jpeg is captured natively by agent-browser; webp is post-converted
  // server-side with sharp.
  format: z.enum(['png', 'jpeg', 'webp']).optional(),
  // Lossy quality 1-100 (jpeg/webp only; ignored for png). Default 80.
  quality: z.number().int().min(1).max(100).optional(),
});
const StepWait = z.object({
  kind: z.literal('wait'),
  // Either a fixed delay (ms) or wait until a selector resolves.
  ms: z.number().int().positive().optional(),
  selector: SelectorStrategy.optional(),
});
const StepEvaluate = z.object({ kind: z.literal('evaluate'), js: z.string() });
const StepRecordStart = z.object({ kind: z.literal('record_start') });
const StepRecordStop = z.object({ kind: z.literal('record_stop') });
const StepClose = z.object({ kind: z.literal('close') });
// Key names follow agent-browser / Playwright: "Enter", "Tab", "Escape",
// "Space", "ArrowDown", "F5", a single character, or a chord joined with "+"
// ("Control+a", "Shift+Tab").
const StepPress = z.object({ kind: z.literal('press'), key: z.string().trim().min(1) });
// Single-form login via agent-browser's encrypted Auth Vault. The username +
// password live in ~/.agent-browser/auth/<name>.json (AES-GCM encrypted), so
// credentials never appear in a step payload. Only Preflights may contain this
// kind today: the scenario_steps CHECK constraint (and StepKind) exclude it.
const StepAuthLogin = z.object({ kind: z.literal('auth-login'), name: AuthProfileName });

// The Steps a Scenario may store: exactly the kinds in StepKind (and in the
// scenario_steps CHECK constraint). This is what the scenario write seam
// validates against.
export const ScenarioStepPayload = z.discriminatedUnion('kind', [
  StepNavigate,
  StepClick,
  StepType,
  StepFill,
  StepSelect,
  StepCheck,
  StepUncheck,
  StepScroll,
  StepScreenshot,
  StepWait,
  StepEvaluate,
  StepRecordStart,
  StepRecordStop,
  StepClose,
  StepPress,
]);
export type ScenarioStepPayload = z.infer<typeof ScenarioStepPayload>;

// Every Step kind the Step executor understands — Scenario steps AND Preflight
// steps (which add auth-login).
export const StepPayload = z.discriminatedUnion('kind', [
  ...ScenarioStepPayload.options,
  StepAuthLogin,
]);
export type StepPayload = z.infer<typeof StepPayload>;

// How an attached preflight is applied per scenario run:
//   'steps'   → re-run the preflight's steps in a clean browser (fresh login/
//               consent). Default.
//   'cookies' → skip the steps; just load the preflight's saved state.
export const PreflightMode = z.enum(['steps', 'cookies']);
export type PreflightMode = z.infer<typeof PreflightMode>;


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
  preflight_mode: PreflightMode.optional(),
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

// The subset of StepPayload a Preflight may contain, validated at the preflight
// write seam. Every PreflightStep is a valid StepPayload.
export const PreflightStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().url() }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive() }),
  z.object({ kind: z.literal('click'), selector: SelectorStrategy }),
  z.object({ kind: z.literal('type'), selector: SelectorStrategy, text: z.string() }),
  // Pick an option in a native <select>; selector targets the combobox itself.
  z.object({ kind: z.literal('select'), selector: SelectorStrategy, value: z.string() }),
  // Enter to submit a login form, Escape to dismiss a dialog.
  StepPress,
  // Single-form login via agent-browser's encrypted Auth Vault. The actual
  // username + password live in ~/.agent-browser/auth/<name>.json (AES-GCM
  // encrypted), keeping credentials out of preflight steps_json in the DB.
  z.object({ kind: z.literal('auth-login'), name: AuthProfileName }),
]);
export type PreflightStep = z.infer<typeof PreflightStep>;

// Mirror of `agent-browser auth list` / `auth show` output. Passwords are
// never returned by the API; the only place they're stored is the encrypted
// on-disk file managed by agent-browser itself.

// Accept a bare host ("mijn.essent.nl") by defaulting to https://, trim
// surrounding whitespace, then validate as a real URL. Without this, omitting
// the scheme (the most common mistake) fails z.string().url() with "Invalid
// url" — which previously surfaced as an opaque 500.
const NormalizedUrl = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return s;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}, z.string().url());

export const AuthProfileCreate = z.object({
  name: AuthProfileName,
  url: NormalizedUrl,
  username: z.string().min(1),
  password: z.string().min(1),
  // Optional CSS selector overrides — agent-browser's heuristics handle most
  // forms, but you can pin them when the page doesn't follow conventions.
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
});
export type AuthProfileCreate = z.infer<typeof AuthProfileCreate>;


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

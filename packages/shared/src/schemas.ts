import { z } from 'zod';

export const ViewportPreset = z.enum(['desktop', 'mobile', 'both']);
export type ViewportPreset = z.infer<typeof ViewportPreset>;

// The device profiles agent-browser's `set device <name>` knows (0.38.1; the
// list lives in its binary, not its docs). Each sets viewport, scale factor,
// touch and a matching user agent. Newest first; the older ones still work.
export const DEVICE_NAMES = [
  'iPhone 17',
  'iPhone 16 Pro',
  'iPhone 16',
  'iPhone 15',
  'iPhone 14',
  'iPhone 12',
  'iPad Pro',
  'iPad Air',
  'iPad',
  'Pixel 9',
  'Pixel 7',
  'Pixel 5',
  'Galaxy S25',
  'Galaxy S21',
] as const;
export type DeviceName = (typeof DEVICE_NAMES)[number];
/** What a 'mobile' viewport / mobile screenshot emulates unless a step picks a device. */
export const DEFAULT_MOBILE_DEVICE: DeviceName = 'iPhone 14';

export interface ViewportSize {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Device scale factor (devicePixelRatio). */
  scale: number;
}

// Each profile's CSS viewport and scale, measured against agent-browser 0.38.1
// on a page with `width=device-width`. Needed to emulate zoom on top of a
// device (see zoomedViewport); the names alone don't tell us the size.
export const DEVICE_PROFILES: Record<DeviceName, ViewportSize> = {
  'iPhone 17': { width: 402, height: 874, scale: 3 },
  'iPhone 16 Pro': { width: 402, height: 874, scale: 3 },
  'iPhone 16': { width: 393, height: 852, scale: 3 },
  'iPhone 15': { width: 393, height: 852, scale: 3 },
  'iPhone 14': { width: 390, height: 844, scale: 3 },
  'iPhone 12': { width: 390, height: 844, scale: 3 },
  'iPad Pro': { width: 1024, height: 1366, scale: 2 },
  'iPad Air': { width: 820, height: 1180, scale: 2 },
  'iPad': { width: 820, height: 1180, scale: 2 },
  'Pixel 9': { width: 412, height: 923, scale: 2.625 },
  'Pixel 7': { width: 412, height: 915, scale: 2.625 },
  'Pixel 5': { width: 393, height: 851, scale: 2.75 },
  'Galaxy S25': { width: 360, height: 800, scale: 3 },
  'Galaxy S21': { width: 360, height: 800, scale: 3 },
};

/** The desktop pass's viewport. */
export const DESKTOP_VIEWPORT: ViewportSize = { width: 1440, height: 900, scale: 1 };

// Browser zoom levels a screenshot step may emulate, in percent. A subset of
// Chrome's own zoom ladder: 125/150 are what most users with "larger" display
// settings run; 200/300/400 are the accessibility test points (WCAG reflow is
// judged at 400%).
export const ZOOM_LEVELS = [125, 150, 200, 300, 400] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

/**
 * Browser zoom as a viewport: Chrome zooms by making a CSS pixel bigger, so
 * a 1440×900 window at 200% is a 720×450 CSS viewport at scale 2 — same
 * rendered size, half the layout width, every breakpoint reacting as it
 * would for a real user at that zoom.
 */
export function zoomedViewport(base: ViewportSize, zoomPercent: number): ViewportSize {
  const f = zoomPercent / 100;
  return { width: Math.round(base.width / f), height: Math.round(base.height / f), scale: base.scale * f };
}

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
  // Save the rendered page's readable text (agent-browser read) as a Markdown
  // file beside the run's screenshots — the textual counterpart of a screenshot.
  'save_text',
  // Stop the run here and keep the browser as it is until the user clicks
  // Resume (or Abort, or the timeout passes). Unattended (scheduled) runs skip it.
  'pause',
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
  // Full page only. Some sites ("app shell" layouts) pin html/body to the
  // viewport height and scroll inside an inner container, so the document's
  // scroll height equals the viewport and a full-page capture comes out
  // viewport-sized. When true, the runner temporarily unlocks those inner
  // scrollers (overflow visible, height auto) so the document grows to the
  // real content height, captures, then restores the styles.
  expandScrollers: z.boolean().optional(),
  // When 'mobile', the runner temporarily switches to the mobile device,
  // captures, then restores the run's viewport.
  viewport: z.enum(['mobile']).optional(),
  // Which device the 'mobile' capture emulates (agent-browser `set device`).
  // Absent → the default mobile device (DEFAULT_MOBILE_DEVICE).
  device: z.enum(DEVICE_NAMES).optional(),
  // Emulate browser zoom (percent) for this capture: the viewport shrinks and
  // the scale grows accordingly, then the run's viewport is restored. Works
  // on top of the desktop viewport or the (step's or default) mobile device.
  zoom: z.union([z.literal(125), z.literal(150), z.literal(200), z.literal(300), z.literal(400)]).optional(),
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
// Falls back to `step-<position>` when absent, like screenshot.
const StepSaveText = z.object({ kind: z.literal('save_text'), label: z.string().optional() });
const StepPause = z.object({
  kind: z.literal('pause'),
  label: z.string().optional(),
  // How long to wait for Resume before the run is aborted. Default 10 minutes.
  timeoutMs: z.number().int().min(10_000).max(24 * 3_600_000).optional(),
});
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
  StepSaveText,
  StepPause,
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

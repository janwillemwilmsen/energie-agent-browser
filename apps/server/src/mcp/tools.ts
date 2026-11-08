import sharp from 'sharp';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  BrowserBackendKind,
  PreflightMode,
  PreflightName,
  PreflightStep,
  ScenarioStepPayload,
  ViewportPreset,
} from '@eab/shared';

// The MCP tool catalog: what an outside agent (Claude Code, Claude Desktop,
// Cursor …) can do to this app. Every tool is a thin client of the REST API,
// called in-process through app.inject() (see routes.ts) — so the same route
// code, validation and side effects run whether a request came from the web
// UI or from a tool, and nothing here duplicates SQL.
//
// Deliberately absent: deleting Scenarios, Runs or Preflights. MCP has no
// confirmation step, and those deletes take screenshot directories with them.
// remove_step is the one destructive tool, because fixing a mistyped Step
// while building a Scenario is the normal flow.

export interface ApiResponse {
  status: number;
  /** Parsed JSON body, or the raw text when the body isn't JSON. */
  body: unknown;
  /** Raw bytes, for binary routes (screenshots). */
  raw: Buffer;
}

export interface ApiCallOptions {
  body?: unknown;
  /** Sent as X-Project-Id, the request scope every list endpoint reads. */
  projectId?: number | null;
}

export type ApiCall = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  opts?: ApiCallOptions,
) => Promise<ApiResponse>;

// --- Result helpers ---------------------------------------------------------------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

function expectStatus(res: ApiResponse, ...statuses: number[]): unknown {
  if (statuses.includes(res.status)) return res.body;
  throw new ApiError(res.status, res.body);
}

function text(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function failure(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function isToolResult(v: unknown): v is CallToolResult {
  return !!v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content);
}

type Shape = z.ZodRawShape;
type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

interface ToolConfig<S extends Shape> {
  title: string;
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
}

// registerTool with the error handling every tool wants: a thrown ApiError
// (or anything else) becomes an isError result carrying the route's message,
// never a protocol-level failure that would drop the client's session.
function tool<S extends Shape>(
  server: McpServer,
  name: string,
  cfg: ToolConfig<S>,
  handler: (args: Args<S>) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    cfg,
    (async (args: Args<S>) => {
      try {
        const data = await handler(args);
        return isToolResult(data) ? data : text(data);
      } catch (e) {
        return failure(e);
      }
    }) as never,
  );
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// --- Shared argument schemas -----------------------------------------------------

const projectId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Scope to one project (ids from list_projects). Omit for every project / the default project.');

const scenarioId = z.number().int().positive().describe('Scenario id (from list_scenarios or create_scenario).');
const runId = z.number().int().positive().describe('Run id (from run_scenario or list_runs).');

// A Preflight may be named by id or by its unique name.
const preflightRef = z
  .union([z.number().int().positive(), PreflightName])
  .describe('Preflight to attach: its id, or its exact name (see list_preflights).');

const STEP_GUIDE = `A Step is {"kind": …, …payload}. Kinds and payloads:
- navigate {url}
- click | check | uncheck {selector}
- fill {selector, value}  (clear + type; prefer over type for inputs)
- type {selector, text}
- select {selector, value}  (native <select>; selector is the combobox itself, value the option's label)
- press {key}  ("Enter", "Tab", "Escape", "Control+a" — acts on the focused element)
- scroll {dy?: px (default 400), dx?, toBottom?: true (loops to trigger lazy loading), toTop?: true, selector? (scroll element into view)}
- wait {ms} or wait {selector} (until it resolves)
- screenshot {label?, fullPage?: boolean (default true → full page; false → viewport only), viewport?: "mobile", device?, zoom?: 125|150|200|300|400, format?: "png"|"jpeg"|"webp", quality?, annotate?, expandScrollers?}
- record_start {cursor?: boolean, human?: boolean} … record_stop {}  (video of the steps in between)
- save_text {label?, mode?: "text"|"html"|"a11y", tags?}  (beside the screenshots: the page text as Markdown (default), its full HTML, or an axe-core accessibility report — tags narrows the audit to axe rule tags, absent = every rule)
- evaluate {js}
- pause {label?, timeoutMs?}  (wait for a human to click Resume; skipped on schedules)
- close {}
Every Step may carry "optional": true — a failure is logged and the run continues.

A selector is {"role", "name"} resolved against the page's accessibility tree (role+name as a screen reader would say them, e.g. {"role":"button","name":"Accept cookies"}), plus optional:
- ordinal (0-based) when several elements share role+name
- locator: a raw CSS/text/xpath locator used INSTEAD of role+name ("#email", "text=Submit", "xpath=//button") — role/name then just label the step
- find: {"by": "role"|"text"|"label"|"placeholder"|"alt"|"title"|"testid", "value", "name"?, "exact"?} — a semantic locator the browser resolves live (pierces shadow DOM, auto-waits); click/fill/check/wait only.
Use snapshot_page to see the live accessibility tree before guessing names.`;

// --- Row shaping ------------------------------------------------------------------

type Row = Record<string, unknown>;

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** A scenario_steps row as the agent wants to read it: kind + payload flattened. */
function shapeStep(row: Row): Row {
  const payload = parseJson<Row>(row.payload_json, {});
  return { id: row.id, position: row.position, kind: row.kind, ...payload };
}

function shapeScenario(row: Row): Row {
  const { steps, ...rest } = row as Row & { steps?: Row[] };
  return { ...rest, steps: Array.isArray(steps) ? steps.map(shapeStep) : undefined };
}

function shapeRun(row: Row, opts: { logLines: number }): Row {
  const log = typeof row.log_text === 'string' ? row.log_text : '';
  const lines = log.split('\n');
  const tail = opts.logLines >= lines.length ? lines : lines.slice(lines.length - opts.logLines);
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    scenario_name: row.scenario_name,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    screenshots: parseJson<string[]>(row.screenshot_paths_json, []),
    texts: parseJson<string[]>(row.text_paths_json, []),
    log_total_lines: lines.length,
    log: tail.join('\n'),
  };
}

function shapePreflight(row: Row): Row {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    project_id: row.project_id,
    steps: parseJson<unknown[]>(row.steps_json, []),
    used_by_scenarios: row.scenarios,
    updated_at: row.updated_at,
  };
}

function shapeComparison(row: Row): Row {
  const diff = row.diff as Row | null | undefined;
  const baseline = row.baseline as Row | null | undefined;
  return {
    id: row.id,
    slot: baseline?.label ?? baseline?.slot ?? baseline?.file ?? null,
    status: row.status,
    mismatch_ratio: row.mismatch_ratio,
    threshold: row.threshold,
    diff_image: diff?.id != null ? `/api/artifacts/${diff.id}/image` : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- The catalog ------------------------------------------------------------------

export function registerTools(server: McpServer, api: ApiCall): void {
  // Resolve a Preflight reference (id or name) to an id, or throw.
  async function resolvePreflightId(ref: number | string, pid?: number | null): Promise<number> {
    if (typeof ref === 'number') return ref;
    const rows = expectStatus(await api('GET', '/api/preflights', { projectId: pid }), 200) as Row[];
    const hit = rows.find((p) => String(p.name).toLowerCase() === ref.toLowerCase());
    if (!hit) {
      const names = rows.map((p) => p.name).join(', ') || '(none)';
      throw new Error(`no preflight named "${ref}". Existing: ${names}`);
    }
    return Number(hit.id);
  }

  async function getScenario(id: number): Promise<Row & { steps: Row[] }> {
    const row = expectStatus(await api('GET', `/api/scenarios/${id}`), 200) as Row & { steps: Row[] };
    return row;
  }

  // The runner does not open the Scenario's url by itself: by convention the
  // first Step is `navigate <url>` (every Scenario built in the UI starts that
  // way). A tool caller shouldn't have to know that, so when a Scenario gets
  // its first Steps and none of them navigates first, that Step is inserted.
  function withLeadingNavigate(url: string, steps: unknown[], hasSteps: boolean): { steps: unknown[]; inserted: boolean } {
    if (hasSteps) return { steps, inserted: false };
    const first = steps[0] as { kind?: string } | undefined;
    if (first?.kind === 'navigate') return { steps, inserted: false };
    return { steps: [{ kind: 'navigate', url }, ...steps], inserted: true };
  }
  const NAVIGATE_NOTE = 'a navigate Step to the Scenario url was inserted first — the browser only opens pages Steps tell it to';

  // Append Steps after the current last position, one POST per Step so the
  // write seam validates each against ScenarioStepPayload and names the
  // offending field on failure.
  async function appendSteps(id: number, steps: unknown[]): Promise<Row[]> {
    const existing = (await getScenario(id)).steps;
    let position = existing.reduce((max, s) => Math.max(max, Number(s.position)), -1) + 1;
    const created: Row[] = [];
    for (const step of steps) {
      const { kind, ...payload } = step as Row & { kind: string };
      const res = await api('POST', `/api/scenarios/${id}/steps`, { body: { position, kind, payload } });
      if (res.status !== 201) {
        throw new ApiError(res.status, {
          ...(typeof res.body === 'object' && res.body ? res.body : { body: res.body }),
          step_index: created.length,
          created_so_far: created.map((c) => c.id),
        });
      }
      created.push(shapeStep(res.body as Row));
      position++;
    }
    return created;
  }

  // ----- Discovery -----

  tool(server, 'list_projects', {
    title: 'List projects',
    description: 'Projects group Scenarios. Returns id, name and order. Use an id as project_id on other tools.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => expectStatus(await api('GET', '/api/projects'), 200));

  tool(server, 'list_scenarios', {
    title: 'List scenarios',
    description: 'Every Scenario (id, name, url, viewport, preflight, project), newest first. Optional name filter.',
    inputSchema: {
      project_id: projectId,
      name_contains: z.string().optional().describe('Case-insensitive substring filter on the name.'),
    },
    annotations: READ_ONLY,
  }, async ({ project_id, name_contains }) => {
    const rows = expectStatus(await api('GET', '/api/scenarios', { projectId: project_id }), 200) as Row[];
    const q = name_contains?.toLowerCase();
    return rows
      .filter((r) => !q || String(r.name).toLowerCase().includes(q))
      .map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        viewport_preset: r.viewport_preset,
        project_id: r.project_id,
        preflight_id: r.preflight_id,
        preflight_mode: r.preflight_mode,
        record_enabled: r.record_enabled,
        updated_at: r.updated_at,
      }));
  });

  tool(server, 'get_scenario', {
    title: 'Get scenario',
    description: 'One Scenario with all its settings and its ordered Steps (each with its step id, for update_step / remove_step / reorder_steps).',
    inputSchema: { scenario_id: scenarioId },
    annotations: READ_ONLY,
  }, async ({ scenario_id }) => shapeScenario(await getScenario(scenario_id)));

  tool(server, 'list_preflights', {
    title: 'List preflights',
    description: 'Preflights are reusable login / cookie-consent Step sequences a Scenario runs first. Returns id, name, description, steps and which Scenarios use each.',
    inputSchema: { project_id: projectId },
    annotations: READ_ONLY,
  }, async ({ project_id }) => {
    const rows = expectStatus(await api('GET', '/api/preflights', { projectId: project_id }), 200) as Row[];
    return rows.map(shapePreflight);
  });

  tool(server, 'list_auth_profiles', {
    title: 'List auth profiles',
    description: 'Saved login credentials (name, username, login url, selector overrides — never the password). An auth-login Step in a Preflight references one by name.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => expectStatus(await api('GET', '/api/auth-profiles'), 200));

  // ----- Authoring: scenarios -----

  tool(server, 'create_scenario', {
    title: 'Create scenario',
    description: `Create a Scenario: a start URL plus an ordered list of Steps, optionally with a Preflight that runs first. Pass the Steps here or add them later with add_steps. The browser only opens pages that Steps navigate to, so unless your first Step is a navigate, one to the url is inserted as Step 1.\n\n${STEP_GUIDE}`,
    inputSchema: {
      name: z.string().min(1).max(200),
      url: z.string().url().describe('Start URL the browser opens before the first Step.'),
      viewport_preset: ViewportPreset.optional().describe('desktop (default) | mobile | both.'),
      project_id: projectId,
      preflight: preflightRef.optional(),
      preflight_mode: PreflightMode.optional().describe("steps (default): replay the Preflight's Steps in a clean browser each run; cookies: only load its saved browser state."),
      brand: z.string().optional().describe('Free-text tag.'),
      type: z.string().optional().describe('Free-text tag.'),
      record_enabled: z.boolean().optional().describe('Record a video of the whole run (alternative to record_start/record_stop Steps).'),
      browser_backend: BrowserBackendKind.optional().describe('Pin a browser backend instead of the admin default.'),
      steps: z.array(ScenarioStepPayload).optional().describe('Initial Steps, in order.'),
    },
    annotations: WRITE,
  }, async (a) => {
    const preflight_id = a.preflight === undefined ? undefined : await resolvePreflightId(a.preflight, a.project_id);
    const created = expectStatus(
      await api('POST', '/api/scenarios', {
        projectId: a.project_id,
        body: {
          name: a.name,
          url: a.url,
          viewport_preset: a.viewport_preset ?? 'desktop',
          project_id: a.project_id,
          brand: a.brand,
          type: a.type,
          preflight_id,
        },
      }),
      201,
    ) as Row;
    const id = Number(created.id);
    // The create route stores the identity fields only; the rest is a PUT.
    const extra: Row = {};
    if (a.preflight_mode) extra.preflight_mode = a.preflight_mode;
    if (a.record_enabled !== undefined) extra.record_enabled = a.record_enabled ? 1 : 0;
    if (a.browser_backend) extra.browser_backend = a.browser_backend;
    if (Object.keys(extra).length) expectStatus(await api('PUT', `/api/scenarios/${id}`, { body: extra }), 200);
    let note: string | undefined;
    if (a.steps?.length) {
      const lead = withLeadingNavigate(a.url, a.steps, false);
      await appendSteps(id, lead.steps);
      if (lead.inserted) note = NAVIGATE_NOTE;
    }
    const scenario = shapeScenario(await getScenario(id));
    return note ? { note, ...scenario } : scenario;
  });

  tool(server, 'update_scenario', {
    title: 'Update scenario',
    description: 'Change a Scenario\'s settings (not its Steps — see add_steps / update_step). Only the fields given change. preflight: null detaches.',
    inputSchema: {
      scenario_id: scenarioId,
      name: z.string().min(1).max(200).optional(),
      url: z.string().url().optional(),
      viewport_preset: ViewportPreset.optional(),
      project_id: z.number().int().positive().optional().describe('Move to another project.'),
      preflight: preflightRef.nullable().optional(),
      preflight_mode: PreflightMode.optional(),
      brand: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
      record_enabled: z.boolean().optional(),
      browser_backend: BrowserBackendKind.nullable().optional(),
      retries: z.number().int().min(0).optional().describe('Per-Step retries.'),
      notes: z.string().max(20_000).optional(),
    },
    annotations: WRITE,
  }, async ({ scenario_id, preflight, record_enabled, ...rest }) => {
    const body: Row = { ...rest };
    if (preflight !== undefined) body.preflight_id = preflight === null ? null : await resolvePreflightId(preflight);
    if (record_enabled !== undefined) body.record_enabled = record_enabled ? 1 : 0;
    expectStatus(await api('PUT', `/api/scenarios/${scenario_id}`, { body }), 200);
    return shapeScenario(await getScenario(scenario_id));
  });

  // ----- Authoring: steps -----

  tool(server, 'add_steps', {
    title: 'Add steps',
    description: `Append Steps to a Scenario (or insert at an index). Each Step is validated; on a bad one the error names the field and which Steps were already added. A Scenario that has no Steps yet gets a navigate to its url first unless you start with one.\n\n${STEP_GUIDE}`,
    inputSchema: {
      scenario_id: scenarioId,
      steps: z.array(ScenarioStepPayload).min(1),
      at_index: z.number().int().min(0).optional().describe('Insert before the Step currently at this 0-based index; omit to append.'),
    },
    annotations: WRITE,
  }, async ({ scenario_id, steps, at_index }) => {
    const current = await getScenario(scenario_id);
    const before = current.steps.map((s) => Number(s.id));
    const lead = withLeadingNavigate(String(current.url), steps, before.length > 0);
    const created = await appendSteps(scenario_id, lead.steps);
    if (at_index !== undefined && at_index < before.length) {
      const order = [...before];
      order.splice(at_index, 0, ...created.map((c) => Number(c.id)));
      expectStatus(await api('POST', `/api/scenarios/${scenario_id}/steps/reorder`, { body: { order } }), 200);
    }
    const out: Row = { added: created, scenario: shapeScenario(await getScenario(scenario_id)) };
    return lead.inserted ? { note: NAVIGATE_NOTE, ...out } : out;
  });

  tool(server, 'update_step', {
    title: 'Update step',
    description: `Replace one Step (keeps its position). Give the complete new Step.\n\n${STEP_GUIDE}`,
    inputSchema: {
      scenario_id: scenarioId,
      step_id: z.number().int().positive().describe('From get_scenario.'),
      step: ScenarioStepPayload,
    },
    annotations: WRITE,
  }, async ({ scenario_id, step_id, step }) => {
    const current = (await getScenario(scenario_id)).steps.find((s) => Number(s.id) === step_id);
    if (!current) throw new Error(`step ${step_id} is not in scenario ${scenario_id}`);
    const { kind, ...payload } = step;
    const row = expectStatus(
      await api('PUT', `/api/scenarios/${scenario_id}/steps/${step_id}`, {
        body: { position: current.position, kind, payload },
      }),
      200,
    ) as Row;
    return shapeStep(row);
  });

  tool(server, 'remove_step', {
    title: 'Remove step',
    description: 'Delete one Step from a Scenario. Runs and screenshots are untouched.',
    inputSchema: { scenario_id: scenarioId, step_id: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ scenario_id, step_id }) => {
    expectStatus(await api('DELETE', `/api/scenarios/${scenario_id}/steps/${step_id}`), 204);
    return shapeScenario(await getScenario(scenario_id));
  });

  tool(server, 'reorder_steps', {
    title: 'Reorder steps',
    description: 'Set the full order of a Scenario\'s Steps: every current step id, exactly once, in the desired order.',
    inputSchema: { scenario_id: scenarioId, order: z.array(z.number().int().positive()).min(1) },
    annotations: WRITE,
  }, async ({ scenario_id, order }) => {
    expectStatus(await api('POST', `/api/scenarios/${scenario_id}/steps/reorder`, { body: { order } }), 200);
    return shapeScenario(await getScenario(scenario_id));
  });

  // ----- Authoring: preflights -----

  const PREFLIGHT_GUIDE = `Preflight Steps are the login/consent subset: navigate {url}, wait {ms}, click {selector}, type {selector, text}, select {selector, value}, press {key}, auth-login {name} (fills and submits a login form with the named auth profile's credentials; it navigates to the profile's url itself).`;

  tool(server, 'create_preflight', {
    title: 'Create preflight',
    description: `Create a reusable login / cookie-consent sequence. Attach it to Scenarios with create_scenario or update_scenario (preflight: name).\n\n${PREFLIGHT_GUIDE}`,
    inputSchema: {
      name: PreflightName.describe('Unique; letters, digits, dot, dash, underscore.'),
      description: z.string().optional(),
      project_id: z.number().int().positive().optional().describe('Omit to share it across all projects.'),
      steps: z.array(PreflightStep).min(1),
    },
    annotations: WRITE,
  }, async (a) => shapePreflight(expectStatus(await api('POST', '/api/preflights', { body: a }), 201) as Row));

  tool(server, 'update_preflight', {
    title: 'Update preflight',
    description: `Change a Preflight's name, description or Steps (steps replaces the whole list).\n\n${PREFLIGHT_GUIDE}`,
    inputSchema: {
      preflight_id: z.number().int().positive(),
      name: PreflightName.optional(),
      description: z.string().optional(),
      steps: z.array(PreflightStep).optional(),
    },
    annotations: WRITE,
  }, async ({ preflight_id, ...body }) =>
    shapePreflight(expectStatus(await api('PUT', `/api/preflights/${preflight_id}`, { body }), 200) as Row));

  // ----- Running -----

  tool(server, 'run_scenario', {
    title: 'Run scenario',
    description: 'Start a Run of a Scenario and return immediately with the run id (status "running"). Follow with wait_for_run. Runs queue behind other runs on the same browser.',
    inputSchema: {
      scenario_id: scenarioId,
      fresh_session: z.boolean().optional().describe('Restart the browser first so it starts with an empty cookie jar ("Reset & play").'),
    },
    annotations: WRITE,
  }, async ({ scenario_id, fresh_session }) => {
    const row = expectStatus(
      await api('POST', `/api/scenarios/${scenario_id}/run`, { body: { reset: fresh_session ?? false } }),
      202,
    ) as Row;
    return shapeRun(row, { logLines: 5 });
  });

  tool(server, 'get_run', {
    title: 'Get run',
    description: 'A Run\'s status, timing, screenshot and text filenames, and the tail of its log. Screenshots are fetched with get_screenshot.',
    inputSchema: {
      run_id: runId,
      log_lines: z.number().int().min(0).max(2000).optional().describe('How many trailing log lines to include (default 40).'),
    },
    annotations: READ_ONLY,
  }, async ({ run_id, log_lines }) => {
    const row = expectStatus(await api('GET', `/api/runs/${run_id}`), 200) as Row;
    return shapeRun(row, { logLines: log_lines ?? 40 });
  });

  tool(server, 'wait_for_run', {
    title: 'Wait for run',
    description: 'Block until a Run finishes (success or failed) or the timeout passes, then return it like get_run. A Run parked on a pause Step is reported as paused — resume_run continues it.',
    inputSchema: {
      run_id: runId,
      timeout_seconds: z.number().int().min(1).max(600).optional().describe('Default 180.'),
      log_lines: z.number().int().min(0).max(2000).optional().describe('Default 40.'),
    },
    annotations: READ_ONLY,
  }, async ({ run_id, timeout_seconds, log_lines }) => {
    const deadline = Date.now() + (timeout_seconds ?? 180) * 1000;
    for (;;) {
      const row = expectStatus(await api('GET', `/api/runs/${run_id}`), 200) as Row;
      const status = String(row.status);
      if (status === 'success' || status === 'failed') {
        return { timed_out: false, ...shapeRun(row, { logLines: log_lines ?? 40 }) };
      }
      const paused = expectStatus(await api('GET', '/api/runs/paused'), 200) as Array<{ runId?: number; id?: number }>;
      if (paused.some((p) => (p.runId ?? p.id) === run_id)) {
        return { timed_out: false, paused: true, hint: 'the run is waiting at a pause Step; call resume_run', ...shapeRun(row, { logLines: log_lines ?? 40 }) };
      }
      if (Date.now() >= deadline) {
        return { timed_out: true, ...shapeRun(row, { logLines: log_lines ?? 40 }) };
      }
      await sleep(1500);
    }
  });

  tool(server, 'resume_run', {
    title: 'Resume paused run',
    description: 'Continue a Run that is waiting at a pause Step.',
    inputSchema: { run_id: runId },
    annotations: WRITE,
  }, async ({ run_id }) => expectStatus(await api('POST', `/api/runs/${run_id}/resume`), 200));

  tool(server, 'list_runs', {
    title: 'List runs',
    description: 'Recent Runs, newest first — of one Scenario, or across all. Log excluded; use get_run for one.',
    inputSchema: {
      scenario_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 20.'),
      project_id: projectId,
    },
    annotations: READ_ONLY,
  }, async ({ scenario_id, limit, project_id }) => {
    const max = limit ?? 20;
    const rows = scenario_id
      ? (expectStatus(await api('GET', `/api/scenarios/${scenario_id}/runs`), 200) as Row[])
      : (expectStatus(await api('GET', `/api/runs?limit=${max}`, { projectId: project_id }), 200) as Row[]);
    return rows
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, max)
      .map((r) => shapeRun(r, { logLines: 0 }))
      .map(({ log, log_total_lines, ...rest }) => ({ ...rest, log_lines: log_total_lines }));
  });

  tool(server, 'get_screenshot', {
    title: 'Get screenshot',
    description: 'Return one of a Run\'s screenshots as an image, downscaled for viewing (default max 1000px wide, JPEG). Filenames come from get_run.',
    inputSchema: {
      run_id: runId,
      file: z.string().min(1).describe('A filename from the run\'s screenshots list.'),
      max_width: z.number().int().min(200).max(2000).optional().describe('Default 1000.'),
      max_height: z.number().int().min(200).max(8000).optional().describe('Crop below this height (default 3000) — full-page captures can be very tall.'),
    },
    annotations: READ_ONLY,
  }, async ({ run_id, file, max_width, max_height }) => {
    const res = await api('GET', `/api/runs/${run_id}/screenshots/${encodeURIComponent(file)}`);
    if (res.status !== 200) throw new ApiError(res.status, res.body);
    const width = max_width ?? 1000;
    const height = max_height ?? 3000;
    const meta = await sharp(res.raw).metadata();
    const srcW = meta.width ?? width;
    const srcH = meta.height ?? height;
    // Scale to the width cap, then crop the (possibly very tall) result to the
    // height cap from the top — sharp applies extract after resize when
    // called in that order.
    const outW = Math.min(width, srcW);
    const scaledH = Math.round((srcH * outW) / srcW);
    const cropped = scaledH > height;
    let pipeline = sharp(res.raw).resize({ width: outW });
    if (cropped) pipeline = pipeline.extract({ left: 0, top: 0, width: outW, height });
    const image = await pipeline.jpeg({ quality: 80 }).toBuffer();
    const result: CallToolResult = {
      content: [
        { type: 'text', text: `${file}: original ${srcW}×${srcH}px, shown at ${outW}×${cropped ? height : scaledH}px${cropped ? ' (cropped to the top)' : ''}` },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
      ],
    };
    return result;
  });

  tool(server, 'compare_runs', {
    title: 'Compare runs',
    description: 'Pixel-diff two Runs of the same Scenario, pairing screenshots by label. Returns per-screenshot mismatch ratios (0 = identical) and which screenshots had no counterpart.',
    inputSchema: {
      scenario_id: scenarioId,
      baseline_run_id: runId.describe('The older Run; the two are swapped if needed.'),
      target_run_id: runId.describe('The newer Run.'),
      threshold: z.number().min(0).max(1).optional().describe('Per-pixel colour tolerance (default 0.1).'),
    },
    annotations: WRITE,
  }, async ({ scenario_id, baseline_run_id, target_run_id, threshold }) => {
    const out = expectStatus(
      await api('POST', `/api/scenarios/${scenario_id}/compare-runs`, {
        body: { baselineRunId: baseline_run_id, targetRunId: target_run_id, threshold: threshold ?? 0.1 },
      }),
      201,
    ) as { created: Row[]; matched: string[]; onlyBaseline: string[]; onlyTarget: string[] };
    return {
      comparisons: out.created.map(shapeComparison),
      only_in_baseline: out.onlyBaseline,
      only_in_target: out.onlyTarget,
    };
  });

  // ----- Live page -----

  tool(server, 'snapshot_page', {
    title: 'Snapshot live page',
    description: 'Open a URL in the shared browser session (or read its current page) and return the accessibility tree as text: the roles and names Step selectors are written against. Use before writing click/fill Steps.',
    inputSchema: {
      url: z.string().url().optional().describe('Navigate here first; omit to snapshot whatever the session shows now.'),
      interactive_only: z.boolean().optional().describe('Only buttons, links, inputs … (default false).'),
      max_chars: z.number().int().min(1000).max(200_000).optional().describe('Truncate the tree text (default 40000).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ url, interactive_only, max_chars }) => {
    const out = expectStatus(
      await api('POST', '/api/snapshot', { body: { url, compact: true, interactiveOnly: interactive_only ?? false } }),
      200,
    ) as { raw?: { snapshot?: string; origin?: string } };
    const snapshot = out.raw?.snapshot ?? '';
    const limit = max_chars ?? 40_000;
    const clipped = snapshot.length > limit;
    return `origin: ${out.raw?.origin ?? url ?? '(current page)'}\n\n${clipped ? snapshot.slice(0, limit) + `\n… (${snapshot.length - limit} more chars truncated)` : snapshot}`;
  });

  // ----- Schedules -----

  tool(server, 'list_schedules', {
    title: 'List schedules',
    description: 'Cron schedules and the Scenario chain each one runs.',
    inputSchema: { project_id: projectId },
    annotations: READ_ONLY,
  }, async ({ project_id }) => expectStatus(await api('GET', '/api/schedules', { projectId: project_id }), 200));

  tool(server, 'create_schedule', {
    title: 'Create schedule',
    description: 'Run one or more Scenarios (in order) on a cron expression, in the server\'s local time zone. E.g. "0 7 * * *" = daily 07:00.',
    inputSchema: {
      scenario_ids: z.array(z.number().int().positive()).min(1),
      cron_expr: z.string().min(9).describe('Standard 5-field cron.'),
      enabled: z.boolean().optional().describe('Default true.'),
    },
    annotations: WRITE,
  }, async (a) => expectStatus(await api('POST', '/api/schedules', { body: { ...a, enabled: a.enabled ?? true } }), 201));
}

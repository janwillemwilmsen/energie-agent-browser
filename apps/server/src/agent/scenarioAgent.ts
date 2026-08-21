import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { getSetting, setSetting } from '../settings.js';
import { run, runJson, ensureSession, restartSession } from '../agentBrowser/driver.js';
import { parseSnapshotText } from '../agentBrowser/parser.js';
import { resolveSelector } from '../scenarios/selector.js';
import { isOptionSelector, execSelectOptionFallback } from '../scenarios/selectFallback.js';
import type { A11yNode, A11yTree, SelectorStrategy } from '@eab/shared';

// LLM-driven scenario builder. Given a natural-language prompt, an agent loop
// perceives the page through the same a11y snapshot the SnapshotPicker uses,
// asks the model for ONE action per turn — in the app's own step vocabulary
// (role+name selectors, NOT snapshot-bound @refs) — executes it live against
// the shared 'default' session, and appends it as a scenario_steps row. The
// result is an ordinary scenario: replayable via Play, schedulable via cron.
//
// Model access goes through the Vercel AI Gateway (AI_GATEWAY_API_KEY), the
// same wiring agent-browser's own `chat` command uses. We deliberately do NOT
// use `agent-browser chat`: it executes ephemeral @ref commands that can't be
// replayed, and the whole point here is durable steps.

// --- Config -------------------------------------------------------------------
const GATEWAY_URL = (process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh').replace(/\/+$/, '');
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const MODEL_SETTING_KEY = 'agent_model';

// Model precedence: admin setting (DB) → AI_GATEWAY_MODEL env → built-in default.
export function currentModel(): { model: string; source: 'setting' | 'env' | 'default' } {
  const fromDb = getSetting(MODEL_SETTING_KEY);
  if (fromDb) return { model: fromDb, source: 'setting' };
  if (process.env.AI_GATEWAY_MODEL) return { model: process.env.AI_GATEWAY_MODEL, source: 'env' };
  return { model: DEFAULT_MODEL, source: 'default' };
}

export function setModelSetting(model: string | null): void {
  setSetting(MODEL_SETTING_KEY, model?.trim() || null);
}

// Best-effort listing of the gateway's model catalog for the admin dropdown
// (OpenAI-compatible GET /v1/models). Failure just means free-text entry.
export async function listGatewayModels(): Promise<string[]> {
  const res = await fetch(`${GATEWAY_URL}/v1/models`, {
    headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
  });
  if (!res.ok) throw new Error(`gateway /v1/models: ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? [])
    .map((m) => m.id ?? '')
    .filter(Boolean)
    .sort();
}

export function agentAvailable(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}

const MAX_ACTIONS = 20;
const MAX_CONSECUTIVE_FAILURES = 3;
const SESSION = 'default';

// --- Job store ------------------------------------------------------------------
export interface AgentJob {
  id: string;
  scenarioId: number;
  prompt: string;
  status: 'running' | 'done' | 'failed';
  log: string[];
  stepsAdded: number;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, AgentJob>();
let activeJobId: string | null = null;

export function getJob(id: string): AgentJob | undefined {
  return jobs.get(id);
}

export function hasActiveJob(): boolean {
  return activeJobId !== null;
}

// --- LLM call ---------------------------------------------------------------------
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chatCompletion(model: string, messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI gateway ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI gateway returned an empty completion');
  return content;
}

// --- Perception -------------------------------------------------------------------
async function snapshotTree(session: string): Promise<A11yTree> {
  const data = await runJson<{ origin: string; snapshot: string }>(
    ['snapshot', '--compact'],
    { session, timeoutMs: 30_000 },
  );
  return parseSnapshotText(data.snapshot ?? '', data.origin ?? '');
}

// Flatten the tree into a compact "role \"name\"" listing the model can pick
// selectors from. Interactive/content roles only, deduped, capped — the model
// must copy role+name EXACTLY for resolveSelector to find the node again.
const LISTED_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'tab', 'menuitem', 'option', 'slider', 'spinbutton',
  'heading', 'img', 'dialog', 'alert', 'listbox', 'form',
]);

function describePage(tree: A11yTree, maxLines = 140): string {
  // Two passes: count identical role+name entries first, then emit each unique
  // entry once — annotated with its multiplicity so the model knows it MUST
  // disambiguate with "ordinal" (sites built from LIT/custom elements often
  // render the same accessible button twice, e.g. mobile + desktop variants).
  interface Entry { role: string; name: string; value?: string; count: number }
  const entries = new Map<string, Entry>();
  const order: string[] = [];
  const visit = (node: A11yNode) => {
    if (LISTED_ROLES.has(node.role.toLowerCase())) {
      const name = node.name.trim();
      if (name) {
        const key = `${node.role}|${name}`;
        const existing = entries.get(key);
        if (existing) existing.count++;
        else {
          entries.set(key, { role: node.role, name, value: node.value, count: 1 });
          order.push(key);
        }
      }
    }
    for (const c of node.children) visit(c);
  };
  visit(tree.root);
  const lines: string[] = [];
  for (const key of order) {
    if (lines.length >= maxLines) break;
    const e = entries.get(key)!;
    const extra = e.value ? ` (value: ${JSON.stringify(e.value.slice(0, 60))})` : '';
    const dup = e.count > 1
      ? ` [appears ${e.count}× — add "ordinal": 0..${e.count - 1} to pick one]`
      : '';
    lines.push(`- ${e.role} "${e.name}"${extra}${dup}`);
  }
  if (lines.length === 0) return '(no interactive elements found — the page may still be loading)';
  return lines.join('\n');
}

// --- Actions ----------------------------------------------------------------------
interface AgentSelector {
  role: string;
  name: string;
  // 0-indexed pick (document order) when several elements share role+name.
  // Maps straight onto SelectorStrategy.ordinal, which resolveSelector applies
  // only when needed — so a step stays valid even if the duplicate disappears.
  ordinal?: number;
}

type AgentAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: AgentSelector }
  | { kind: 'fill'; selector: AgentSelector; value: string }
  | { kind: 'type'; selector: AgentSelector; text: string }
  | { kind: 'select'; selector: AgentSelector; value: string }
  | { kind: 'scroll'; dy?: number; toBottom?: boolean }
  | { kind: 'wait'; ms: number }
  | { kind: 'screenshot'; label: string }
  | { kind: 'done'; summary: string };

const SYSTEM_PROMPT = `You are a browser-automation agent building a REPLAYABLE test scenario.
Each turn you receive: the task, the current page URL, a list of elements on the page, and the actions taken so far.
Respond with EXACTLY ONE action as a single JSON object — no prose, no code fences.

Actions:
{"kind":"navigate","url":"https://…"}                              — go to a URL
{"kind":"click","selector":{"role":"button","name":"Accept all"}}  — click an element
{"kind":"fill","selector":{"role":"textbox","name":"Email"},"value":"…"} — set an input's value
{"kind":"type","selector":{"role":"textbox","name":"Search"},"text":"…"} — type with keystrokes
{"kind":"select","selector":{"role":"combobox","name":"Country"},"value":"…"} — pick a dropdown option by its label
{"kind":"scroll","dy":800}                                          — scroll down (negative = up)
{"kind":"scroll","toBottom":true}                                   — scroll through the whole page (lazy-load)
{"kind":"wait","ms":1500}                                           — pause (after navigation/animation)
{"kind":"screenshot","label":"result"}                              — record a screenshot step (captured on every future run)
{"kind":"done","summary":"…"}                                       — task complete (or impossible — say why)

Rules:
- selector.role and selector.name MUST be copied EXACTLY from the element list (they replay against future page loads).
- When the element list marks an entry with [appears N×], several elements share that role+name — you MUST add "ordinal" to the selector to pick one (0 = first in document order), e.g. {"kind":"click","selector":{"role":"button","name":"Ja","ordinal":0}}. Also add "ordinal" when an action fails with "Ambiguous selector".
- Prefer "fill" for inputs, "click" for buttons/links.
- For dropdowns (role "combobox"), use "select" on the combobox itself with the option's label as "value". If the list shows only "option" entries (no combobox), use "select" with the OPTION as the selector, e.g. {"kind":"select","selector":{"role":"option","name":"1 persoon"},"value":"1 persoon"}. NEVER click an "option" element — options of a closed dropdown are not clickable.
- If a cookie/consent banner blocks the page, dismiss it first.
- After a navigate or a click that loads new content, the next turn shows the new page — you do not need a wait unless timing is flaky.
- Add a screenshot step when the task asks to capture/verify something visual.
- If an action failed, the error is shown — try a different element or approach, don't repeat the same failing action.
- Use "done" as soon as the task is achieved. Never exceed the task's scope.`;

function parseAction(raw: string): AgentAction {
  // Tolerate code fences and stray prose around the JSON object.
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`model returned no JSON object: ${raw.slice(0, 200)}`);
  const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const kind = String(obj.kind ?? '');
  const sel = (o: Record<string, unknown>): AgentSelector => {
    const s = o.selector as Record<string, unknown> | undefined;
    if (!s || typeof s.role !== 'string' || typeof s.name !== 'string') {
      throw new Error(`action "${kind}" is missing selector {role, name}`);
    }
    const out: AgentSelector = { role: s.role, name: s.name };
    if (typeof s.ordinal === 'number' && Number.isInteger(s.ordinal) && s.ordinal >= 0) {
      out.ordinal = s.ordinal;
    }
    return out;
  };
  switch (kind) {
    case 'navigate':
      if (typeof obj.url !== 'string' || !obj.url) throw new Error('navigate needs url');
      return { kind, url: obj.url };
    case 'click':
      return { kind, selector: sel(obj) };
    case 'fill':
      return { kind, selector: sel(obj), value: String(obj.value ?? '') };
    case 'type':
      return { kind, selector: sel(obj), text: String(obj.text ?? '') };
    case 'select':
      return { kind, selector: sel(obj), value: String(obj.value ?? '') };
    case 'scroll':
      if (obj.toBottom) return { kind, toBottom: true };
      return { kind, dy: Number(obj.dy ?? 800) };
    case 'wait': {
      const ms = Math.min(Math.max(Number(obj.ms ?? 1000), 100), 30_000);
      return { kind, ms };
    }
    case 'screenshot':
      return { kind, label: String(obj.label ?? 'screenshot') || 'screenshot' };
    case 'done':
      return { kind, summary: String(obj.summary ?? 'done') };
    default:
      throw new Error(`unknown action kind "${kind}"`);
  }
}

function selDesc(s: AgentSelector): string {
  return `${s.role} "${s.name}"${s.ordinal != null ? ` [#${s.ordinal}]` : ''}`;
}

function summarizeAction(a: AgentAction): string {
  switch (a.kind) {
    case 'navigate': return `navigate → ${a.url}`;
    case 'click': return `click ${selDesc(a.selector)}`;
    case 'fill': return `fill ${selDesc(a.selector)} = ${JSON.stringify(a.value)}`;
    case 'type': return `type ${selDesc(a.selector)} ${JSON.stringify(a.text)}`;
    case 'select': return `select ${selDesc(a.selector)} = ${JSON.stringify(a.value)}`;
    case 'scroll': return a.toBottom ? 'scroll to bottom' : `scroll ${Number(a.dy) >= 0 ? 'down' : 'up'} ${Math.abs(Number(a.dy ?? 800))}px`;
    case 'wait': return `wait ${a.ms}ms`;
    case 'screenshot': return `screenshot "${a.label}"`;
    case 'done': return `done — ${a.summary}`;
  }
}

// --- Live execution (mirrors runner.ts semantics, without a RunContext) --------------
const SELECTOR_WAIT_MS = 12_000;
const SELECTOR_POLL_MS = 300;

async function resolveWithWait(session: string, selector: SelectorStrategy): Promise<string> {
  const deadline = Date.now() + SELECTOR_WAIT_MS;
  let lastErr: Error | null = null;
  for (;;) {
    try {
      const tree = await snapshotTree(session);
      return resolveSelector(selector, tree);
    } catch (e: any) {
      lastErr = e;
      if (Date.now() >= deadline) throw lastErr;
      await new Promise((r) => setTimeout(r, SELECTOR_POLL_MS));
    }
  }
}

async function executeAction(session: string, action: AgentAction): Promise<void> {
  switch (action.kind) {
    case 'navigate': {
      const r = await run(['open', action.url], { session, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new Error(`navigate failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'click':
    case 'fill':
    case 'type':
    case 'select': {
      const ref = await resolveWithWait(session, action.selector);
      if (action.kind === 'select' && isOptionSelector(action.selector)) {
        await execSelectOptionFallback(session, action.selector, action.value);
        return;
      }
      const args: string[] = [action.kind, ref];
      if (action.kind === 'fill' || action.kind === 'select') args.push(action.value);
      if (action.kind === 'type') args.push(action.text);
      const r = await run(args, { session, timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new Error(`${action.kind} failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'scroll': {
      if (action.toBottom) {
        for (let i = 0; i < 15; i++) {
          const r = await run(['scroll', 'down', '800'], { session, timeoutMs: 15_000 });
          if (r.exitCode !== 0) throw new Error(`scroll failed: ${r.stderr || r.stdout}`);
          await new Promise((res) => setTimeout(res, 400));
        }
        return;
      }
      const dy = Number(action.dy ?? 800);
      const r = await run(['scroll', dy >= 0 ? 'down' : 'up', String(Math.abs(dy))], {
        session,
        timeoutMs: 15_000,
      });
      if (r.exitCode !== 0) throw new Error(`scroll failed: ${r.stderr || r.stdout}`);
      return;
    }
    case 'wait':
      await new Promise((r) => setTimeout(r, action.ms));
      return;
    case 'screenshot':
      // No live side effect — the step is captured on every future run, which
      // is its purpose. (Perception comes from snapshots, not screenshots.)
      return;
    case 'done':
      return;
  }
}

// Persist an executed action as a scenario_steps row using the exact payload
// shapes the runner/editor already understand.
function actionToStep(action: AgentAction): { kind: string; payload: unknown } | null {
  switch (action.kind) {
    case 'navigate': return { kind: 'navigate', payload: { url: action.url } };
    case 'click': return { kind: 'click', payload: { selector: action.selector } };
    case 'fill': return { kind: 'fill', payload: { selector: action.selector, value: action.value } };
    case 'type': return { kind: 'type', payload: { selector: action.selector, text: action.text } };
    case 'select': return { kind: 'select', payload: { selector: action.selector, value: action.value } };
    case 'scroll': return { kind: 'scroll', payload: action.toBottom ? { toBottom: true } : { dy: Number(action.dy ?? 800) } };
    case 'wait': return { kind: 'wait', payload: { ms: action.ms } };
    case 'screenshot': return { kind: 'screenshot', payload: { label: action.label } };
    case 'done': return null;
  }
}

function appendScenarioStep(scenarioId: number, kind: string, payload: unknown): void {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM scenario_steps WHERE scenario_id = ?')
    .get(scenarioId) as { next: number };
  db.prepare(
    'INSERT INTO scenario_steps (scenario_id, position, kind, payload_json) VALUES (?, ?, ?, ?)',
  ).run(scenarioId, row.next, kind, JSON.stringify(payload ?? {}));
}

// --- The loop -------------------------------------------------------------------------
async function runLoop(job: AgentJob): Promise<void> {
  const db = getDb();
  const scenario = db
    .prepare('SELECT id, name, url FROM scenarios WHERE id = ?')
    .get(job.scenarioId) as { id: number; name: string; url: string } | undefined;
  if (!scenario) throw new Error(`scenario ${job.scenarioId} not found`);

  const { model } = currentModel();
  job.log.push(`task: ${job.prompt}`);
  job.log.push(`model: ${model}`);
  // Fresh slate for every AI run: close the session and bootstrap a new one so
  // the agent starts at about:blank with an empty cookie jar — same semantics
  // as "Reset & play". Otherwise the model perceives (and builds steps on top
  // of) whatever page and cookies the previous task left behind.
  job.log.push('resetting browser session…');
  // One locked close+start so a concurrent preview/command can't wedge in
  // between and race the bootstrap.
  await restartSession(SESSION);
  // Marker line: the modal turns on its live preview when it sees this, so the
  // preview WS doesn't race the daemon restart (it rejects when no pid exists).
  job.log.push('browser ready — live preview on');

  const history: string[] = [];
  let consecutiveFailures = 0;
  let lastRecordedKind: string | null = null;

  for (let turn = 1; turn <= MAX_ACTIONS; turn++) {
    // Perceive.
    let pageDesc = '';
    let url = '';
    try {
      const tree = await snapshotTree(SESSION);
      url = tree.url || '(unknown)';
      pageDesc = describePage(tree);
    } catch (e: any) {
      url = '(snapshot failed)';
      pageDesc = `(could not snapshot the page: ${e?.message ?? e})`;
    }

    const userMsg = [
      `TASK: ${job.prompt}`,
      ``,
      `Scenario base URL (use if the task doesn't name one): ${scenario.url}`,
      `CURRENT PAGE URL: ${url}`,
      ``,
      `ELEMENTS ON PAGE:`,
      pageDesc,
      ``,
      `ACTIONS SO FAR:`,
      history.length ? history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none yet)',
      ``,
      `Turn ${turn}/${MAX_ACTIONS}. Reply with ONE JSON action.`,
    ].join('\n');

    // Decide.
    const raw = await chatCompletion(model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ]);
    let action: AgentAction;
    try {
      action = parseAction(raw);
    } catch (e: any) {
      history.push(`(model produced an invalid action: ${e?.message ?? e})`);
      job.log.push(`turn ${turn}: invalid action from model — retrying`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error('model kept producing invalid actions');
      }
      continue;
    }

    job.log.push(`turn ${turn}: ${summarizeAction(action)}`);

    if (action.kind === 'done') {
      job.summary = action.summary;
      return;
    }

    // Act.
    try {
      await executeAction(SESSION, action);
      consecutiveFailures = 0;
      history.push(summarizeAction(action));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      history.push(`${summarizeAction(action)} → FAILED: ${msg.slice(0, 300)}`);
      job.log.push(`  ✗ failed: ${msg.slice(0, 300)}`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`${MAX_CONSECUTIVE_FAILURES} consecutive action failures — last: ${msg.slice(0, 200)}`);
      }
      continue; // failed action is NOT saved as a step
    }

    // Record.
    const step = actionToStep(action);
    if (step) {
      // Replay-robustness guard: a screenshot right after a navigate/click
      // races the page load on replay ("Cannot take screenshot with 0 width").
      // The live agent never sees this (its screenshot has no live side
      // effect), so insert the wait deterministically instead of hoping the
      // model adds one.
      if (step.kind === 'screenshot' && (lastRecordedKind === 'navigate' || lastRecordedKind === 'click')) {
        appendScenarioStep(job.scenarioId, 'wait', { ms: 1500 });
        job.stepsAdded++;
      }
      appendScenarioStep(job.scenarioId, step.kind, step.payload);
      job.stepsAdded++;
      lastRecordedKind = step.kind;
    }
  }

  job.summary = `stopped after ${MAX_ACTIONS} actions without the model declaring done`;
}

export function startAgentJob(scenarioId: number, prompt: string): AgentJob {
  if (!agentAvailable()) {
    throw new Error('AI_GATEWAY_API_KEY is not configured on the server');
  }
  if (activeJobId) {
    throw new Error('another AI task is already running — wait for it to finish');
  }
  const job: AgentJob = {
    id: crypto.randomBytes(8).toString('hex'),
    scenarioId,
    prompt,
    status: 'running',
    log: [],
    stepsAdded: 0,
    summary: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  // Persist the prompt immediately (not on completion) so it survives even a
  // crashed job / server restart — the point is to be able to re-run it later.
  const promptRow = getDb()
    .prepare('INSERT INTO agent_prompts (scenario_id, prompt, model) VALUES (?, ?, ?)')
    .run(scenarioId, prompt, currentModel().model);
  const promptRowId = Number(promptRow.lastInsertRowid);

  void runLoop(job)
    .then(() => {
      job.status = 'done';
    })
    .catch((e: any) => {
      job.status = 'failed';
      job.error = e?.message ?? String(e);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      activeJobId = null;
      try {
        getDb()
          .prepare('UPDATE agent_prompts SET status = ?, steps_added = ? WHERE id = ?')
          .run(job.status, job.stepsAdded, promptRowId);
      } catch { /* history is best-effort */ }
      // Keep only the last few finished jobs around for polling stragglers.
      const finished = [...jobs.values()].filter((j) => j.status !== 'running');
      while (finished.length > 5) {
        const oldest = finished.shift()!;
        jobs.delete(oldest.id);
      }
    });

  return job;
}

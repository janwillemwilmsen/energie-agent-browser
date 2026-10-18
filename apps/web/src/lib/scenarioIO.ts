import { safeParseScenarioStepPayload, type Project } from '@eab/shared';
import { api, type Preflight, type ScenarioDetail } from './api.js';

// Portable, environment-independent representation of a scenario, used to copy
// scenarios between instances (e.g. dev → prod). Deliberately omits everything
// that's local to one database:
//   - id / scenario_id          (auto-increment PKs/FKs — would clash in prod)
//   - created_at / updated_at   (per-environment timestamps)
// and it references the preflight by NAME rather than preflight_id, since the
// numeric id won't match across databases. payload_json is decoded to a real
// object so the export is readable and editable by hand.

export const PORTABLE_TYPE = 'eab.scenarios';
export const PORTABLE_VERSION = 1;

export interface PortableStep {
  position: number;
  kind: string;
  payload: unknown;
}

export interface PortableScenario {
  name: string;
  url: string;
  viewport_preset: 'desktop' | 'mobile' | 'both';
  brand: string | null;
  type: string | null;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
  // Settle policy around interactive steps; absent in older bundles → off.
  step_scroll_into_view: number;
  step_settle_ms: number;
  // Free-text notes; absent in older bundles → ''.
  notes: string;
  // Editor play option; absent in older bundles → off.
  auto_diff: number;
  // Resolved by name for portability; null when the scenario has no preflight.
  preflight_name: string | null;
  // The project, by name (created on import when missing); absent in older
  // bundles → the importing instance's active project.
  project: string | null;
  steps: PortableStep[];
}

export interface PortableBundle {
  _type: typeof PORTABLE_TYPE;
  version: number;
  scenarios: PortableScenario[];
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function toPortableScenario(
  detail: ScenarioDetail,
  preflightNameById: Map<number, string>,
  projectNameById: Map<number, string> = new Map(),
): PortableScenario {
  return {
    project: projectNameById.get(detail.project_id) ?? null,
    name: detail.name,
    url: detail.url,
    viewport_preset: detail.viewport_preset,
    brand: detail.brand ?? null,
    type: detail.type ?? null,
    retries: detail.retries,
    retry_wait_before_ms: detail.retry_wait_before_ms,
    retry_wait_after_ms: detail.retry_wait_after_ms,
    restart_on_failure: detail.restart_on_failure,
    step_scroll_into_view: detail.step_scroll_into_view ?? 0,
    step_settle_ms: detail.step_settle_ms ?? 0,
    notes: detail.notes ?? '',
    auto_diff: detail.auto_diff ?? 0,
    preflight_name:
      detail.preflight_id != null ? preflightNameById.get(detail.preflight_id) ?? null : null,
    steps: detail.steps
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ position: s.position, kind: s.kind, payload: safeParse(s.payload_json) })),
  };
}

export function makeBundle(scenarios: PortableScenario[]): PortableBundle {
  return { _type: PORTABLE_TYPE, version: PORTABLE_VERSION, scenarios };
}

// Accepts either a full bundle, a bare array of scenarios, or a single scenario
// object — so a hand-trimmed paste still imports. Throws on anything else.
export function parsePortable(text: string): PortableScenario[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Not valid JSON: ${e?.message ?? e}`);
  }
  let list: unknown;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray((data as any).scenarios))
    list = (data as any).scenarios;
  else if (data && typeof data === 'object') list = [data];
  else throw new Error('Expected a scenario object, an array, or an export bundle.');

  const arr = list as any[];
  return arr.map((s, i) => validateScenario(s, i));
}

function validateScenario(s: any, idx: number): PortableScenario {
  const where = `scenario[${idx}]`;
  if (!s || typeof s !== 'object') throw new Error(`${where} is not an object`);
  if (typeof s.name !== 'string' || !s.name.trim()) throw new Error(`${where}.name is required`);
  if (typeof s.url !== 'string' || !s.url.trim()) throw new Error(`${where}.url is required`);
  const vp = s.viewport_preset ?? 'desktop';
  if (!['desktop', 'mobile', 'both'].includes(vp))
    throw new Error(`${where}.viewport_preset must be desktop|mobile|both`);
  const steps = Array.isArray(s.steps) ? s.steps : [];
  // Every step is checked against the shared schema here, before the first
  // request, so a bad file fails whole instead of leaving a half-imported
  // scenario behind when the server rejects step N.
  const outSteps: PortableStep[] = steps.map((st: any, j: number) => {
    if (!st || typeof st !== 'object') throw new Error(`${where}.steps[${j}] is not an object`);
    if (typeof st.kind !== 'string') throw new Error(`${where}.steps[${j}].kind is required`);
    const checked = safeParseScenarioStepPayload(st.kind, st.payload ?? {});
    if (!checked.ok) throw new Error(`${where}.steps[${j}]: ${checked.error}`);
    return {
      position: Number.isInteger(st.position) ? st.position : j,
      kind: st.kind,
      payload: st.payload ?? {},
    };
  });
  return {
    name: s.name,
    url: s.url,
    viewport_preset: vp,
    brand: s.brand ?? null,
    type: s.type ?? null,
    retries: Number(s.retries) || 0,
    retry_wait_before_ms: Number(s.retry_wait_before_ms) || 0,
    retry_wait_after_ms: Number(s.retry_wait_after_ms) || 0,
    restart_on_failure: Number(s.restart_on_failure) || 0,
    step_scroll_into_view: s.step_scroll_into_view ? 1 : 0,
    step_settle_ms: Number(s.step_settle_ms) || 0,
    notes: typeof s.notes === 'string' ? s.notes : '',
    auto_diff: s.auto_diff ? 1 : 0,
    preflight_name: typeof s.preflight_name === 'string' ? s.preflight_name : null,
    project: typeof s.project === 'string' && s.project.trim() ? s.project.trim() : null,
    steps: outSteps,
  };
}

export interface ImportResult {
  name: string;
  scenarioId: number;
  steps: number;
  warnings: string[];
}

// Recreate one portable scenario in the CURRENT instance via the public API
// (create scenario → set retry policy → add each step). Going through the API
// keeps every DB constraint and default intact, unlike a raw SQL insert.
export async function importPortableScenario(
  s: PortableScenario,
  activePreflights: Preflight[],
  /** This instance's projects; a project the bundle names but this list lacks is created and appended here. */
  projects: Project[] = [],
): Promise<ImportResult> {
  const warnings: string[] = [];

  // Resolve preflight by name against THIS instance's preflights.
  let preflightId: number | null = null;
  if (s.preflight_name) {
    const match = activePreflights.find((p) => p.name === s.preflight_name);
    if (match) preflightId = match.id;
    else
      warnings.push(
        `preflight "${s.preflight_name}" not found here — scenario imported without a preflight`,
      );
  }

  // Resolve the project by name; create it when missing. No name → the
  // active project (the request's scope), as a new scenario would get.
  let projectId: number | undefined;
  if (s.project) {
    const want = s.project.toLowerCase();
    let match = projects.find((p) => p.name.toLowerCase() === want);
    if (!match) {
      match = await api.createProject({ name: s.project });
      projects.push(match);
      warnings.push(`project "${s.project}" created`);
    }
    projectId = match.id;
  }

  const created = await api.createScenario({
    name: s.name,
    url: s.url,
    viewport_preset: s.viewport_preset,
    ...(projectId != null ? { project_id: projectId } : {}),
    brand: s.brand,
    type: s.type,
    preflight_id: preflightId,
  });

  // createScenario doesn't take the retry or settle policy; apply them with an
  // update if any value is non-default.
  if (
    s.retries || s.retry_wait_before_ms || s.retry_wait_after_ms || s.restart_on_failure ||
    s.step_scroll_into_view || s.step_settle_ms || s.notes || s.auto_diff
  ) {
    await api.updateScenario(created.id, {
      retries: s.retries,
      retry_wait_before_ms: s.retry_wait_before_ms,
      retry_wait_after_ms: s.retry_wait_after_ms,
      restart_on_failure: s.restart_on_failure,
      step_scroll_into_view: s.step_scroll_into_view,
      step_settle_ms: s.step_settle_ms,
      notes: s.notes,
      auto_diff: s.auto_diff,
    });
  }

  let count = 0;
  for (const step of s.steps.slice().sort((a, b) => a.position - b.position)) {
    await api.addStep(created.id, {
      position: step.position,
      kind: step.kind,
      payload: step.payload,
    });
    count++;
  }

  return { name: s.name, scenarioId: created.id, steps: count, warnings };
}

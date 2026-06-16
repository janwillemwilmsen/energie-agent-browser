import { StepKind } from '@eab/shared';
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
  // Resolved by name for portability; null when the scenario has no preflight.
  preflight_name: string | null;
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
): PortableScenario {
  return {
    name: detail.name,
    url: detail.url,
    viewport_preset: detail.viewport_preset,
    brand: detail.brand ?? null,
    type: detail.type ?? null,
    retries: detail.retries,
    retry_wait_before_ms: detail.retry_wait_before_ms,
    retry_wait_after_ms: detail.retry_wait_after_ms,
    restart_on_failure: detail.restart_on_failure,
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

// Derived from the shared StepKind enum so new step kinds (record_start,
// record_stop, close, …) are accepted by the importer automatically instead of
// drifting out of sync with a second hardcoded list.
const KINDS = new Set<string>(StepKind.options);

function validateScenario(s: any, idx: number): PortableScenario {
  const where = `scenario[${idx}]`;
  if (!s || typeof s !== 'object') throw new Error(`${where} is not an object`);
  if (typeof s.name !== 'string' || !s.name.trim()) throw new Error(`${where}.name is required`);
  if (typeof s.url !== 'string' || !s.url.trim()) throw new Error(`${where}.url is required`);
  const vp = s.viewport_preset ?? 'desktop';
  if (!['desktop', 'mobile', 'both'].includes(vp))
    throw new Error(`${where}.viewport_preset must be desktop|mobile|both`);
  const steps = Array.isArray(s.steps) ? s.steps : [];
  const outSteps: PortableStep[] = steps.map((st: any, j: number) => {
    if (!st || typeof st !== 'object') throw new Error(`${where}.steps[${j}] is not an object`);
    if (typeof st.kind !== 'string' || !KINDS.has(st.kind))
      throw new Error(`${where}.steps[${j}].kind "${st.kind}" is not a valid step kind`);
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
    preflight_name: typeof s.preflight_name === 'string' ? s.preflight_name : null,
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

  const created = await api.createScenario({
    name: s.name,
    url: s.url,
    viewport_preset: s.viewport_preset,
    brand: s.brand,
    type: s.type,
    preflight_id: preflightId,
  });

  // createScenario doesn't take the retry policy; apply it with an update if any
  // value is non-default.
  if (s.retries || s.retry_wait_before_ms || s.retry_wait_after_ms || s.restart_on_failure) {
    await api.updateScenario(created.id, {
      retries: s.retries,
      retry_wait_before_ms: s.retry_wait_before_ms,
      retry_wait_after_ms: s.retry_wait_after_ms,
      restart_on_failure: s.restart_on_failure,
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

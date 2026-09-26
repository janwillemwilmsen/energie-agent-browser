// `PreflightStep` is both the zod schema (value) and its inferred type.
import { PreflightStep } from '@eab/shared';
import { api, type Preflight } from './api.js';

// Portable, environment-independent representation of a preflight, used to copy
// preflights between instances (e.g. dev → prod) — the sibling of scenarioIO.ts.
// Deliberately omits everything that's local to one database:
//   - id                                   (auto-increment PK — would clash)
//   - created_at / updated_at / deleted_at (per-environment bookkeeping)
// It also does NOT carry the captured browser state (cookies/localStorage under
// ~/.agent-browser/sessions/<name>): that file is environment-specific and may
// hold live session tokens. Run Replay on the target instance to rebuild it.
// steps_json is decoded to a real array so the export is readable by hand.

export const PORTABLE_PREFLIGHT_TYPE = 'eab.preflights';
export const PORTABLE_PREFLIGHT_VERSION = 1;

export interface PortablePreflight {
  name: string;
  description: string;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
  steps: PreflightStep[];
}

export interface PortablePreflightBundle {
  _type: typeof PORTABLE_PREFLIGHT_TYPE;
  version: number;
  preflights: PortablePreflight[];
}

function safeParseSteps(raw: string): PreflightStep[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function toPortablePreflight(p: Preflight): PortablePreflight {
  return {
    name: p.name,
    description: p.description ?? '',
    retries: p.retries,
    retry_wait_before_ms: p.retry_wait_before_ms,
    retry_wait_after_ms: p.retry_wait_after_ms,
    restart_on_failure: p.restart_on_failure,
    steps: safeParseSteps(p.steps_json),
  };
}

export function makePreflightBundle(preflights: PortablePreflight[]): PortablePreflightBundle {
  return { _type: PORTABLE_PREFLIGHT_TYPE, version: PORTABLE_PREFLIGHT_VERSION, preflights };
}

// Accepts either a full bundle, a bare array of preflights, or a single
// preflight object — so a hand-trimmed paste still imports. Throws on anything
// else, including a scenario bundle pasted into the wrong page.
export function parsePortablePreflights(text: string): PortablePreflight[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Not valid JSON: ${e?.message ?? e}`);
  }
  let list: unknown;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray((data as any).preflights))
    list = (data as any).preflights;
  else if (data && typeof data === 'object' && Array.isArray((data as any).scenarios))
    throw new Error('This is a scenarios bundle — use Export / import scenarios for it.');
  else if (data && typeof data === 'object') list = [data];
  else throw new Error('Expected a preflight object, an array, or an export bundle.');

  return (list as any[]).map((p, i) => validatePreflight(p, i));
}

function validatePreflight(p: any, idx: number): PortablePreflight {
  const where = `preflight[${idx}]`;
  if (!p || typeof p !== 'object') throw new Error(`${where} is not an object`);
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`${where}.name is required`);
  const rawSteps = Array.isArray(p.steps) ? p.steps : [];
  // Every step is checked against the shared schema here, before the first
  // request, so a bad file fails whole rather than half-way through the list.
  const steps: PreflightStep[] = rawSteps.map((st: unknown, j: number) => {
    const checked = PreflightStep.safeParse(st);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const path = issue?.path?.length ? `.${issue.path.join('.')}` : '';
      throw new Error(`${where}.steps[${j}]${path}: ${issue?.message ?? 'invalid step'}`);
    }
    return checked.data;
  });
  return {
    name: p.name.trim(),
    description: typeof p.description === 'string' ? p.description : '',
    retries: Number(p.retries) || 0,
    retry_wait_before_ms: Number(p.retry_wait_before_ms) || 0,
    retry_wait_after_ms: Number(p.retry_wait_after_ms) || 0,
    restart_on_failure: Number(p.restart_on_failure) || 0,
    steps,
  };
}

export type PreflightImportAction = 'created' | 'updated' | 'skipped';

export interface PreflightImportResult {
  name: string;
  action: PreflightImportAction;
  // null when skipped.
  preflightId: number | null;
  steps: number;
}

// Recreate one portable preflight in the CURRENT instance via the public API.
// Preflight names are unique per instance (the server answers 409 on a clash)
// and scenarios reference preflights by name when they're imported, so a name
// clash is resolved here instead of blindly creating a duplicate: either the
// existing row is updated in place (`overwrite`) or the import is skipped.
export async function importPortablePreflight(
  p: PortablePreflight,
  activePreflights: Preflight[],
  opts: { overwrite: boolean },
): Promise<PreflightImportResult> {
  const policy = {
    retries: p.retries,
    retry_wait_before_ms: p.retry_wait_before_ms,
    retry_wait_after_ms: p.retry_wait_after_ms,
    restart_on_failure: p.restart_on_failure,
  };
  const existing = activePreflights.find((x) => x.name === p.name);
  if (existing) {
    if (!opts.overwrite) {
      return { name: p.name, action: 'skipped', preflightId: existing.id, steps: 0 };
    }
    const updated = await api.updatePreflight(existing.id, {
      description: p.description,
      steps: p.steps,
      ...policy,
    });
    return { name: p.name, action: 'updated', preflightId: updated.id, steps: p.steps.length };
  }
  const created = await api.createPreflight({
    name: p.name,
    description: p.description,
    steps: p.steps,
    ...policy,
  });
  return { name: p.name, action: 'created', preflightId: created.id, steps: p.steps.length };
}

import type { z } from 'zod';
import { ScenarioStepPayload, StepPayload } from './schemas.js';

// Row → Step. The one place a stored (kind, payload) pair becomes a typed Step,
// shared by the server (write seam, Step executor) and the web (editor,
// import), so every surface rejects the same things with the same message.

export type StepParseResult<T> =
  | { ok: true; step: T }
  | { ok: false; error: string; issues: { path: string; message: string }[] };

type StepSchema = typeof StepPayload | typeof ScenarioStepPayload;

function safeParseWith<S extends StepSchema>(
  schema: S,
  kind: string,
  payload: unknown,
): StepParseResult<z.infer<S>> {
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const result = schema.safeParse({ ...raw, kind });
  if (result.success) return { ok: true, step: result.data as z.infer<S> };
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = issues[0];
  const where = first?.path ? ` at ${first.path}` : '';
  return {
    ok: false,
    error: `invalid ${kind} step${where}: ${first?.message ?? 'does not match schema'}`,
    issues,
  };
}

/** Any Step the executor understands, including Preflight-only kinds. */
export function safeParseStepPayload(kind: string, payload: unknown): StepParseResult<StepPayload> {
  return safeParseWith(StepPayload, kind, payload);
}

/** Like safeParseStepPayload, but throws an Error carrying the message. */
export function parseStepPayload(kind: string, payload: unknown): StepPayload {
  const r = safeParseStepPayload(kind, payload);
  if (!r.ok) throw new Error(r.error);
  return r.step;
}

/** Only the kinds a Scenario may store (no auth-login). */
export function safeParseScenarioStepPayload(
  kind: string,
  payload: unknown,
): StepParseResult<ScenarioStepPayload> {
  return safeParseWith(ScenarioStepPayload, kind, payload);
}

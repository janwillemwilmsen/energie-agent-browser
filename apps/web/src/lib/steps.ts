import { safeParseStepPayload, type ScenarioStep, type StepPayload } from '@eab/shared';

// A stored step row, read through the shared schema. The write seam rejects
// malformed Steps, so a failing row is rare (hand-edited data, an old build);
// the editors render it as visibly invalid — editable as raw JSON or deletable
// — instead of crashing the page.
export type StepRowRead =
  | { ok: true; step: StepPayload; payload: Record<string, unknown> }
  | { ok: false; error: string; payload: Record<string, unknown> };

export function readStepRow(row: Pick<ScenarioStep, 'kind' | 'payload_json'>): StepRowRead {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'payload is not valid JSON', payload };
  }
  const r = safeParseStepPayload(row.kind, payload);
  return r.ok ? { ok: true, step: r.step, payload } : { ok: false, error: r.error, payload };
}

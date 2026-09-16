import { useState } from 'react';
import { parseStepPayload } from '@eab/shared';
import { api, type ScenarioStep } from '../api.js';
import { readStepRow } from '../steps.js';

// The Step editor's seam toward persistence. Two adapters satisfy it:
//   - useServerStepStore: a Scenario's steps, written through the per-step API
//     and refetched (ids are database ids).
//   - useDraftStepStore:  a Preflight's steps, kept in a local draft array and
//     saved with the preflight (ids are array indices).
// The list, add controls, picker and edit modal only ever see a StepStore.

export type StepId = number | string;

export interface EditableStep {
  id: StepId;
  kind: string;
  payload: Record<string, unknown>;
  /** Set when the stored row does not parse; the row renders as invalid. */
  invalid?: string;
}

export interface StepStore {
  steps: EditableStep[];
  /** A mutation is in flight; controls disable themselves. */
  busy: boolean;
  /** Append a Step. Failures are reported through the adapter's onError. */
  add(kind: string, payload: Record<string, unknown>): Promise<void>;
  /** Replace a Step's payload. Rejects on failure so an edit form can show it. */
  update(id: StepId, payload: Record<string, unknown>): Promise<void>;
  remove(id: StepId): Promise<void>;
  move(id: StepId, direction: 'up' | 'down'): Promise<void>;
  reorder(orderedIds: StepId[]): Promise<void>;
}

// --- Pure draft operations (unit-tested) --------------------------------------------

export function draftMove<T>(steps: T[], index: number, direction: 'up' | 'down'): T[] {
  const to = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = steps.slice();
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Reorder by a full permutation of indices; anything else leaves the list as is. */
export function draftReorder<T>(steps: T[], orderedIndices: number[]): T[] {
  if (orderedIndices.length !== steps.length) return steps;
  const seen = new Set(orderedIndices);
  if (seen.size !== steps.length || orderedIndices.some((i) => i < 0 || i >= steps.length)) return steps;
  return orderedIndices.map((i) => steps[i]!);
}

/** Split a draft step (`{ kind, ...payload }`) into the editor's row shape. */
export function draftToEditable<T extends { kind: string }>(step: T, index: number): EditableStep {
  const { kind, ...payload } = step as { kind: string } & Record<string, unknown>;
  return { id: index, kind, payload };
}

/** Rebuild a typed draft step from kind + payload, validating with the shared schema. */
export function editableToDraft<T extends { kind: string }>(kind: string, payload: Record<string, unknown>): T {
  return parseStepPayload(kind, payload) as unknown as T;
}

// --- Adapter: Scenario steps through the API --------------------------------------------

export interface ServerStepStoreOptions {
  scenarioId: number;
  steps: ScenarioStep[];
  /** Refetch the scenario; called after every successful write. */
  reload: () => Promise<void>;
  onError: (message: string) => void;
}

function rowToEditable(row: ScenarioStep): EditableStep {
  const read = readStepRow(row);
  return read.ok
    ? { id: row.id, kind: row.kind, payload: read.payload }
    : { id: row.id, kind: row.kind, payload: read.payload, invalid: read.error };
}

export function useServerStepStore(opts: ServerStepStoreOptions): StepStore {
  const { scenarioId, reload, onError } = opts;
  const [busy, setBusy] = useState(false);
  // Optimistic order while a reorder request is in flight.
  const [optimistic, setOptimistic] = useState<ScenarioStep[] | null>(null);
  const rows = optimistic ?? opts.steps;

  async function mutate(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return {
    steps: rows.map(rowToEditable),
    busy,
    add: (kind, payload) =>
      mutate(() => api.addStep(scenarioId, { position: rows.length, kind, payload }).then(() => undefined)),
    update: async (id, payload) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('step no longer exists');
      setBusy(true);
      try {
        await api.updateStep(scenarioId, row.id, { position: row.position, kind: row.kind, payload });
        await reload();
      } finally {
        setBusy(false);
      }
    },
    remove: async (id) => {
      if (!confirm('Delete this step?')) return;
      await mutate(() => api.deleteStep(scenarioId, Number(id)));
    },
    move: (id, direction) => mutate(() => api.moveStep(scenarioId, Number(id), direction).then(() => undefined)),
    reorder: async (orderedIds) => {
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      const next = orderedIds.map((id) => byId.get(Number(id))).filter((r): r is ScenarioStep => !!r);
      if (next.length !== rows.length) return;
      setOptimistic(next);
      try {
        await mutate(() => api.reorderSteps(scenarioId, next.map((r) => r.id)).then(() => undefined));
      } finally {
        setOptimistic(null);
      }
    },
  };
}

// --- Adapter: a local draft array ------------------------------------------------------

export interface DraftStepStoreOptions<T extends { kind: string }> {
  steps: T[];
  setSteps: (updater: (prev: T[]) => T[]) => void;
  /** Something else is in flight (the page's own busy flag). */
  busy?: boolean;
  /**
   * Custom append, for callers that do more than push (the Preflight page
   * executes each added step live). Defaults to a plain append.
   */
  onAdd?: (step: T) => Promise<void> | void;
  onError: (message: string) => void;
}

export function useDraftStepStore<T extends { kind: string }>(opts: DraftStepStoreOptions<T>): StepStore {
  const { steps, setSteps, onAdd, onError } = opts;
  return {
    steps: steps.map(draftToEditable),
    busy: opts.busy ?? false,
    add: async (kind, payload) => {
      let step: T;
      try {
        step = editableToDraft<T>(kind, payload);
      } catch (e: any) {
        onError(e?.message ?? String(e));
        return;
      }
      if (onAdd) await onAdd(step);
      else setSteps((prev) => [...prev, step]);
    },
    update: async (id, payload) => {
      const index = Number(id);
      const current = steps[index];
      if (!current) throw new Error('step no longer exists');
      const step = editableToDraft<T>(current.kind, payload); // throws with a precise message
      setSteps((prev) => prev.map((s, i) => (i === index ? step : s)));
    },
    remove: async (id) => {
      const index = Number(id);
      setSteps((prev) => prev.filter((_, i) => i !== index));
    },
    move: async (id, direction) => {
      setSteps((prev) => draftMove(prev, Number(id), direction));
    },
    reorder: async (orderedIds) => {
      setSteps((prev) => draftReorder(prev, orderedIds.map(Number)));
    },
  };
}

import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { StepStore, StepId } from './store.js';

// One drag-and-drop context for the whole Step editor, so three kinds of drag
// can share it:
//   - reordering rows inside the StepList (sortable, as before),
//   - dragging a pick button off a snapshot row INTO the list, and
//   - dragging one of the "+ …" add-step buttons INTO the list;
// the latter two insert a new Step at the drop position instead of appending.
// The pages wrap the list, the snapshot pane and the add controls in
// <StepEditorDnd>; the components only use hooks from here.

/** A Step ready to insert: produced at drop (or click) time, after any prompt. */
export interface BuiltStep {
  kind: string;
  payload: Record<string, unknown>;
}

/** What a draggable "add a step" button carries while it is being dragged. */
export interface PickDragData {
  type: 'pick';
  /** The kind shown in the drag overlay (the dialog may still pick another, e.g. "by selector…"). */
  kind: string;
  /** Label for the drag overlay, e.g. `button "Bereken nu"` or `screenshot (full page)`. */
  label: string;
  /**
   * Produces the step at drop time (may prompt, e.g. `fill` asks for the
   * value); null cancels the insert.
   */
  build: () => BuiltStep | null;
}

/** The droppable id of the "append at the end" zone at the bottom of the list. */
export const STEP_LIST_END = 'step-list-end';

interface StepDndState {
  /** The pick currently being dragged, for drop-target affordances. */
  activePick: PickDragData | null;
}
const Ctx = createContext<StepDndState>({ activePick: null });
export const useStepDnd = () => useContext(Ctx);

function isPick(data: unknown): data is PickDragData {
  return !!data && typeof data === 'object' && (data as PickDragData).type === 'pick';
}

// A pick dragged over the list should target whatever row is under the
// pointer (or the end zone); a sortable row keeps dnd-kit's centre-based
// matching so reordering feels as before.
const collision: CollisionDetection = (args) => {
  if (isPick(args.active.data.current)) {
    const within = pointerWithin(args);
    return within.length ? within : rectIntersection(args);
  }
  return closestCenter(args);
};

export function StepEditorDnd({ store, children }: { store: StepStore; children: ReactNode }) {
  const [activePick, setActivePick] = useState<PickDragData | null>(null);
  const sensors = useSensors(
    // A small drag threshold so a click on a handle or pick button still works as a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current;
    setActivePick(isPick(data) ? data : null);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    const data = active.data.current;
    setActivePick(null);
    if (isPick(data)) {
      if (!over) return;
      const ids = store.steps.map((s) => s.id);
      const index = over.id === STEP_LIST_END ? ids.length : ids.indexOf(over.id as StepId);
      if (index === -1) return;
      const built = data.build();
      if (built) void store.insertAt(index, built.kind, built.payload);
      return;
    }
    // Reorder within the list.
    if (!over || active.id === over.id) return;
    const ids = store.steps.map((s) => s.id);
    const from = ids.indexOf(active.id as StepId);
    const to = ids.indexOf(over.id as StepId);
    if (from === -1 || to === -1) return;
    void store.reorder(arrayMove(ids, from, to));
  }

  return (
    <Ctx.Provider value={{ activePick }}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActivePick(null)}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activePick && (
            <div className="pick-drag-overlay">
              <code className={`step-kind step-kind-${activePick.kind}`}>{activePick.kind}</code>{' '}
              {activePick.label}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </Ctx.Provider>
  );
}

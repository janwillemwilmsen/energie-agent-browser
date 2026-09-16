import { useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StepEditModal } from './StepEditModal.js';
import { summarizeStep } from './summarize.js';
import type { EditableStep, StepStore } from './store.js';

// The ordered, drag-reorderable list of Steps with edit / move / delete on
// every row and the edit modal. Everything persists through the StepStore.
export function StepList({ store, empty }: { store: StepStore; empty: ReactNode }) {
  const [editing, setEditing] = useState<EditableStep | null>(null);
  const sensors = useSensors(
    // A small drag threshold so a click on the handle still works as a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = store.steps.map((s) => s.id);
    const from = ids.indexOf(active.id as EditableStep['id']);
    const to = ids.indexOf(over.id as EditableStep['id']);
    if (from === -1 || to === -1) return;
    void store.reorder(arrayMove(ids, from, to));
  }

  return (
    <>
      {store.steps.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={store.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ol className="step-list">
              {store.steps.map((s, idx) => (
                <StepRow
                  key={s.id}
                  step={s}
                  idx={idx}
                  total={store.steps.length}
                  busy={store.busy}
                  onEdit={() => setEditing(s)}
                  onMoveUp={() => void store.move(s.id, 'up')}
                  onMoveDown={() => void store.move(s.id, 'down')}
                  onDelete={() => void store.remove(s.id)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {editing && (
        <StepEditModal
          step={editing}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            await store.update(editing.id, payload);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function StepRow({
  step,
  idx,
  total,
  busy,
  onEdit,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  step: EditableStep;
  idx: number;
  total: number;
  busy: boolean;
  onEdit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li ref={setNodeRef} style={style}>
      <button
        className="step-drag"
        title="Drag to reorder"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="step-body">
        <code className={`step-kind step-kind-${step.kind}`}>{step.kind}</code>{' '}
        {step.invalid ? (
          <span className="error" title="Edit the payload JSON with ✎, or delete the step">
            invalid step — {step.invalid}
          </span>
        ) : (
          summarizeStep(step.kind, step.payload)
        )}
      </span>
      <button className="step-move" title="Edit step" onClick={onEdit} disabled={busy}>
        ✎
      </button>
      <button className="step-move" title="Move up" onClick={onMoveUp} disabled={busy || idx === 0}>
        ▲
      </button>
      <button
        className="step-move"
        title="Move down"
        onClick={onMoveDown}
        disabled={busy || idx === total - 1}
      >
        ▼
      </button>
      <button className="step-del" title="Delete step" onClick={onDelete} disabled={busy}>
        ×
      </button>
    </li>
  );
}

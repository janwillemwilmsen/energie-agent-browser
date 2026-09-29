import { useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StepEditModal } from './StepEditModal.js';
import { summarizeStep } from './summarize.js';
import { STEP_LIST_END, useStepDnd } from './StepDnd.js';
import type { EditableStep, StepStore } from './store.js';

// The ordered, drag-reorderable list of Steps with edit / move / delete on
// every row and the edit modal. Everything persists through the StepStore.
// Drag-and-drop (reordering, and dropping a snapshot pick into the list) is
// provided by the surrounding <StepEditorDnd>; this component only marks the
// rows sortable and offers the drop targets.
export function StepList({ store, empty }: { store: StepStore; empty: ReactNode }) {
  const [editing, setEditing] = useState<EditableStep | null>(null);
  const { activePick } = useStepDnd();

  return (
    <>
      {store.steps.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <SortableContext items={store.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="step-list">
            {store.steps.map((s, idx) => (
              <StepRow
                key={s.id}
                step={s}
                idx={idx}
                total={store.steps.length}
                busy={store.busy}
                pickDragging={activePick != null}
                onEdit={() => setEditing(s)}
                onMoveUp={() => void store.move(s.id, 'up')}
                onMoveDown={() => void store.move(s.id, 'down')}
                onDelete={() => void store.remove(s.id)}
              />
            ))}
          </ol>
        </SortableContext>
      )}
      <EndDropZone visible={activePick != null} />

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

// Where a dragged pick lands to become the LAST step. Only shown mid-drag so
// it costs no space otherwise; also the only target when the list is empty.
function EndDropZone({ visible }: { visible: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: STEP_LIST_END });
  if (!visible) return null;
  return (
    <div ref={setNodeRef} className={`step-drop-end${isOver ? ' over' : ''}`}>
      drop here to add as the last step
    </div>
  );
}

function StepRow({
  step,
  idx,
  total,
  busy,
  pickDragging,
  onEdit,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  step: EditableStep;
  idx: number;
  total: number;
  busy: boolean;
  pickDragging: boolean;
  onEdit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: step.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  // A pick hovering this row will be inserted BEFORE it.
  const insertBefore = pickDragging && isOver;
  return (
    <li ref={setNodeRef} style={style} className={insertBefore ? 'step-insert-before' : undefined}>
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

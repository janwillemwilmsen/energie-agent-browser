import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StepEditModal } from './StepEditModal.js';
import { summarizeStep } from './summarize.js';
import { STEP_LIST_END, useStepDnd } from './StepDnd.js';
import type { EditableStep, StepId, StepStore } from './store.js';

// The ordered, drag-reorderable list of Steps with edit / move / delete on
// every row and the edit modal. Everything persists through the StepStore.
// Drag-and-drop (reordering, and dropping a snapshot pick into the list) is
// provided by the surrounding <StepEditorDnd>; this component only marks the
// rows sortable and offers the drop targets.
//
// `filter` hides rows from view only: positions, move up/down and the drop
// index still refer to the full list, so a pick dropped on a visible row goes
// right before that row in the real order.
//
// `revealNew` scrolls a freshly added Step into view — for a list inside a
// scroll container (the editor's compact mode), where an appended row would
// otherwise land below the fold.
export function StepList({
  store, empty, filter, revealNew,
}: { store: StepStore; empty: ReactNode; filter?: (step: EditableStep) => boolean; revealNew?: boolean }) {
  const [editing, setEditing] = useState<EditableStep | null>(null);
  const { activePick } = useStepDnd();
  const hidden = filter ? store.steps.filter((s) => !filter(s)).length : 0;

  // Ids seen on the previous render; null until the first list has rendered
  // so the initial load never scrolls.
  const listRef = useRef<HTMLOListElement | null>(null);
  const seenIds = useRef<Set<StepId> | null>(null);
  const idsKey = store.steps.map((s) => String(s.id)).join(',');
  useEffect(() => {
    const ids = store.steps.map((s) => s.id);
    const seen = seenIds.current;
    seenIds.current = new Set(ids);
    if (!seen || !revealNew) return;
    // Several may appear at once (the AI builder); the last one is the newest.
    const added = ids.filter((id) => !seen.has(id));
    const target = added.at(-1);
    if (target == null) return;
    // `CSS` here is dnd-kit's helper; the escape lives on the DOM global.
    const row = listRef.current?.querySelector<HTMLElement>(`[data-step-id="${globalThis.CSS.escape(String(target))}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [idsKey, revealNew]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {store.steps.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <SortableContext items={store.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="step-list" ref={listRef}>
            {store.steps.map((s, idx) => filter && !filter(s) ? null : (
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
      {hidden > 0 && (
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
          {hidden} step{hidden === 1 ? '' : 's'} hidden by the filter
        </p>
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
    <li ref={setNodeRef} style={style} data-step-id={String(step.id)} className={insertBefore ? 'step-insert-before' : undefined}>
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

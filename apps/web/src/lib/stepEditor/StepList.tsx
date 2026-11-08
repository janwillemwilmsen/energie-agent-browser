import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StepEditModal } from './StepEditModal.js';
import { inlineField, summarizeStep } from './summarize.js';
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
//
// `selectMode` puts a checkbox in front of every row and a bar above the list
// that deletes the ticked Steps in one go. Boxes are ticked one by one, or
// painted: press one and sweep the pointer down the rows, and every row the
// pointer passes takes the state of the first (ticked or cleared).
export function StepList({
  store, empty, filter, revealNew, selectMode = false,
}: {
  store: StepStore;
  empty: ReactNode;
  filter?: (step: EditableStep) => boolean;
  revealNew?: boolean;
  selectMode?: boolean;
}) {
  const [editing, setEditing] = useState<EditableStep | null>(null);
  const { activePick } = useStepDnd();
  const hidden = filter ? store.steps.filter((s) => !filter(s)).length : 0;

  // The selection, and the value being painted while a sweep is in progress
  // (null outside one). The sweep ends on any pointer release, wherever it is.
  const [selected, setSelected] = useState<Set<StepId>>(() => new Set());
  const paint = useRef<boolean | null>(null);
  useEffect(() => {
    if (!selectMode) { setSelected(new Set()); paint.current = null; return; }
    const end = () => { paint.current = null; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [selectMode]);
  const setOne = (id: StepId, on: boolean) => setSelected((cur) => {
    if (cur.has(id) === on) return cur;
    const next = new Set(cur);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const toggle = (id: StepId) => setOne(id, !selected.has(id));
  const startPaint = (id: StepId) => { const on = !selected.has(id); paint.current = on; setOne(id, on); };
  const sweep = (id: StepId) => { if (paint.current != null) setOne(id, paint.current); };
  // Only ids still in the list count (a row may have gone meanwhile).
  const selectedIds = store.steps.map((s) => s.id).filter((id) => selected.has(id));
  const shown = store.steps.filter((s) => !filter || filter(s));

  async function deleteSelected() {
    const n = selectedIds.length;
    if (n === 0) return;
    if (!confirm(`Delete ${n === 1 ? 'this step' : `these ${n} steps`}? This cannot be undone.`)) return;
    await store.removeMany(selectedIds);
    setSelected(new Set());
  }

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
      {selectMode && store.steps.length > 0 && (
        <div className="step-select-bar" role="toolbar" aria-label="Selected steps">
          <strong>{selectedIds.length} selected</strong>
          <button
            type="button"
            className="chip"
            onClick={() => setSelected(new Set(shown.map((s) => s.id)))}
            disabled={store.busy || shown.length === 0}
            title={hidden > 0 ? 'Tick every step the filter shows' : 'Tick every step'}
          >
            select all{hidden > 0 ? ' shown' : ''}
          </button>
          <button type="button" className="chip" onClick={() => setSelected(new Set())} disabled={store.busy || selectedIds.length === 0}>
            clear
          </button>
          <button
            type="button"
            className="chip step-select-delete"
            onClick={() => void deleteSelected()}
            disabled={store.busy || selectedIds.length === 0}
            title="Remove the ticked steps from the scenario"
          >
            🗑 delete {selectedIds.length > 0 ? `${selectedIds.length} ` : ''}selected
          </button>
          <span className="muted">tick a box, or press one and sweep down the list</span>
        </div>
      )}
      {store.steps.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <SortableContext items={store.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className={`step-list${selectMode ? ' step-list-selecting' : ''}`} ref={listRef}>
            {store.steps.map((s, idx) => filter && !filter(s) ? null : (
              <StepRow
                key={s.id}
                step={s}
                idx={idx}
                total={store.steps.length}
                busy={store.busy}
                pickDragging={activePick != null}
                selectMode={selectMode}
                selected={selected.has(s.id)}
                onToggle={() => toggle(s.id)}
                onPaintStart={() => startPaint(s.id)}
                onSweep={() => sweep(s.id)}
                onEdit={() => setEditing(s)}
                onUpdate={(payload) => store.update(s.id, payload)}
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

// A navigate step's URL in a popup window: Chrome renders `popup` windows
// without tabs or toolbar, so the page shows as the scenario sees it. Sized
// like the run's desktop viewport; the browser may clamp it to the screen.
// One named window, so repeated clicks reuse it instead of stacking.
// `noopener`: the external page gets no handle on this app's window.
function openPopup(url: string): void {
  window.open(url, 'eab-step-preview', 'popup=yes,width=1440,height=900,noopener,noreferrer');
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
  selectMode,
  selected,
  onToggle,
  onPaintStart,
  onSweep,
  onEdit,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  step: EditableStep;
  idx: number;
  total: number;
  busy: boolean;
  pickDragging: boolean;
  selectMode: boolean;
  selected: boolean;
  /** Flip this row's box (keyboard). */
  onToggle: () => void;
  /** Flip this row's box and start painting that state over the rows swept next. */
  onPaintStart: () => void;
  /** The pointer entered this row; takes the painted state if a sweep is on. */
  onSweep: () => void;
  onEdit: () => void;
  /** Replace the payload; rejects with a message when the store refuses it. */
  onUpdate: (payload: Record<string, unknown>) => Promise<void>;
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
  const field = step.invalid ? null : inlineField(step.kind, step.payload);
  const liClass = [insertBefore ? 'step-insert-before' : '', selectMode && selected ? 'step-selected' : ''].filter(Boolean).join(' ');
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-step-id={String(step.id)}
      className={liClass || undefined}
      onPointerEnter={selectMode ? onSweep : undefined}
    >
      {selectMode && (
        // The box is driven by the pointer handlers (so a press can start a
        // sweep without the native toggle fighting it); the keyboard toggles.
        <span
          className="step-select"
          onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); onPaintStart(); } }}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => e.preventDefault()}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggle(); } }}
            aria-label={`Select step ${idx + 1}`}
          />
        </span>
      )}
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
        {step.payload.optional === true && (
          <span className="muted" title="Optional: a failure is logged and the run continues with the next step" style={{ fontSize: 11, marginRight: 4 }}>
            (optional)
          </span>
        )}
        {step.invalid ? (
          <span className="error" title="Edit the payload JSON with ✎, or delete the step">
            invalid step — {step.invalid}
          </span>
        ) : field ? (
          <InlineValue step={step} field={field} busy={busy} onUpdate={onUpdate} />
        ) : (
          summarizeStep(step.kind, step.payload)
        )}
        {step.kind === 'navigate' && typeof step.payload.url === 'string' && step.payload.url && (
          <button
            className="step-open"
            title="Open this URL in a small browser window (no tabs or toolbar) to look at the page yourself"
            onClick={() => openPopup(String(step.payload.url))}
          >
            ↗
          </button>
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

// The row's summary, editable in place on its one inline field (see
// inlineField): click the text to get an input, Enter or blur saves, Escape
// cancels. A rejected save keeps the input open with the message beside it.
function InlineValue({
  step, field, busy, onUpdate,
}: {
  step: EditableStep;
  field: NonNullable<ReturnType<typeof inlineField>>;
  busy: boolean;
  onUpdate: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click away would save twice; the blur during a save is dropped.
  const saving = useRef(false);
  const current = step.payload[field.key];
  const currentText = current == null ? '' : String(current);

  async function save() {
    if (draft == null || saving.current) return;
    const text = draft.trim();
    if (text === currentText) { setDraft(null); setError(null); return; }
    const next = { ...step.payload };
    if (field.type === 'number') {
      const n = Number(text);
      if (!text || !Number.isFinite(n)) { setError('enter a number'); return; }
      next[field.key] = n;
    } else if (!text && field.optional) {
      delete next[field.key];
    } else {
      next[field.key] = text;
    }
    saving.current = true;
    try {
      await onUpdate(next);
      setDraft(null);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      saving.current = false;
    }
  }

  if (draft == null) {
    return (
      <span
        className="step-inline"
        role="button"
        tabIndex={0}
        title={`Click to edit the ${field.label}`}
        onClick={() => { if (!busy) { setDraft(currentText); setError(null); } }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { setDraft(currentText); setError(null); } }}
      >
        {summarizeStep(step.kind, step.payload)}
      </span>
    );
  }
  return (
    <span className="step-inline-edit">
      <input
        autoFocus
        type={field.type}
        value={draft}
        placeholder={field.label}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.preventDefault(); setDraft(null); setError(null); }
        }}
      />
      {error && <span className="error">{error}</span>}
    </span>
  );
}

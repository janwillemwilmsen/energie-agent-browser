import { useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { A11yNode, A11yTree, SelectorStrategy } from './api.js';
import type { PickDragData } from './stepEditor/StepDnd.js';

function flatten(
  node: A11yNode,
  depth: number,
  ancestors: A11yNode[],
): { node: A11yNode; depth: number; ancestors: A11yNode[] }[] {
  const out: { node: A11yNode; depth: number; ancestors: A11yNode[] }[] = [];
  if (node.role !== 'root') out.push({ node, depth, ancestors });
  for (const child of node.children) {
    out.push(...flatten(child, depth + 1, [...ancestors, node]));
  }
  return out;
}

function buildStrategy(
  node: A11yNode,
  ancestors: A11yNode[],
  siblings: A11yNode[],
): SelectorStrategy {
  const strategy: SelectorStrategy = { role: node.role, name: node.name };
  const sameRoleName = siblings.filter(
    (s) => s.role === node.role && s.name === node.name,
  );
  if (sameRoleName.length > 1) {
    strategy.ordinal = sameRoleName.indexOf(node);
  }
  const landmarkRoles = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form',
  ]);
  const path: { role: string; name: string }[] = [];
  for (const a of ancestors) {
    if (landmarkRoles.has(a.role) && a.name) path.push({ role: a.role, name: a.name });
  }
  if (path.length) strategy.ancestorPath = path;
  return strategy;
}

// Roles where agent-browser's `select <ref> <value>` applies — the native
// <select> element itself. Its `option` children are not clickable (options
// of a closed dropdown have no box model), so option rows get a `select`
// button that targets their parent dropdown with the label pre-filled.
const SELECT_ROLES = new Set(['combobox', 'listbox']);

// Roles where agent-browser's state-aware `check` / `uncheck` apply. Preferred
// over `click` for checkboxes: click toggles blindly, check/uncheck assert the
// desired end state (no-op when already there). Radios can only be checked —
// unchecking happens by checking a sibling — so they get no uncheck button.
const CHECKABLE_ROLES = new Set(['checkbox', 'switch']);

// Nearest dropdown ancestor of an option node (index into `ancestors`), or -1.
function nearestSelectAncestor(ancestors: A11yNode[]): number {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (SELECT_ROLES.has(ancestors[i]!.role)) return i;
  }
  return -1;
}

/** A pick = one step kind applied to one snapshot node. */
export interface Pick {
  kind: string;
  selector: SelectorStrategy;
  /** Pre-filled value (an option row's label for `select`). */
  value?: string;
}

export interface SnapshotPickerProps {
  tree: A11yTree;
  /** Step kinds the caller allows; each row offers the ones that apply to it. */
  kinds: ReadonlySet<string>;
  /** Whether a node may be picked as a `wait` target. */
  selectorWait: boolean;
  /**
   * Turn a pick into a step payload — this is where `type`/`fill`/`select`
   * prompt for their text. Null means the user cancelled.
   */
  buildPayload: (pick: Pick) => Record<string, unknown> | null;
  /** A pick button was clicked: append the step. */
  onPick: (kind: string, payload: Record<string, unknown>) => void;
}

export function SnapshotPicker(props: SnapshotPickerProps) {
  const { tree, kinds, selectorWait, buildPayload, onPick } = props;
  const flat = useMemo(() => flatten(tree.root, 0, []), [tree]);
  const allNodes = useMemo(() => flat.map((x) => x.node), [flat]);

  return (
    <ul className="a11y-tree">
      {flat.map((entry, idx) => {
        const { node, depth, ancestors } = entry;
        const strategy = node.ref ? buildStrategy(node, ancestors, allNodes) : null;
        const label = `${node.role}${node.name ? ` "${node.name}"` : ''}`;
        // The buttons this row offers, in display order.
        const picks: { pick: Pick; text: string; title?: string }[] = [];
        if (strategy) {
          const base = (kind: string, text = kind, title?: string, extra: Partial<Pick> = {}) => {
            if (kinds.has(kind)) picks.push({ pick: { kind, selector: strategy, ...extra }, text, title });
          };
          base('click');
          base('type');
          base('fill');
          if (SELECT_ROLES.has(node.role)) {
            base('select', 'select', 'Pick an option in this dropdown by its label');
          }
          if (node.role === 'option' && kinds.has('select')) {
            // Prefer targeting the ref-addressable dropdown ancestor
            // (combobox/listbox). When the a11y tree exposes none (e.g.
            // Chromium's MenuListPopup shape), store the OPTION itself — the
            // runner then sets the parent <select> via a JS fallback.
            const i = nearestSelectAncestor(ancestors);
            const target = i === -1 ? strategy : buildStrategy(ancestors[i]!, ancestors.slice(0, i), allNodes);
            picks.push({
              pick: { kind: 'select', selector: target, value: node.name },
              text: 'select',
              title: 'Select this option in its dropdown',
            });
          }
          if (CHECKABLE_ROLES.has(node.role) || node.role === 'radio') {
            base('check', 'check', 'Check this box (state-aware: no-op when already checked — prefer over click)');
          }
          if (CHECKABLE_ROLES.has(node.role)) {
            base('uncheck', 'uncheck', 'Uncheck this box (state-aware: no-op when already unchecked — prefer over click)');
          }
          if (selectorWait) base('wait');
          base('scroll', 'scrollIntoView', 'Scroll this element into view');
        }
        return (
          <li key={idx} style={{ paddingLeft: depth * 14 }}>
            <span className="role">{node.role}</span>
            {node.name && <span className="name">"{node.name}"</span>}
            {node.ref && <span className="ref">{node.ref}</span>}
            {picks.length > 0 && (
              <span className="picker">
                {picks.map(({ pick, text, title }) => (
                  <PickButton
                    key={text}
                    id={`pick:${idx}:${text}`}
                    label={label}
                    pick={pick}
                    text={text}
                    title={title}
                    buildPayload={buildPayload}
                    onPick={onPick}
                  />
                ))}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// One pick button: click appends the step; drag it onto the step list to
// insert it at a chosen position (see stepEditor/StepDnd.tsx). The drag data
// carries `build` so the payload (and any prompt) happens at drop time.
function PickButton({
  id,
  label,
  pick,
  text,
  title,
  buildPayload,
  onPick,
}: {
  id: string;
  label: string;
  pick: Pick;
  text: string;
  title?: string;
  buildPayload: SnapshotPickerProps['buildPayload'];
  onPick: SnapshotPickerProps['onPick'];
}) {
  const data: PickDragData = { type: 'pick', kind: pick.kind, label, build: () => buildPayload(pick) };
  const { listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  return (
    <button
      ref={setNodeRef}
      // Pointer only: Enter/Space must stay a plain click, not a keyboard drag.
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
      className={isDragging ? 'dragging' : undefined}
      title={`${title ?? `Add a ${pick.kind} step for this element`} — click to add at the end, or drag into the step list`}
      onClick={() => {
        const payload = buildPayload(pick);
        if (payload) onPick(pick.kind, payload);
      }}
    >
      {text}
    </button>
  );
}

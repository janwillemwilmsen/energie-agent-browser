import { useMemo } from 'react';
import type { A11yNode, A11yTree, SelectorStrategy } from './api.js';

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

// Nearest dropdown ancestor of an option node (index into `ancestors`), or -1.
function nearestSelectAncestor(ancestors: A11yNode[]): number {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (SELECT_ROLES.has(ancestors[i]!.role)) return i;
  }
  return -1;
}

export interface SnapshotPickerProps {
  tree: A11yTree;
  onPickClick?: (s: SelectorStrategy) => void;
  onPickType?: (s: SelectorStrategy) => void;
  onPickFill?: (s: SelectorStrategy) => void;
  onPickSelect?: (s: SelectorStrategy, value?: string) => void;
  onPickWait?: (s: SelectorStrategy) => void;
  onPickScroll?: (s: SelectorStrategy) => void;
}

export function SnapshotPicker(props: SnapshotPickerProps) {
  const { tree, onPickClick, onPickType, onPickFill, onPickSelect, onPickWait, onPickScroll } =
    props;
  const flat = useMemo(() => flatten(tree.root, 0, []), [tree]);
  const allNodes = useMemo(() => flat.map((x) => x.node), [flat]);

  return (
    <ul className="a11y-tree">
      {flat.map((entry, idx) => {
        const { node, depth, ancestors } = entry;
        const strategy = node.ref ? buildStrategy(node, ancestors, allNodes) : null;
        return (
          <li key={idx} style={{ paddingLeft: depth * 14 }}>
            <span className="role">{node.role}</span>
            {node.name && <span className="name">"{node.name}"</span>}
            {node.ref && <span className="ref">{node.ref}</span>}
            {strategy && (
              <span className="picker">
                {onPickClick && (
                  <button onClick={() => onPickClick(strategy)}>click</button>
                )}
                {onPickType && (
                  <button onClick={() => onPickType(strategy)}>type</button>
                )}
                {onPickFill && (
                  <button onClick={() => onPickFill(strategy)}>fill</button>
                )}
                {onPickSelect && SELECT_ROLES.has(node.role) && (
                  <button
                    onClick={() => onPickSelect(strategy)}
                    title="Pick an option in this dropdown by its label"
                  >
                    select
                  </button>
                )}
                {onPickSelect &&
                  node.role === 'option' &&
                  (() => {
                    // Prefer targeting the ref-addressable dropdown ancestor
                    // (combobox/listbox). When the a11y tree exposes none
                    // (e.g. Chromium's MenuListPopup shape), store the OPTION
                    // itself — the runner then sets the parent <select> via a
                    // JS fallback instead of the ref-based CLI command.
                    const i = nearestSelectAncestor(ancestors);
                    const target =
                      i === -1
                        ? strategy
                        : buildStrategy(ancestors[i]!, ancestors.slice(0, i), allNodes);
                    return (
                      <button
                        onClick={() => onPickSelect(target, node.name)}
                        title="Select this option in its dropdown"
                      >
                        select
                      </button>
                    );
                  })()}
                {onPickWait && (
                  <button onClick={() => onPickWait(strategy)}>wait</button>
                )}
                {onPickScroll && (
                  <button
                    onClick={() => onPickScroll(strategy)}
                    title="Scroll this element into view"
                  >
                    scrollIntoView
                  </button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

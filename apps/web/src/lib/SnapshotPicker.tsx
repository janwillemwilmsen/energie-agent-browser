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

export interface SnapshotPickerProps {
  tree: A11yTree;
  onPickClick?: (s: SelectorStrategy) => void;
  onPickType?: (s: SelectorStrategy) => void;
  onPickFill?: (s: SelectorStrategy) => void;
  onPickWait?: (s: SelectorStrategy) => void;
  onPickScroll?: (s: SelectorStrategy) => void;
}

export function SnapshotPicker(props: SnapshotPickerProps) {
  const { tree, onPickClick, onPickType, onPickFill, onPickWait, onPickScroll } = props;
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

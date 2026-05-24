import type { A11yNode, A11yTree, SelectorStrategy } from '@eab/shared';

export class SelectorNotFoundError extends Error {
  candidates: A11yNode[];
  constructor(strategy: SelectorStrategy, candidates: A11yNode[]) {
    super(
      `No matching element for selector { role: "${strategy.role}", name: "${strategy.name}" } (candidates: ${candidates.length})`,
    );
    this.candidates = candidates;
  }
}

export class SelectorAmbiguousError extends Error {
  candidates: A11yNode[];
  constructor(strategy: SelectorStrategy, candidates: A11yNode[]) {
    super(
      `Ambiguous selector { role: "${strategy.role}", name: "${strategy.name}" }: ${candidates.length} candidates remain after filtering`,
    );
    this.candidates = candidates;
  }
}

function walk(node: A11yNode, visit: (n: A11yNode, parents: A11yNode[]) => void): void {
  const stack: { node: A11yNode; parents: A11yNode[] }[] = [{ node, parents: [] }];
  while (stack.length) {
    const { node, parents } = stack.pop()!;
    visit(node, parents);
    const nextParents = [...parents, node];
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, parents: nextParents });
    }
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function matchesAncestorPath(
  ancestors: A11yNode[],
  path: { role: string; name: string }[],
): boolean {
  if (path.length === 0) return true;
  let i = path.length - 1;
  for (let j = ancestors.length - 1; j >= 0 && i >= 0; j--) {
    const ancestor = ancestors[j]!;
    const want = path[i]!;
    if (ancestor.role === want.role && norm(ancestor.name) === norm(want.name)) {
      i--;
    }
  }
  return i < 0;
}

/**
 * Find a fresh ref for the given strategy in the supplied tree.
 *
 * Algorithm:
 *   1. Filter by role (case-insensitive exact match).
 *   2. Among those, exact-trim match on accessible name (case-insensitive).
 *   3. If multiple remain, require textContains (case-insensitive substring of name or text).
 *   4. If multiple remain, require ancestorPath match.
 *   5. If multiple remain, use ordinal (0-indexed in document order).
 *
 * Throws SelectorNotFoundError or SelectorAmbiguousError with the surviving candidates.
 */
export function resolveSelector(strategy: SelectorStrategy, tree: A11yTree): string {
  const all: { node: A11yNode; ancestors: A11yNode[] }[] = [];
  walk(tree.root, (node, parents) => {
    all.push({ node, ancestors: parents });
  });

  const wantRole = norm(strategy.role);
  const wantName = norm(strategy.name);

  let candidates = all.filter(
    (c) => norm(c.node.role) === wantRole && norm(c.node.name) === wantName,
  );

  if (candidates.length === 0) {
    const roleMatches = all.filter((c) => norm(c.node.role) === wantRole).map((c) => c.node);
    throw new SelectorNotFoundError(strategy, roleMatches);
  }

  if (candidates.length > 1 && strategy.textContains) {
    const needle = norm(strategy.textContains);
    candidates = candidates.filter(
      (c) =>
        norm(c.node.name).includes(needle) ||
        norm(c.node.text ?? '').includes(needle),
    );
  }

  if (candidates.length === 0) {
    throw new SelectorNotFoundError(strategy, []);
  }

  if (candidates.length > 1 && strategy.ancestorPath && strategy.ancestorPath.length > 0) {
    candidates = candidates.filter((c) =>
      matchesAncestorPath(c.ancestors, strategy.ancestorPath!),
    );
  }

  if (candidates.length === 0) {
    throw new SelectorNotFoundError(strategy, []);
  }

  if (candidates.length > 1 && typeof strategy.ordinal === 'number') {
    const idx = strategy.ordinal;
    if (idx < 0 || idx >= candidates.length) {
      throw new SelectorNotFoundError(strategy, candidates.map((c) => c.node));
    }
    candidates = [candidates[idx]!];
  }

  if (candidates.length > 1) {
    throw new SelectorAmbiguousError(
      strategy,
      candidates.map((c) => c.node),
    );
  }

  const winner = candidates[0]!.node;
  if (!winner.ref) {
    throw new SelectorNotFoundError(strategy, [winner]);
  }
  return winner.ref;
}

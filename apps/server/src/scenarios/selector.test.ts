import { describe, it, expect } from 'vitest';
import type { A11yTree } from '@eab/shared';
import { parseSnapshotText } from '../agentBrowser/parser.js';
import {
  resolveSelector,
  SelectorAmbiguousError,
  SelectorNotFoundError,
} from './selector.js';

const exampleSnapshot = `- heading "Example Domain" [level=1, ref=e1]
- paragraph
  - StaticText "This domain is for use in documentation examples without needing permission. Avoid use in operations."
- paragraph
  - link "Learn more" [ref=e2]`;

const tree: A11yTree = parseSnapshotText(exampleSnapshot, 'https://example.com/');

describe('parseSnapshotText', () => {
  it('extracts top-level nodes', () => {
    expect(tree.root.children.map((c) => c.role)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
    ]);
  });

  it('attaches refs in @eN form', () => {
    const heading = tree.root.children[0]!;
    expect(heading.ref).toBe('@e1');
    expect(heading.name).toBe('Example Domain');
  });

  it('nests children by indent', () => {
    const lastPara = tree.root.children[2]!;
    expect(lastPara.children).toHaveLength(1);
    expect(lastPara.children[0]!.role).toBe('link');
    expect(lastPara.children[0]!.ref).toBe('@e2');
  });
});

describe('resolveSelector', () => {
  it('returns the ref for an exact role+name match', () => {
    const ref = resolveSelector(
      { role: 'heading', name: 'Example Domain' },
      tree,
    );
    expect(ref).toBe('@e1');
  });

  it('returns the ref for a nested link', () => {
    const ref = resolveSelector(
      { role: 'link', name: 'Learn more' },
      tree,
    );
    expect(ref).toBe('@e2');
  });

  it('is case-insensitive on role and name', () => {
    expect(
      resolveSelector({ role: 'LINK', name: 'learn MORE' }, tree),
    ).toBe('@e2');
  });

  it('throws NotFound when nothing matches', () => {
    expect(() =>
      resolveSelector({ role: 'button', name: 'Submit' }, tree),
    ).toThrow(SelectorNotFoundError);
  });

  it('disambiguates via ordinal', () => {
    const dup = parseSnapshotText(
      `- link "Same" [ref=e1]\n- link "Same" [ref=e2]`,
      '',
    );
    expect(
      resolveSelector({ role: 'link', name: 'Same', ordinal: 0 }, dup),
    ).toBe('@e1');
    expect(
      resolveSelector({ role: 'link', name: 'Same', ordinal: 1 }, dup),
    ).toBe('@e2');
  });

  it('throws Ambiguous when multiple match and no disambiguator', () => {
    const dup = parseSnapshotText(
      `- link "Same" [ref=e1]\n- link "Same" [ref=e2]`,
      '',
    );
    expect(() => resolveSelector({ role: 'link', name: 'Same' }, dup)).toThrow(
      SelectorAmbiguousError,
    );
  });

  it('uses ancestorPath to disambiguate', () => {
    const nested = parseSnapshotText(
      `- navigation "Top" [ref=e10]
  - link "Home" [ref=e1]
- navigation "Footer" [ref=e11]
  - link "Home" [ref=e2]`,
      '',
    );
    expect(
      resolveSelector(
        {
          role: 'link',
          name: 'Home',
          ancestorPath: [{ role: 'navigation', name: 'Footer' }],
        },
        nested,
      ),
    ).toBe('@e2');
  });
});

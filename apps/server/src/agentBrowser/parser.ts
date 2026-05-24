import type { A11yNode, A11yTree } from '@eab/shared';

interface ParsedLine {
  indent: number;
  role: string;
  name: string;
  ref: string;
  attrs: Record<string, string>;
}

const LINE_RE = /^(?<indent>\s*)- (?<role>[A-Za-z][A-Za-z0-9_]*)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?:\s+\[(?<attrs>[^\]]+)\])?\s*$/;

function parseAttrs(s: string | undefined): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const part of s.split(/,\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      out[key] = val;
    } else if (part.trim()) {
      out[part.trim()] = 'true';
    }
  }
  return out;
}

function parseLine(line: string): ParsedLine | null {
  const m = LINE_RE.exec(line);
  if (!m || !m.groups) return null;
  const indent = (m.groups.indent ?? '').length;
  const attrs = parseAttrs(m.groups.attrs);
  const ref = attrs.ref ?? '';
  return {
    indent,
    role: m.groups.role ?? '',
    name: (m.groups.name ?? '').replace(/\\"/g, '"'),
    ref: ref ? '@' + ref : '',
    attrs,
  };
}

/**
 * Parse the YAML-style snapshot text produced by `agent-browser snapshot`.
 *
 * Example input:
 *   - heading "Example Domain" [level=1, ref=e1]
 *   - paragraph
 *     - StaticText "..."
 *   - paragraph
 *     - link "Learn more" [ref=e2]
 */
export function parseSnapshotText(text: string, url: string): A11yTree {
  const root: A11yNode = { ref: '', role: 'root', name: '', children: [] };
  const stack: { node: A11yNode; indent: number }[] = [{ node: root, indent: -1 }];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;

    const node: A11yNode = {
      ref: parsed.ref,
      role: parsed.role,
      name: parsed.name,
      children: [],
    };
    if (parsed.role === 'StaticText') node.text = parsed.name;
    if (parsed.attrs.value) node.value = parsed.attrs.value;

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= parsed.indent) {
      stack.pop();
    }
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ node, indent: parsed.indent });
  }

  return { root, capturedAt: new Date().toISOString(), url };
}

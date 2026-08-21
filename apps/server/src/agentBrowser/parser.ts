import type { A11yNode, A11yTree } from '@eab/shared';

interface ParsedLine {
  indent: number;
  role: string;
  name: string;
  ref: string;
  attrs: Record<string, string>;
  value: string | undefined;
}

// Nodes with a current value (filled textbox, combobox with a selection) get a
// `: value` suffix after the attrs block, e.g.
//   - textbox "URL" [required, ref=e4]: https://
// so the trailing `(?:: value)?` group must be part of the line shape — a
// regex anchored right after `[attrs]` would drop exactly the filled-in
// inputs a user most wants to target.
//
// agent-browser 0.34 additionally appends bare annotation tokens after the
// attrs block on some nodes, e.g.
//   - generic [ref=e1] clickable [onclick]
// The annotations group tolerates any run of ` word` / ` [block]` tokens there
// (they carry no data we use). It can't eat a `: value` suffix because values
// start with a colon directly after the preceding block, never with a space.
const LINE_RE = /^(?<indent>\s*)- (?<role>[A-Za-z][A-Za-z0-9_]*)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?:\s+\[(?<attrs>[^\]]+)\])?(?:\s+(?:[A-Za-z][\w-]*|\[[^\]]+\]))*(?::\s?(?<value>.*?))?\s*$/;

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
    value: m.groups.value,
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
    const value = parsed.attrs.value ?? parsed.value;
    if (value) node.value = value;

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= parsed.indent) {
      stack.pop();
    }
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ node, indent: parsed.indent });
  }

  return { root, capturedAt: new Date().toISOString(), url };
}

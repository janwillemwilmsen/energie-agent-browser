import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// A file a save_text step wrote, as the Texts page and the run panel show it.
// Every file starts with an HTML comment header
// (`label · what · viewport · url · time`), then the body: Markdown for the
// page text and the accessibility report, the document itself for .html.

export type SavedTextKind = 'text' | 'html' | 'a11y';

export interface ParsedSavedText {
  /** The header's inner text, or null when the file has none. */
  header: string | null;
  body: string;
  kind: SavedTextKind;
}

/** Split the header off and tell what the file holds (from its name and header). */
export function parseSavedText(content: string, file: string): ParsedSavedText {
  const m = /^<!--\s*(.*?)\s*-->\n*/.exec(content);
  const header = m ? m[1]! : null;
  const body = m ? content.slice(m[0].length) : content;
  const kind: SavedTextKind = /\.html$/i.test(file)
    ? 'html'
    : header?.split('·').map((s) => s.trim())[1] === 'a11y report' ? 'a11y' : 'text';
  return { header, body, kind };
}

export const SAVED_TEXT_KIND_LABEL: Record<SavedTextKind, string> = {
  text: 'text',
  html: 'html',
  a11y: 'a11y report',
};

// An accessibility report ends with the engine's raw JSON under this heading
// (see stepExecutor's captureA11yReport). It is long and rarely read, so the
// viewer folds it into a closed <details> below the rendered report.
const RAW_HEADING = /^## Raw result \(JSON\)\s*$/m;
export function splitRawSection(md: string): { main: string; raw: string | null } {
  const m = RAW_HEADING.exec(md);
  if (!m) return { main: md, raw: null };
  return { main: md.slice(0, m.index).replace(/\s+$/, ''), raw: md.slice(m.index + m[0].length).trim() };
}

// Every link in a saved text points out of the app (the audited page, a
// deque help page), so they open in a new tab and leave the reader in place.
const mdComponents: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
};

/**
 * The body of a saved text: rendered Markdown (with the raw JSON of a report
 * folded away), or the text as is when `raw` is set or the file is HTML.
 */
export function SavedTextBody({ body, kind, raw = false }: { body: string; kind: SavedTextKind; raw?: boolean }) {
  const sections = useMemo(() => splitRawSection(body), [body]);
  if (raw || kind === 'html') return <pre className="texts-raw">{body}</pre>;
  return (
    <div className="aui-md texts-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{sections.main}</ReactMarkdown>
      {sections.raw !== null && (
        <details className="texts-details">
          <summary>Raw result (JSON)</summary>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{sections.raw}</ReactMarkdown>
        </details>
      )}
    </div>
  );
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

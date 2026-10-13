import type { SelectorStrategy } from '../api.js';

// Human label for a selector: role "name", plus the locator / ordinal when
// present so you can see at a glance how a step will be targeted.
export function selectorLabel(s: Partial<SelectorStrategy> | null | undefined): string {
  if (s?.find) {
    const f = s.find;
    return `find ${f.by} "${f.value}"${f.name ? ` name "${f.name}"` : ''}${f.exact ? ' (exact)' : ''}`;
  }
  const base = s?.role || s?.name ? `${s.role ?? ''} "${s.name ?? ''}"` : '';
  const extra = s?.locator ? `${s.locator}` : typeof s?.ordinal === 'number' ? `#${s.ordinal}` : '';
  return [base, extra].filter(Boolean).join(' ');
}

// A URL short enough for a button label: origin + the start of the path, with
// the middle elided. The full URL belongs in the title/tooltip.
export function shortUrl(url: string, max = 56): string {
  if (url.length <= max) return url;
  try {
    const u = new URL(url);
    const rest = url.slice(u.origin.length);
    const room = Math.max(8, max - u.origin.length - 1);
    return `${u.origin}${rest.slice(0, room)}…`;
  } catch {
    return `${url.slice(0, max - 1)}…`;
  }
}

// The one payload field a Step kind can be edited on in place, in the list
// row: the label of a screenshot or text file, a wait's duration, a URL, the
// text to type. Everything else still goes through the edit modal. `optional`
// fields are removed from the payload when cleared.
export interface InlineField {
  key: string;
  label: string;
  type: 'text' | 'number';
  optional?: boolean;
}

export function inlineField(kind: string, p: Record<string, unknown>): InlineField | null {
  switch (kind) {
    case 'screenshot':
    case 'save_text':
    case 'pause':
      return { key: 'label', label: 'label', type: 'text', optional: true };
    case 'wait':
      return p.selector ? null : { key: 'ms', label: 'ms', type: 'number' };
    case 'navigate':
      return { key: 'url', label: 'URL', type: 'text' };
    case 'type':
      return { key: 'text', label: 'text', type: 'text' };
    case 'fill':
    case 'select':
      return { key: 'value', label: 'value', type: 'text' };
    case 'press':
      return { key: 'key', label: 'key', type: 'text' };
    default:
      return null;
  }
}

// One-line summary of a Step for the editor list. Works on the loose payload
// shape so an unknown key or an odd stored value still renders something.
export function summarizeStep(kind: string, p: Record<string, unknown>): string {
  const sel = p.selector as Partial<SelectorStrategy> | undefined;
  switch (kind) {
    case 'navigate':
      return `→ ${p.url ?? ''}`;
    case 'click':
    case 'check':
    case 'uncheck':
      return selectorLabel(sel);
    case 'type':
      return `${selectorLabel(sel)} ${JSON.stringify(p.text ?? '')}`;
    case 'fill':
      return `${selectorLabel(sel)} ${JSON.stringify(p.value ?? '')}`;
    case 'select':
      return `${selectorLabel(sel)} → ${JSON.stringify(p.value ?? '')}`;
    case 'screenshot': {
      const format = typeof p.format === 'string' && p.format !== 'png' ? p.format : null;
      return `${p.label ?? 'screenshot'}${p.fullPage ? (p.expandScrollers ? ' (full, expanded)' : ' (full)') : ''}${p.viewport === 'mobile' ? ` (mobile${p.device ? `: ${p.device}` : ''})` : ''}${p.zoom ? ` (zoom ${p.zoom}%)` : ''}${p.annotate ? ' (annotated)' : ''}${format ? ` (${format}${p.quality ? ` q${p.quality}` : ''})` : ''}`;
    }
    case 'scroll': {
      if (sel) return `into view: ${selectorLabel(sel)}`;
      if (p.toBottom) return 'to bottom (lazy-load)';
      if (p.toTop) return 'to top';
      const dy = Number(p.dy ?? 0);
      return dy ? `${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px` : '';
    }
    case 'wait':
      return sel ? `for ${selectorLabel(sel)}` : `${p.ms ?? 0}ms`;
    case 'evaluate':
      return String(p.js ?? '').slice(0, 60);
    case 'auth-login':
      return `🔐 auth profile "${p.name ?? ''}"`;
    case 'record_start':
    {
      const opts = [p.cursor === true ? 'pointer' : '', p.human === true ? 'human mouse' : ''].filter(Boolean);
      return `⏺ start video recording${opts.length ? ` (${opts.join(', ')})` : ''}`;
    }
    case 'record_stop':
      return '⏹ stop video recording';
    case 'close':
      return '✕ close browser session';
    case 'press':
      return `⌨ ${p.key ?? ''}`;
    case 'save_text':
      return `📄 save text${p.label ? ` "${p.label}"` : ''}`;
    case 'pause':
      return `⏸ pause${p.label ? ` "${p.label}"` : ''} — wait for Resume${p.timeoutMs ? ` (max ${Math.round(Number(p.timeoutMs) / 60000)} min)` : ''}`;
    default:
      return JSON.stringify(p);
  }
}

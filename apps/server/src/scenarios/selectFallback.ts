import { run } from '../agentBrowser/driver.js';
import type { SelectorStrategy } from '@eab/shared';

// Fallback path for `select` steps whose selector targets an `option` node
// rather than the dropdown element itself.
//
// Why this exists: Chromium's accessibility tree does not always expose a
// native <select> as a `combobox`. Some pages (e.g. LIT/custom-element forms)
// surface it as `generic → MenuListPopup → option...`, where only the options
// carry refs — there is no ref-addressable dropdown node for the CLI's
// `select <ref> <value>` command. And clicking an option ref can never work:
// options of a closed dropdown have no box model.
//
// So when a step stores the OPTION's selector, we set the parent <select>
// directly via JS: find the option by its label (piercing shadow roots),
// assign the select's value, and fire `input`/`change` so framework listeners
// (React/LIT/Vue) see a real user-like update.

export function isOptionSelector(selector: SelectorStrategy): boolean {
  return selector.role.trim().toLowerCase() === 'option';
}

function buildSelectOptionJs(label: string, ordinal: number): string {
  return `(() => {
  const label = ${JSON.stringify(label)};
  const wanted = ${ordinal};
  const selects = [];
  const walk = (root) => {
    for (const s of root.querySelectorAll('select')) selects.push(s);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const matches = [];
  for (const s of selects) {
    for (const o of Array.from(s.options)) {
      if ((o.label || o.textContent || '').trim() === label) matches.push({ s, o });
    }
  }
  if (matches.length === 0) return 'not-found';
  const m = matches[Math.min(wanted, matches.length - 1)];
  m.s.value = m.o.value;
  m.s.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  m.s.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return 'ok:' + m.o.value;
})()`;
}

export async function execSelectOptionFallback(
  session: string,
  selector: SelectorStrategy,
  value: string,
): Promise<void> {
  const label = (value || selector.name).trim();
  const js = buildSelectOptionJs(label, selector.ordinal ?? 0);
  const r = await run(['eval', js], { session, timeoutMs: 15_000 });
  if (r.exitCode !== 0) {
    throw new Error(`select (option fallback) failed: ${r.stderr || r.stdout}`);
  }
  if (!/ok:/.test(r.stdout)) {
    throw new Error(
      `select (option fallback): no <select> contains an option labelled ${JSON.stringify(label)} ` +
        `(searched the document including shadow roots)`,
    );
  }
}

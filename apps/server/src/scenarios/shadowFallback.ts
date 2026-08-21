import { run } from '../agentBrowser/driver.js';

// agent-browser (0.34) resolves CSS / text= / xpath= locators with a plain DOM
// query, which stops at shadow-root boundaries. Web-component pages (ing.nl,
// essent.nl, …) put their cookie dialogs and buttons several OPEN shadow
// roots deep, so a perfectly good `[data-testid='reject']` comes back as
// "Element not found" even though the snapshot ref for the same element works
// (the accessibility tree does see inside shadow roots).
//
// This is the fallback for that case: run a small script via `agent-browser
// eval` that walks document + every open shadow root, finds the element by the
// CSS locator, and performs the action in-page (synthetic click / value set +
// input/change events). Closed shadow roots stay unreachable — nothing can
// query those from outside. Only CSS locators are supported here; text= and
// xpath= have no deep-query equivalent.

export type FallbackAction =
  | 'click' | 'check' | 'uncheck' | 'fill' | 'type' | 'select' | 'scrollintoview' | 'exists';

export interface FallbackResult {
  ok: boolean;
  reason?: string;
  tag?: string;
}

// Does this CLI failure look like "the locator didn't resolve" (as opposed to
// a timeout, a covered element, a navigation, …)?
export function isElementNotFound(stderr: string, stdout = ''): boolean {
  return /element not found|no element found|unknown ref|not found:/i.test(`${stderr}\n${stdout}`);
}

// Strip an explicit engine prefix and tell whether what's left is CSS we can
// deep-query. Returns null for text=/xpath=/refs.
export function cssForDeepQuery(locator: string): string | null {
  const l = locator.trim();
  if (!l || l.startsWith('@')) return null;
  if (/^(text|xpath)=/i.test(l)) return null;
  if (/^css=/i.test(l)) return l.slice(4).trim() || null;
  // Playwright-style ">>>" piercing combinator: our deep walk already pierces,
  // so just use the last segment.
  if (l.includes('>>>')) return l.split('>>>').pop()!.trim() || null;
  return l;
}

function actionJs(action: FallbackAction, value: string | undefined): string {
  const v = JSON.stringify(value ?? '');
  switch (action) {
    case 'click':
      return `el.scrollIntoView({block:'center', inline:'center'}); el.click();`;
    case 'check':
    case 'uncheck':
      return `const want = ${action === 'check'}; el.scrollIntoView({block:'center'}); if (!!el.checked !== want) el.click();`;
    case 'fill':
    case 'type':
      // Use the native value setter so React/Lit/Angular bindings notice, then
      // fire composed input/change events so listeners outside the shadow
      // root (and framework state) update too.
      return `
        const v = ${v};
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set && ('value' in el)) d.set.call(el, v); else if ('value' in el) el.value = v; else el.textContent = v;
        el.dispatchEvent(new Event('input', {bubbles:true, composed:true}));
        el.dispatchEvent(new Event('change', {bubbles:true, composed:true}));`;
    case 'select':
      return `
        const v = ${v};
        const opts = Array.from(el.options || []);
        const o = opts.find(o => o.label === v || o.value === v || (o.text || '').trim() === v);
        if (!o) return JSON.stringify({ ok:false, reason:'option "' + v + '" not found in ' + opts.length + ' option(s)' });
        el.value = o.value;
        el.dispatchEvent(new Event('input', {bubbles:true, composed:true}));
        el.dispatchEvent(new Event('change', {bubbles:true, composed:true}));`;
    case 'scrollintoview':
      return `el.scrollIntoView({block:'center', inline:'center'});`;
    case 'exists':
      return ``;
  }
}

function buildScript(css: string, action: FallbackAction, value: string | undefined): string {
  return `(() => {
  const sel = ${JSON.stringify(css)};
  const findDeep = (root) => {
    let el = null;
    try { el = root.querySelector(sel); } catch (e) { return { error: 'invalid CSS selector: ' + e.message }; }
    if (el) return { el };
    for (const h of root.querySelectorAll('*')) {
      if (h.shadowRoot) {
        const r = findDeep(h.shadowRoot);
        if (r && (r.el || r.error)) return r;
      }
    }
    return null;
  };
  const r = findDeep(document);
  if (!r) return JSON.stringify({ ok:false, reason:'not found in document or any open shadow root' });
  if (r.error) return JSON.stringify({ ok:false, reason:r.error });
  const el = r.el;
  ${actionJs(action, value)}
  return JSON.stringify({ ok:true, tag: el.tagName.toLowerCase() });
})()`;
}

// `agent-browser eval` prints the expression's result; a returned string comes
// back JSON-quoted, so unwrap one or two layers defensively.
function parseEvalOutput(stdout: string): FallbackResult | null {
  let text = stdout.trim();
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') { text = parsed; continue; }
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed as FallbackResult;
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function runLocatorFallback(
  session: string,
  action: FallbackAction,
  locator: string,
  value?: string,
  timeoutMs = 15_000,
): Promise<FallbackResult> {
  const css = cssForDeepQuery(locator);
  if (!css) {
    return { ok: false, reason: 'only CSS locators can be deep-queried (not text=/xpath=/refs)' };
  }
  const r = await run(['eval', buildScript(css, action, value)], { session, timeoutMs });
  if (r.exitCode !== 0) {
    return { ok: false, reason: `eval failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
  }
  return parseEvalOutput(r.stdout) ?? { ok: false, reason: `unexpected eval output: ${r.stdout.trim().slice(0, 120)}` };
}

// Poll the deep query until the element exists (for `wait` steps with a locator).
export async function waitForLocatorFallback(
  session: string,
  locator: string,
  timeoutMs = 30_000,
  pollMs = 500,
): Promise<FallbackResult> {
  const deadline = Date.now() + timeoutMs;
  let last: FallbackResult = { ok: false, reason: 'not attempted' };
  while (Date.now() < deadline) {
    last = await runLocatorFallback(session, 'exists', locator);
    if (last.ok) return last;
    if (last.reason && /only CSS|invalid CSS/.test(last.reason)) return last; // no point polling
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last;
}

import type { Browser } from './stepExecutor.js';

// Full-page screenshots on "app shell" pages.
//
// Chrome's full-page capture sizes the image to the document's scroll height.
// Some sites (e.g. the Greenchoice sign-up funnel) pin <html>/<body> to the
// viewport height and scroll inside an inner <main overflow-y:auto>, so the
// document's scroll height IS the viewport height and `screenshot --full`
// comes out viewport-sized with the rest of the page cut off.
//
// The fix is a temporary layout change: give html/body and every scrolling
// container `overflow: visible; height: auto; max-height: none` so the
// document grows to the real content height, capture, then put every inline
// style back exactly as it was. The saved styles live on `window` so the
// restore runs in a separate `eval` after the capture.

const STASH = '__eabExpandedScrollers';

const EXPAND_JS = `(() => {
  if (window[${JSON.stringify(STASH)}]) return 'already';
  const saved = [];
  const unlock = (el) => {
    saved.push([el, el.getAttribute('style')]);
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('max-height', 'none', 'important');
  };
  unlock(document.documentElement);
  unlock(document.body);
  let inner = 0;
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    // Only real scroll containers with hidden content; fixed/sticky chrome
    // (headers, drawers) is left alone so it isn't stretched.
    if (!/(auto|scroll)/.test(s.overflowY)) continue;
    if (s.position === 'fixed') continue;
    if (el.scrollHeight <= el.clientHeight + 5) continue;
    unlock(el);
    inner++;
  }
  window[${JSON.stringify(STASH)}] = saved;
  return 'ok:' + inner + ':' + document.documentElement.scrollHeight;
})()`;

const RESTORE_JS = `(() => {
  const saved = window[${JSON.stringify(STASH)}];
  if (!saved) return 'nothing';
  for (const [el, style] of saved) {
    if (style == null) el.removeAttribute('style'); else el.setAttribute('style', style);
  }
  delete window[${JSON.stringify(STASH)}];
  return 'ok:' + saved.length;
})()`;

/**
 * Unlock inner scroll containers so the document grows to its content height.
 * Returns a short description for the run log; throws when eval itself fails.
 */
export async function expandScrollers(browser: Browser): Promise<string> {
  const r = await browser.run(['eval', EXPAND_JS], { timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new Error(`expand scrollers failed: ${r.stderr || r.stdout}`);
  const m = /ok:(\d+):(\d+)/.exec(r.stdout);
  return m ? `${m[1]} inner scroller(s) unlocked, document now ${m[2]}px tall` : r.stdout.trim();
}

/** Put every style touched by expandScrollers back. Best-effort by design. */
export async function restoreScrollers(browser: Browser): Promise<void> {
  await browser.run(['eval', RESTORE_JS], { timeoutMs: 15_000 });
}

import { run } from '../agentBrowser/driver.js';

// A pointer drawn INTO the page while a recording runs, so the screencast
// (and any screenshot taken meanwhile) shows where the mouse is and where it
// clicked. The app records by tapping the live screencast rather than
// `agent-browser record --cursor` (that opens a fresh context and loses the
// stealth setup), so the overlay is ours: a fixed, inert, aria-hidden arrow
// that follows mousemove and rings on mousedown.
//
// It is evaluated into the open page at record start and re-applied after
// every Step (the script is idempotent), because a navigation drops it and
// the installed agent-browser only takes init scripts at launch (newer
// versions have `addinitscript`, which would make the re-apply unnecessary).
// Removed at record stop.

const OVERLAY_JS = String.raw`(() => {
  if (window.__eabCursor) return;
  const SIZE = 22;
  const doc = document;
  const host = doc.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-eab-cursor', '');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const arrow = doc.createElement('div');
  arrow.style.cssText = 'position:absolute;left:0;top:0;width:' + SIZE + 'px;height:' + SIZE + 'px;display:none;' +
    'transform:translate(-2px,-2px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));';
  arrow.innerHTML = '<svg viewBox="0 0 24 24" width="' + SIZE + '" height="' + SIZE + '">' +
    '<path d="M4 2 L4 19 L8.5 14.8 L11.5 21.5 L14.3 20.3 L11.4 13.7 L18 13.7 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  host.appendChild(arrow);
  const mount = () => { if (!host.isConnected && doc.documentElement) doc.documentElement.appendChild(host); };
  const move = (e) => {
    arrow.style.display = 'block';
    arrow.style.left = e.clientX + 'px';
    arrow.style.top = e.clientY + 'px';
  };
  const ripple = (e) => {
    const r = doc.createElement('div');
    r.style.cssText = 'position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;' +
      'border:3px solid #38bdf8;background:rgba(56,189,248,.25);left:' + e.clientX + 'px;top:' + e.clientY + 'px;' +
      'transition:transform .45s ease-out,opacity .45s ease-out;transform:scale(.3);opacity:1;';
    host.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.2)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 500);
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mousedown', (e) => { move(e); ripple(e); }, true);
  mount();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount);
  // Some frameworks replace <html> children on hydration; keep the host attached.
  const mo = new MutationObserver(mount);
  mo.observe(doc.documentElement, { childList: true });
  window.__eabCursor = { remove() { mo.disconnect(); host.remove(); delete window.__eabCursor; } };
})();`;

const REMOVE_JS = `window.__eabCursor && window.__eabCursor.remove(); 'ok'`;

/** The cursor overlay in one session: re-applied after each Step, removed at record stop. */
export interface CursorOverlay {
  /** Put the pointer back if a navigation dropped it (no-op when present). */
  refresh(): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Draw the pointer into the open page. Best-effort — a failure logs and the
 * recording goes on without a pointer.
 */
export async function installCursorOverlay(
  session: string,
  log: (line: string) => void,
): Promise<CursorOverlay | null> {
  const apply = () => run(['eval', OVERLAY_JS], { session, timeoutMs: 15_000 });
  try {
    const r = await apply();
    if (r.exitCode !== 0) {
      log(`record cursor: not drawn (${(r.stderr || r.stdout).trim().split('\n')[0]})`);
      return null;
    }
  } catch (e: any) {
    log(`record cursor: not drawn (${e?.message ?? e})`);
    return null;
  }
  return {
    async refresh() {
      try { await apply(); } catch { /* between pages; the next refresh gets it */ }
    },
    async remove() {
      try { await run(['eval', REMOVE_JS], { session, timeoutMs: 10_000 }); } catch { /* page may be gone */ }
    },
  };
}

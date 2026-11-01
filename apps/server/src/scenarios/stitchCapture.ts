import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Browser } from './stepExecutor.js';

// Full-page capture by stitching, for browsers that cannot render one in a
// single surface.
//
// Chrome's `Page.captureScreenshot` with captureBeyondViewport renders the
// WHOLE page into one off-screen bitmap. A real, headed Chrome — the one a
// user's own PC drives through the connector — cannot do that for a long
// page: a 1440x44104 CSS-pixel page is a ~254 MB bitmap, and the command
// times out (measured) or wedges the tab. Headless Chrome copes, which is why
// the same scenario worked on browserless and fails on the user's own browser.
//
// So: scroll the page a viewport at a time, take ordinary VIEWPORT captures —
// which are small and fast everywhere — and compose them into the full image
// with sharp. It also sidesteps Chrome's 16384 px capture cap, which silently
// wrapped taller pages back to the top even on browserless.
//
// Two details decide whether the result looks right:
//   - Where a slice really landed. The last scroll is clamped at the bottom of
//     the document, so that slice overlaps its predecessor; each slice is
//     composed at the scroll position the page actually reported, so the
//     overlap paints over rather than leaving a gap.
//   - Fixed and sticky elements. A cookie bar or nav that stays glued to the
//     viewport would otherwise repeat in every slice. They are hidden after
//     the first slice and restored afterwards.

/** What the page reports about its own scrolling geometry, in CSS pixels. */
interface PageMetrics {
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  /** Device pixels per CSS pixel — the captures are in device pixels. */
  dpr: number;
}

export interface StitchOptions {
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Per agent-browser command. */
  timeoutMs?: number;
  /** Give the page this long to settle (lazy images, sticky reflow) after each scroll. */
  settleMs?: number;
  /** Refuse to compose an image taller than this, in device pixels. */
  maxHeightPx?: number;
  /** Hide position:fixed / sticky elements after the first slice. */
  hideFixed?: boolean;
}

export interface StitchResult {
  width: number;
  height: number;
  slices: number;
  /** True when the page was short enough to need a single viewport capture. */
  singleShot: boolean;
  /** Set when the page was taller than maxHeightPx and the capture was cut off. */
  truncatedFrom?: number;
}

// A composed image this tall is already ~250 MB of pixels; beyond it the risk
// is an out-of-memory on a small host rather than a useful screenshot.
const DEFAULT_MAX_HEIGHT_PX = 65_535;
const DEFAULT_SETTLE_MS = 120;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Run `eval` and return the raw stdout, or throw with the command's own message. */
async function evaluate(browser: Browser, js: string, timeoutMs: number): Promise<string> {
  const r = await browser.run(['eval', js], { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`eval failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/**
 * agent-browser prints an eval result as JSON, so a string result arrives
 * quoted (and a JSON payload arrives double-encoded). Unwrap one layer when
 * that is what we are looking at.
 */
export function parseEvalJson<T>(stdout: string): T {
  const text = stdout.trim();
  const once = JSON.parse(text) as unknown;
  return (typeof once === 'string' ? JSON.parse(once) : once) as T;
}

async function readMetrics(browser: Browser, timeoutMs: number): Promise<PageMetrics> {
  const js =
    'JSON.stringify({' +
    'scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),' +
    'viewportHeight: window.innerHeight,' +
    'viewportWidth: window.innerWidth,' +
    'dpr: window.devicePixelRatio || 1' +
    '})';
  const m = parseEvalJson<PageMetrics>(await evaluate(browser, js, timeoutMs));
  if (!(m.viewportHeight > 0) || !(m.scrollHeight > 0)) throw new Error(`the page reported no size (${JSON.stringify(m)})`);
  return m;
}

// Many sites set `scroll-behavior: smooth`, which makes window.scrollTo
// ANIMATE: the position read straight afterwards is still the old one. That
// reads as "this page will not scroll" and collapses the capture to a single
// slice. Force instant scrolling for the duration, remembering the page's own
// inline value so it can be put back.
const FORCE_INSTANT_SCROLL_JS =
  '(() => { const els = [document.documentElement, document.body].filter(Boolean); ' +
  'window.__eabScrollBehavior = els.map((el) => [el, el.style.scrollBehavior]); ' +
  'for (const el of els) el.style.scrollBehavior = "auto"; ' +
  'return JSON.stringify({ count: els.length }); })()';

const RESTORE_SCROLL_BEHAVIOR_JS =
  '(() => { const s = window.__eabScrollBehavior || []; for (const [el, v] of s) { el.style.scrollBehavior = v; } ' +
  'delete window.__eabScrollBehavior; return JSON.stringify({ count: s.length }); })()';

/** Ask the page to scroll to `y`. Where it really lands is read separately, after it settles. */
async function requestScrollTo(browser: Browser, y: number, timeoutMs: number): Promise<void> {
  const js =
    `(() => { const se = document.scrollingElement || document.documentElement; ` +
    `try { window.scrollTo({ top: ${y}, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, ${y}); } ` +
    `if (se && Math.abs((se.scrollTop || 0) - ${y}) > 1) se.scrollTop = ${y}; ` +
    `return JSON.stringify({ ok: true }); })()`;
  await evaluate(browser, js, timeoutMs);
}

/** Where the page is scrolled to now, in CSS pixels. */
async function readScrollY(browser: Browser, timeoutMs: number): Promise<number> {
  const js =
    '(() => { const se = document.scrollingElement || document.documentElement; ' +
    'return JSON.stringify({ y: Math.round(window.scrollY || window.pageYOffset || (se ? se.scrollTop : 0) || 0) }); })()';
  return parseEvalJson<{ y: number }>(await evaluate(browser, js, timeoutMs)).y;
}

// Hiding is done in the page and remembered there, so the restore cannot be
// confused by anything that changed in between.
const HIDE_FIXED_JS =
  '(() => { const hidden = []; ' +
  'for (const el of document.querySelectorAll("body *")) { ' +
  'const p = getComputedStyle(el).position; ' +
  'if (p === "fixed" || p === "sticky") { hidden.push([el, el.style.visibility]); el.style.visibility = "hidden"; } } ' +
  'window.__eabHidden = hidden; return JSON.stringify({ count: hidden.length }); })()';

const RESTORE_FIXED_JS =
  '(() => { const h = window.__eabHidden || []; for (const [el, v] of h) { el.style.visibility = v; } ' +
  'delete window.__eabHidden; return JSON.stringify({ count: h.length }); })()';

/**
 * Capture the whole scrollable page into `outPath` (PNG) by compositing
 * viewport captures. Leaves the page scrolled back to the top.
 */
export async function captureStitchedFullPage(
  browser: Browser,
  outPath: string,
  opts: StitchOptions,
): Promise<StitchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const maxHeightPx = opts.maxHeightPx ?? DEFAULT_MAX_HEIGHT_PX;
  const hideFixed = opts.hideFixed !== false;
  const { log, sleep } = opts;

  const metrics = await readMetrics(browser, timeoutMs);

  // Short page: one ordinary viewport capture is the whole thing.
  if (metrics.scrollHeight <= metrics.viewportHeight + 1) {
    await captureViewport(browser, outPath, timeoutMs);
    const size = await imageSize(outPath);
    const w = size?.width ?? Math.round(metrics.viewportWidth * metrics.dpr);
    const h = size?.height ?? Math.round(metrics.viewportHeight * metrics.dpr);
    log(`stitch: one viewport covers the page (${w}×${h})`);
    return { width: w, height: h, slices: 1, singleShot: true };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eab-stitch-'));
  const parts: Array<{ input: string; top: number; left: number }> = [];
  let hid = false;
  let forcedInstant = false;
  try {
    try {
      await evaluate(browser, FORCE_INSTANT_SCROLL_JS, timeoutMs);
      forcedInstant = true;
    } catch (e: any) {
      log(`stitch: could not disable smooth scrolling (${e?.message ?? e})`);
    }
    // The captures, not the page's own devicePixelRatio, decide the scale: an
    // emulated viewport or a mismatched window would otherwise compose every
    // slice at the wrong offset. Measured from the first slice below.
    let dpr = metrics.dpr > 0 ? metrics.dpr : 1;
    let width = Math.round(metrics.viewportWidth * dpr);
    let cssHeight = metrics.scrollHeight;
    let truncatedFrom: number | undefined;

    const step = metrics.viewportHeight;
    let lastTop = Math.max(0, cssHeight - metrics.viewportHeight);
    // Where the top of each slice should be; the page decides where it lands.
    const targets: number[] = [];
    for (let y = 0; y < lastTop; y += step) targets.push(y);
    // The bottom slice, unless the loop already ended within a pixel of it
    // (which would only re-capture the same view).
    if (!targets.length || lastTop - targets[targets.length - 1]! >= 1) targets.push(lastTop);

    let index = 0;
    let previousTop = -1;
    for (const target of targets) {
      await requestScrollTo(browser, target, timeoutMs);
      // Let the scroll land before asking where it landed: a smooth or
      // JS-driven scroll does not finish within the call that started it.
      await sleep(settleMs);
      const actual = await readScrollY(browser, timeoutMs);
      // A page that refuses to scroll any further would otherwise spin out
      // slice after identical slice.
      if (actual === previousTop && index > 0) break;
      previousTop = actual;
      if (index === 1 && hideFixed) {
        try {
          const { count } = parseEvalJson<{ count: number }>(await evaluate(browser, HIDE_FIXED_JS, timeoutMs));
          hid = true;
          if (count) log(`stitch: hid ${count} fixed/sticky element(s) so they do not repeat in every slice`);
        } catch (e: any) {
          log(`stitch: could not hide fixed elements (${e?.message ?? e}) — they may repeat`);
        }
      }
      await sleep(settleMs);
      const file = path.join(tmpDir, `slice-${String(index).padStart(3, '0')}.png`);
      await captureViewport(browser, file, timeoutMs);
      if (index === 0) {
        // Calibrate on what the browser actually produced.
        const size = await imageSize(file);
        if (size && size.width > 0 && metrics.viewportWidth > 0) {
          dpr = size.width / metrics.viewportWidth;
          width = size.width;
        }
        if (Math.round(cssHeight * dpr) > maxHeightPx) {
          truncatedFrom = Math.round(cssHeight * dpr);
          cssHeight = Math.floor(maxHeightPx / dpr);
          lastTop = Math.max(0, cssHeight - metrics.viewportHeight);
          log(`stitch: page is ${truncatedFrom} px tall at this scale — capturing the top ${Math.round(cssHeight * dpr)} px`);
        }
      }
      parts.push({ input: file, top: Math.round(actual * dpr), left: 0 });
      index += 1;
      if (actual >= lastTop) break; // the bottom slice; later targets would repeat it
    }

    const height = Math.round(cssHeight * dpr);
    // Trim anything that would hang off the bottom of the canvas.
    const usable = parts.filter((p) => p.top < height);
    log(`stitch: ${usable.length} slice(s) of ${metrics.viewportWidth}×${metrics.viewportHeight} CSS px at ${dpr}x → ${width}×${height}`);
    await sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .composite(usable)
      .png()
      .toFile(outPath);

    return { width, height, slices: usable.length, singleShot: false, ...(truncatedFrom ? { truncatedFrom } : {}) };
  } finally {
    if (hid) {
      await evaluate(browser, RESTORE_FIXED_JS, timeoutMs).catch(() => undefined);
    }
    // Put the page back where a full-page capture would have left it, then
    // give it its own scrolling behaviour back.
    await requestScrollTo(browser, 0, timeoutMs).catch(() => undefined);
    if (forcedInstant) await evaluate(browser, RESTORE_SCROLL_BEHAVIOR_JS, timeoutMs).catch(() => undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function captureViewport(browser: Browser, file: string, timeoutMs: number): Promise<void> {
  const r = await browser.run(['screenshot', file], { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`slice capture failed: ${(r.stderr || r.stdout).trim()}`);
}

async function imageSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const { width, height } = await sharp(file).metadata();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

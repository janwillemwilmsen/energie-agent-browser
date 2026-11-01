import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { captureStitchedFullPage, parseEvalJson } from './stitchCapture.js';
import type { Browser, RunResult } from './stepExecutor.js';

// The stitched full-page capture against a fake page: the slices really are
// written and really are composed by sharp, so the assertions are about the
// pixels that come out, not about the calls that went in.

const OK = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eab-stitch-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * A page `pageHeight` CSS px tall in a `viewportHeight` window. Each viewport
 * capture is a solid colour picked from the scroll position, so the composed
 * image can be checked band by band.
 */
function fakePage(opts: { pageHeight: number; viewportHeight: number; viewportWidth?: number; dpr?: number }) {
  const width = opts.viewportWidth ?? 100;
  const dpr = opts.dpr ?? 1;
  const state = { y: 0, hidden: false, restored: false, shots: 0 };
  const colourFor = (y: number) => ({ r: Math.min(255, y % 256), g: 120, b: 200, alpha: 1 });

  const browser: Browser = {
    async run(args): Promise<RunResult> {
      if (args[0] === 'eval') {
        const js = args[1] ?? '';
        if (js.includes('scrollHeight')) {
          return OK(JSON.stringify(JSON.stringify({
            scrollHeight: opts.pageHeight,
            viewportHeight: opts.viewportHeight,
            viewportWidth: width,
            dpr,
          })));
        }
        if (js.includes('window.scrollTo')) {
          const want = Number(/window\.scrollTo\(0, (-?\d+)\)/.exec(js)?.[1] ?? 0);
          // A real page clamps at the bottom of the document.
          state.y = Math.max(0, Math.min(want, opts.pageHeight - opts.viewportHeight));
          return OK(JSON.stringify(JSON.stringify({ y: state.y })));
        }
        if (js.includes('__eabHidden = hidden')) { state.hidden = true; return OK(JSON.stringify(JSON.stringify({ count: 2 }))); }
        if (js.includes('delete window.__eabHidden')) { state.restored = true; return OK(JSON.stringify(JSON.stringify({ count: 2 }))); }
        return OK(JSON.stringify(JSON.stringify({})));
      }
      if (args[0] === 'screenshot') {
        state.shots += 1;
        const file = args[1]!;
        await sharp({
          create: {
            width: Math.round(width * dpr),
            height: Math.round(opts.viewportHeight * dpr),
            channels: 4,
            background: colourFor(state.y),
          },
        }).png().toFile(file);
        return OK();
      }
      return OK();
    },
    async snapshot() { throw new Error('not used'); },
    async close() { /* not used */ },
  };
  return { browser, state, colourFor };
}

const noop = { log: () => {}, sleep: async () => {} };

/** The pixel at (x, y) of a PNG. */
async function pixelAt(file: string, x: number, y: number) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe('parseEvalJson', () => {
  it('unwraps the JSON string agent-browser prints for a stringified value', () => {
    expect(parseEvalJson<{ y: number }>(JSON.stringify(JSON.stringify({ y: 7 })))).toEqual({ y: 7 });
    // And copes when the value arrives already decoded.
    expect(parseEvalJson<{ y: number }>(JSON.stringify({ y: 7 }))).toEqual({ y: 7 });
  });
});

describe('stitched full-page capture', () => {
  it('composes every slice at the scroll position the page reported', async () => {
    // 1000 px page, 400 px viewport: scrolls to 0, 400, then clamps to 600.
    const { browser, state, colourFor } = fakePage({ pageHeight: 1000, viewportHeight: 400 });
    const out = path.join(dir, 'full.png');
    const r = await captureStitchedFullPage(browser, out, noop);

    expect(r).toMatchObject({ width: 100, height: 1000, slices: 3, singleShot: false });
    const meta = await sharp(out).metadata();
    expect({ w: meta.width, h: meta.height }).toEqual({ w: 100, h: 1000 });

    // Band 1 is the slice taken at y=0, band 2 at y=400. The last slice landed
    // at 600 (clamped), so it owns everything from 600 down — overlapping the
    // second slice rather than leaving a gap.
    expect(await pixelAt(out, 50, 10)).toMatchObject({ r: colourFor(0).r });
    expect(await pixelAt(out, 50, 410)).toMatchObject({ r: colourFor(400).r });
    expect(await pixelAt(out, 50, 650)).toMatchObject({ r: colourFor(600).r });
    expect(await pixelAt(out, 50, 999)).toMatchObject({ r: colourFor(600).r });

    // Fixed/sticky elements are hidden after the first slice, and put back.
    expect(state.hidden).toBe(true);
    expect(state.restored).toBe(true);
    // And the page is left at the top, as a browser full-page capture leaves it.
    expect(state.y).toBe(0);
  });

  it('takes a single viewport capture when the page is not scrollable', async () => {
    const { browser, state } = fakePage({ pageHeight: 400, viewportHeight: 400 });
    const out = path.join(dir, 'short.png');
    const r = await captureStitchedFullPage(browser, out, noop);
    expect(r).toMatchObject({ slices: 1, singleShot: true, height: 400 });
    expect(state.shots).toBe(1);
    // Nothing to hide when there is only one slice.
    expect(state.hidden).toBe(false);
  });

  it('works in device pixels, so a 2x screen composes at twice the size', async () => {
    const { browser } = fakePage({ pageHeight: 900, viewportHeight: 300, viewportWidth: 50, dpr: 2 });
    const out = path.join(dir, 'retina.png');
    const r = await captureStitchedFullPage(browser, out, noop);
    expect(r).toMatchObject({ width: 100, height: 1800, slices: 3 });
    const meta = await sharp(out).metadata();
    expect({ w: meta.width, h: meta.height }).toEqual({ w: 100, h: 1800 });
  });

  it('stops instead of looping when the page refuses to scroll', async () => {
    const { browser, state } = fakePage({ pageHeight: 5000, viewportHeight: 500 });
    // A page that ignores scrolling entirely (an overlay locking the body, say).
    const original = browser.run.bind(browser);
    browser.run = async (args, o) => {
      if (args[0] === 'eval' && (args[1] ?? '').includes('window.scrollTo')) {
        return OK(JSON.stringify(JSON.stringify({ y: 0 })));
      }
      return original(args, o);
    };
    const out = path.join(dir, 'stuck.png');
    const r = await captureStitchedFullPage(browser, out, noop);
    // One real slice, then the repeat is detected and the loop ends.
    expect(r.slices).toBe(1);
    expect(state.shots).toBeLessThanOrEqual(2);
  });

  it('caps a page taller than the limit instead of trying to allocate it', async () => {
    const { browser } = fakePage({ pageHeight: 10_000, viewportHeight: 500 });
    const out = path.join(dir, 'capped.png');
    const r = await captureStitchedFullPage(browser, out, { ...noop, maxHeightPx: 2_000 });
    expect(r).toMatchObject({ height: 2_000, truncatedFrom: 10_000 });
    const meta = await sharp(out).metadata();
    expect(meta.height).toBe(2_000);
  });
});

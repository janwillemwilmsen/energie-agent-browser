import { describe, it, expect } from 'vitest';
import { inferScreenshotMeta, parseScreenshotMetas, screenshotMetaFor } from '@eab/shared';

describe('screenshot metadata', () => {
  it('infers desktop, the default mobile device, and zoom from an older filename', () => {
    expect(inferScreenshotMeta('20261001-090028-home-desktop.png')).toMatchObject({
      viewport: { width: 1440, height: 900, scale: 1 }, device: null, zoom: null, inferred: true,
    });
    expect(inferScreenshotMeta('20261001-090028-home-mobile.png')).toMatchObject({
      viewport: { width: 390, height: 844, scale: 3 }, device: 'iPhone 14', zoom: null,
    });
    expect(inferScreenshotMeta('003-20261001-090028-home-zoom200-desktop.png')).toMatchObject({
      viewport: { width: 720, height: 450, scale: 2 }, zoom: 200,
    });
  });

  it('prefers the recorded entry and parses the column leniently', () => {
    const metas = parseScreenshotMetas(JSON.stringify([
      { name: 'a-mobile.png', viewport: { width: 412, height: 915, scale: 1 }, device: 'Pixel 7', zoom: null, fullPage: true, width: 412, height: 9000 },
      { junk: true },
    ]));
    expect(metas).toHaveLength(1);
    expect(screenshotMetaFor('a-mobile.png', metas).device).toBe('Pixel 7');
    expect(screenshotMetaFor('b-mobile.png', metas).inferred).toBe(true);
    expect(parseScreenshotMetas('not json')).toEqual([]);
    expect(parseScreenshotMetas(null)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { defaultDevices, inferScreenshotMeta, parseDeviceSource, parseScreenshotMetas, screenshotMetaFor } from '@eab/shared';

describe('device list', () => {
  it('parses the vendored Playwright descriptors, marking agent-browser built-ins and the UA family', () => {
    const all = defaultDevices();
    expect(all.length).toBeGreaterThan(150);
    const fold = all.find((d) => d.name === 'Galaxy Z Fold 6 Cover')!;
    expect(fold).toMatchObject({ width: 484, height: 1112, scale: 2, mobile: true, family: 'android', builtin: false });
    expect(all.find((d) => d.name === 'iPhone 14')).toMatchObject({ family: 'ios', builtin: true, width: 390, height: 664 });
    expect(all.find((d) => d.name === 'Desktop Chrome')).toMatchObject({ family: 'desktop', mobile: false });
  });

  it('rejects a source that is not a device map', () => {
    expect(() => parseDeviceSource('nope')).toThrow(/not valid JSON/);
    expect(() => parseDeviceSource('[]')).toThrow(/expected an object/);
    expect(() => parseDeviceSource('{"x":{"userAgent":"a"}}')).toThrow(/no devices with a viewport/);
  });
});

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

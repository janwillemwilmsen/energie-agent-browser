import { DEFAULT_MOBILE_DEVICE, DESKTOP_VIEWPORT, DEVICE_PROFILES, zoomedViewport, type DeviceName, type ViewportSize } from './schemas.js';
import { parseSlot } from './slots.js';

// What a screenshot was captured with: the CSS viewport the page was laid out
// in, the device emulated (null = desktop), the zoom, whether it is the full
// page, and the image's pixel size. Written by the Step executor at capture
// time and stored on the Run (runs.screenshot_meta_json), one entry per
// screenshot filename — the viewer uses it to frame an image at the device's
// aspect ratio. Runs from before the column fall back to inferScreenshotMeta.

export interface ScreenshotMeta {
  /** The slot filename this describes. */
  name: string;
  /** The CSS viewport the page was laid out in, and the capture's scale. */
  viewport: ViewportSize;
  /** The emulated device; null for a desktop capture. */
  device: DeviceName | null;
  /** Browser zoom in percent, when emulated. */
  zoom: number | null;
  fullPage: boolean;
  /** Image pixel size, when it could be read. */
  width: number | null;
  height: number | null;
  /** True when inferred from the filename instead of recorded at capture. */
  inferred?: boolean;
}

const ZOOM_RE = /-zoom(\d{3})$/;

/**
 * The best guess for a screenshot recorded before capture metadata existed:
 * the viewport suffix gives desktop or the default mobile device, the label
 * carries the zoom. The device of an older mobile capture is unknown; the
 * default device is assumed.
 */
export function inferScreenshotMeta(name: string): ScreenshotMeta {
  const parts = parseSlot(name);
  const mobile = parts?.viewport === 'mobile';
  const zoom = parts ? Number(ZOOM_RE.exec(parts.label)?.[1] ?? 0) || null : null;
  const device: DeviceName | null = mobile ? DEFAULT_MOBILE_DEVICE : null;
  const base = device ? DEVICE_PROFILES[device] : DESKTOP_VIEWPORT;
  return {
    name,
    viewport: zoom ? zoomedViewport(base, zoom) : base,
    device,
    zoom,
    fullPage: true,
    width: null,
    height: null,
    inferred: true,
  };
}

/** The recorded meta for a filename, or the inference when the run has none. */
export function screenshotMetaFor(name: string, metas: ScreenshotMeta[] | null | undefined): ScreenshotMeta {
  return metas?.find((m) => m.name === name) ?? inferScreenshotMeta(name);
}

/** Parse the stored JSON column leniently: [] for anything malformed. */
export function parseScreenshotMetas(json: string | null | undefined): ScreenshotMeta[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((m) => m && typeof m.name === 'string' && m.viewport) : [];
  } catch {
    return [];
  }
}

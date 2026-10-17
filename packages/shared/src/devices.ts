import { DEVICE_NAMES, DEVICE_PROFILES, type DeviceName, type ViewportSize } from './schemas.js';
import { PLAYWRIGHT_DEVICES_SOURCE } from './playwrightDevicesSource.js';

// Devices a screenshot may emulate. The source of truth is Playwright's
// deviceDescriptorsSource.json (vendored as the default, replaceable from
// the admin Devices page); the operator picks which of its ~200 entries are
// offered in the screenshot step's dropdown.
//
// How a device is applied (Step executor): agent-browser's runtime knows
// `set device <built-in name>` (viewport + scale + user agent) and
// `set viewport W H scale`. So a device is emulated as the built-in device
// of the same family for its USER AGENT, then the descriptor's viewport and
// scale on top. That is exactly the fidelity the built-ins have; neither
// emulates touch or a coarse pointer (agent-browser 0.38.1 does not).

export interface DeviceSize {
  width: number;
  height: number;
}

export interface DeviceProfile {
  name: string;
  /** The page's visible area in CSS px (Playwright's `viewport`: below the browser chrome). */
  width: number;
  height: number;
  scale: number;
  /**
   * The physical screen in CSS px (Playwright's `screen`). Older entries
   * (iPhone X/8/SE, Pixel 2–4, …) carry none; then this is the viewport, and
   * `screenFromViewport` says so — the admin page lets the operator fill in
   * the real numbers.
   */
  screen: DeviceSize;
  screenFromViewport: boolean;
  /** Phone or tablet (isMobile) rather than a desktop-class descriptor. */
  mobile: boolean;
  userAgent: string;
  /** Which built-in agent-browser device lends its user agent. */
  family: 'ios' | 'android' | 'desktop';
  /** True when agent-browser itself knows the name (`set device` works directly). */
  builtin: boolean;
}

interface Descriptor {
  userAgent?: unknown;
  viewport?: { width?: unknown; height?: unknown };
  screen?: { width?: unknown; height?: unknown };
  deviceScaleFactor?: unknown;
  isMobile?: unknown;
}

/** The built-in device that lends its user agent to a family. */
export const UA_STAND_IN: Record<DeviceProfile['family'], DeviceName | null> = {
  ios: 'iPhone 14',
  android: 'Pixel 7',
  desktop: null,
};

const BUILTIN = new Set<string>(DEVICE_NAMES);

function familyOf(ua: string): DeviceProfile['family'] {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Parse a Playwright device source. Throws with a readable message on
 * malformed input (the admin page shows it). Entries without a viewport
 * are skipped.
 */
export function parseDeviceSource(json: string): DeviceProfile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e: any) {
    throw new Error(`not valid JSON: ${e?.message ?? e}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('expected an object of { "<device name>": { viewport, deviceScaleFactor, userAgent, … } }');
  }
  const out: DeviceProfile[] = [];
  for (const [name, d] of Object.entries(raw as Record<string, Descriptor>)) {
    const w = Number(d?.viewport?.width);
    const h = Number(d?.viewport?.height);
    if (!(w > 0 && h > 0)) continue;
    const ua = typeof d.userAgent === 'string' ? d.userAgent : '';
    const scale = Number(d.deviceScaleFactor) > 0 ? Number(d.deviceScaleFactor) : 1;
    const sw = Number(d?.screen?.width);
    const sh = Number(d?.screen?.height);
    const hasScreen = sw > 0 && sh > 0;
    out.push({
      name,
      width: Math.round(w),
      height: Math.round(h),
      scale,
      screen: hasScreen ? { width: Math.round(sw), height: Math.round(sh) } : { width: Math.round(w), height: Math.round(h) },
      screenFromViewport: !hasScreen,
      mobile: d.isMobile === true,
      userAgent: ua,
      family: familyOf(ua),
      builtin: BUILTIN.has(name),
    });
  }
  if (out.length === 0) throw new Error('no devices with a viewport found');
  return out;
}

/** The vendored Playwright list. */
export function defaultDevices(): DeviceProfile[] {
  return parseDeviceSource(PLAYWRIGHT_DEVICES_SOURCE);
}

/**
 * agent-browser's own built-ins as profiles, for a name the current source
 * lacks (a scenario saved against an older list) and for the inference of
 * old screenshots. Their sizes are the ones `set device` applies.
 */
export function builtinProfile(name: string): DeviceProfile | undefined {
  if (!BUILTIN.has(name)) return undefined;
  const v: ViewportSize = DEVICE_PROFILES[name as DeviceName];
  const family: DeviceProfile['family'] = /iPhone|iPad/.test(name) ? 'ios' : 'android';
  // agent-browser's own profiles are screen sizes too.
  return {
    name, width: v.width, height: v.height, scale: v.scale,
    screen: { width: v.width, height: v.height }, screenFromViewport: true,
    mobile: true, userAgent: '', family, builtin: true,
  };
}

/**
 * Write screen and viewport sizes into a device source: the entries are
 * rewritten in Playwright's field order (userAgent, screen, viewport, …) and
 * the whole list re-serialised with its 2-space indentation. Throws with a
 * readable message for an unknown name or a source that does not parse.
 */
export function patchDeviceSizes(json: string, sizes: Record<string, { screen: DeviceSize; viewport: DeviceSize }>): string {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e: any) {
    throw new Error(`the current source is not valid JSON: ${e?.message ?? e}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the current source is not a device map');
  const map = raw as Record<string, Record<string, unknown>>;
  for (const [name, s] of Object.entries(sizes)) {
    const d = map[name];
    if (!d || typeof d !== 'object') throw new Error(`unknown device "${name}"`);
    const { userAgent, screen: _screen, viewport: _viewport, ...rest } = d;
    map[name] = {
      ...(userAgent !== undefined ? { userAgent } : {}),
      screen: { width: s.screen.width, height: s.screen.height },
      viewport: { width: s.viewport.width, height: s.viewport.height },
      ...rest,
    };
  }
  return JSON.stringify(map, null, 2) + '\n';
}

/** The viewport (CSS px + scale) a profile lays the page out in. */
export function profileViewport(p: DeviceProfile): ViewportSize {
  return { width: p.width, height: p.height, scale: p.scale };
}

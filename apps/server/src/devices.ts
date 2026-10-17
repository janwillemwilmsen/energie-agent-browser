import {
  DEFAULT_MOBILE_DEVICE,
  DEVICE_NAMES,
  PLAYWRIGHT_DEVICES_SOURCE,
  builtinProfile,
  parseDeviceSource,
  patchDeviceSizes,
  type DeviceProfile,
  type DeviceSize,
} from '@eab/shared';
import { getSetting, setSetting } from './settings.js';

// The device list behind the screenshot step's dropdown: Playwright's
// descriptors (the vendored copy, or a newer one pasted on the admin Devices
// page) and the operator's selection of which names to offer. Both live in
// app_settings; the runner builds a lookup from them at run start.

const SOURCE_KEY = 'devices.source';
const ENABLED_KEY = 'devices.enabled';

/** The dropdown's initial selection: agent-browser's own built-ins. */
const DEFAULT_ENABLED: string[] = [...DEVICE_NAMES];

export function deviceSource(): string {
  return getSetting(SOURCE_KEY) ?? PLAYWRIGHT_DEVICES_SOURCE;
}

export function deviceSourceIsCustom(): boolean {
  return getSetting(SOURCE_KEY) != null;
}

/** Every device the current source describes. */
export function allDevices(): DeviceProfile[] {
  try {
    return parseDeviceSource(deviceSource());
  } catch {
    // A stored source that no longer parses must not take the app down.
    return parseDeviceSource(PLAYWRIGHT_DEVICES_SOURCE);
  }
}

export function enabledDeviceNames(): string[] {
  const raw = getSetting(ENABLED_KEY);
  if (!raw) return DEFAULT_ENABLED;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : DEFAULT_ENABLED;
  } catch {
    return DEFAULT_ENABLED;
  }
}

/**
 * Validate and store a pasted source. Returns how many devices it holds.
 * An empty string restores the vendored copy.
 */
export function saveDeviceSource(json: string): number {
  if (!json.trim()) {
    setSetting(SOURCE_KEY, null);
    return parseDeviceSource(PLAYWRIGHT_DEVICES_SOURCE).length;
  }
  const n = parseDeviceSource(json).length; // throws with the reason
  setSetting(SOURCE_KEY, json);
  return n;
}

/**
 * Write screen/viewport sizes edited inline on the admin page into the
 * stored source (the vendored copy becomes a custom one on the first edit).
 * Throws with the reason for an unknown name.
 */
export function saveDeviceSizes(sizes: Record<string, { screen: DeviceSize; viewport: DeviceSize }>): void {
  if (Object.keys(sizes).length === 0) return;
  setSetting(SOURCE_KEY, patchDeviceSizes(deviceSource(), sizes));
}

export function saveEnabledDeviceNames(names: string[]): void {
  const known = new Set(allDevices().map((d) => d.name));
  const keep = Array.from(new Set(names.filter((n) => known.has(n))));
  setSetting(ENABLED_KEY, JSON.stringify(keep));
}

/**
 * The lookup a run uses: the current source first, then agent-browser's
 * built-ins, so a scenario saved against an older list keeps working. The
 * default mobile device is always resolvable.
 */
export function deviceResolver(): (name: string) => DeviceProfile | undefined {
  const byName = new Map(allDevices().map((d) => [d.name, d] as const));
  return (name) => byName.get(name) ?? builtinProfile(name) ?? (name === DEFAULT_MOBILE_DEVICE ? builtinProfile(DEFAULT_MOBILE_DEVICE) : undefined);
}

// The screenshot slot filename protocol, shared by the server (which writes
// the files and pairs them across Runs) and the web (which groups and labels
// them). One owner, so nobody parses these names with a private regex.
//
//   NNN-YYYYMMDD-HHMMSS-<label>-<viewport>.<ext>
//
// - NNN is the Step's position, zero-padded; it shifts whenever the Scenario
//   is edited, so it is NOT part of the cross-run key.
// - YYYYMMDD-HHMMSS is the Run's file stamp (local time), purely informational;
//   older files have none.
// - <label> is the screenshot Step's label, sanitized to [a-z0-9._-]; it may
//   itself contain dashes, which is why <viewport> is always the LAST segment.
// - <viewport> is 'desktop' or 'mobile'.
// - <ext> follows the Step's format: png, jpg or webp; it changes when the
//   format does, so it is not part of the cross-run key either.

const EXT_RE = /\.(png|jpe?g|webp)$/i;
const PREFIX_RE = /^(\d+)-(?:(\d{8}-\d{6})-)?/;

export interface SlotParts {
  position: number;
  /** The Run's file stamp, or null for older un-stamped files. */
  stamp: string | null;
  label: string;
  viewport: string | null;
  ext: string;
}

/** Make a Step label safe for a filename. */
export function sanitizeSlotLabel(label: string): string {
  return label.replace(/[^a-z0-9._-]/gi, '_');
}

export function encodeSlot(parts: {
  position: number;
  stamp: string;
  label: string;
  viewport: string;
  ext: string;
}): string {
  return `${String(parts.position).padStart(3, '0')}-${parts.stamp}-${sanitizeSlotLabel(parts.label)}-${parts.viewport}.${parts.ext}`;
}

/** Full decode, or null when the name does not follow the protocol. */
export function parseSlot(name: string): SlotParts | null {
  const extMatch = EXT_RE.exec(name);
  if (!extMatch) return null;
  const stem = name.slice(0, extMatch.index);
  const prefix = PREFIX_RE.exec(stem);
  if (!prefix) return null;
  const body = stem.slice(prefix[0].length);
  if (!body) return null;
  const i = body.lastIndexOf('-');
  return {
    position: Number(prefix[1]),
    stamp: prefix[2] ?? null,
    label: i >= 0 ? body.slice(0, i) : body,
    viewport: i >= 0 ? body.slice(i + 1) : null,
    ext: extMatch[1]!.toLowerCase(),
  };
}

/**
 * The cross-run pairing key: `<label>-<viewport>`, with position, stamp and
 * extension stripped. Lenient on purpose: a name outside the protocol keys as
 * itself minus the extension, so nothing is silently dropped.
 */
export function slotKey(name: string): string {
  return name.replace(PREFIX_RE, '').replace(EXT_RE, '');
}

/** The viewport segment (last dash-separated part), or null. */
export function slotViewport(name: string): string | null {
  const base = name.replace(EXT_RE, '');
  const i = base.lastIndexOf('-');
  return i >= 0 ? base.slice(i + 1) : null;
}

/** Human label for a slot: `checkout (mobile)`. */
export function slotDisplayLabel(name: string): string {
  const parts = parseSlot(name);
  if (!parts) return slotKey(name);
  return parts.viewport ? `${parts.label} (${parts.viewport})` : parts.label;
}

// The screenshot slot filename protocol, shared by the server (which writes
// the files and pairs them across Runs) and the web (which groups and labels
// them). One owner, so nobody parses these names with a private regex.
//
//   YYYYMMDD-HHMMSS-<label>-<viewport>.<ext>
//
// - YYYYMMDD-HHMMSS is the moment of CAPTURE (local time), so sorting names
//   sorts chronologically within a run. It is not part of the cross-run key.
// - <label> is the screenshot Step's label, sanitized to [a-z0-9._-]; it may
//   itself contain dashes, which is why <viewport> is always the LAST segment.
// - <viewport> is 'desktop' or 'mobile'.
// - <ext> follows the Step's format: png, jpg or webp for screenshots, md for
//   the texts a save_text Step writes; it changes when the format does, so it
//   is not part of the cross-run key either.
//
// Older files carry a leading `NNN-` (the Step's position) and the stamp was
// the Run's start time, or absent: `NNN-[YYYYMMDD-HHMMSS-]<label>-<viewport>`.
// They still parse; the position is reported when present.

const EXT_RE = /\.(png|jpe?g|webp|md)$/i;
// A position is at most 7 digits so it can never be mistaken for the 8-digit date.
const PREFIX_RE = /^(?:(\d{1,7})-)?(?:(\d{8}-\d{6})-)?/;

export interface SlotParts {
  /** The Step's position for older files; null for current-protocol names. */
  position: number | null;
  /** The capture stamp (older files: the Run's start), or null for un-stamped files. */
  stamp: string | null;
  label: string;
  viewport: string | null;
  ext: string;
}

/** Make a Step label safe for a filename. */
export function sanitizeSlotLabel(label: string): string {
  return label.replace(/[^a-z0-9._-]/gi, '_');
}

// Compact, filesystem-safe, sortable local-time stamp: "20260606-143025"
// (YYYYMMDD-HHMMSS). Local time so it matches the timestamps the UI renders
// elsewhere (toLocaleString).
export function slotStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function encodeSlot(parts: {
  stamp: string;
  label: string;
  viewport: string;
  ext: string;
}): string {
  return `${parts.stamp}-${sanitizeSlotLabel(parts.label)}-${parts.viewport}.${parts.ext}`;
}

/** Full decode, or null when the name does not follow the protocol. */
export function parseSlot(name: string): SlotParts | null {
  const extMatch = EXT_RE.exec(name);
  if (!extMatch) return null;
  const stem = name.slice(0, extMatch.index);
  const prefix = PREFIX_RE.exec(stem)!;
  if (!prefix[1] && !prefix[2]) return null;
  const body = stem.slice(prefix[0].length);
  if (!body) return null;
  const i = body.lastIndexOf('-');
  return {
    position: prefix[1] != null ? Number(prefix[1]) : null,
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

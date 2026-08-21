import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export interface ThumbSpec {
  /** Target width in px. */
  width: number;
  /**
   * Optional target height. When set, the source is cover-cropped from the
   * top (matching the dashboard card's `object-fit: cover; object-position:
   * top`), so the thumbnail carries only the pixels the card actually shows —
   * full-page screenshots are 10-20k px tall and would otherwise still be
   * hundreds of KB after a width-only resize.
   */
  height?: number;
}

/**
 * Return the path of a cached WebP thumbnail for `srcPath`, generating it on
 * first use. Thumbnails live in a `thumbs/` dir next to the source file
 * (deleting a run's screenshot dir removes them with it) and are regenerated
 * when the source is newer than the cached copy — which happens while a run
 * is still in progress and a restart attempt overwrites its screenshots.
 */
export async function ensureThumb(srcPath: string, spec: ThumbSpec): Promise<string> {
  const dir = path.join(path.dirname(srcPath), 'thumbs');
  const key = `w${spec.width}${spec.height ? `h${spec.height}` : ''}-${path.basename(srcPath)}.webp`;
  const out = path.join(dir, key);

  try {
    const src = fs.statSync(srcPath);
    const thumb = fs.statSync(out);
    if (thumb.mtimeMs >= src.mtimeMs) return out;
  } catch {
    /* no cached thumb yet */
  }

  fs.mkdirSync(dir, { recursive: true });
  // Write to a unique temp file and rename, so two concurrent requests for
  // the same thumbnail can't serve each other's half-written output.
  const tmp = path.join(dir, `.${process.pid}-${Date.now()}-${key}`);
  await sharp(srcPath)
    .resize(
      spec.height
        ? {
            width: spec.width,
            height: spec.height,
            fit: 'cover',
            position: 'top',
            withoutEnlargement: true,
          }
        : { width: spec.width, withoutEnlargement: true },
    )
    .webp({ quality: 78 })
    .toFile(tmp);
  try {
    fs.renameSync(tmp, out);
  } catch {
    // Windows can't rename over an existing file — a concurrent request beat
    // us to it; its result is equivalent, so drop ours and use theirs.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (!fs.existsSync(out)) throw new Error(`thumbnail rename failed for ${srcPath}`);
  }
  return out;
}

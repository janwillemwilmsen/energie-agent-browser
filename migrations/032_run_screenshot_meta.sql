-- Per-screenshot capture metadata (JSON array of ScreenshotMeta, see
-- @eab/shared screenshotMeta.ts): the CSS viewport, scale, device, zoom,
-- full-page flag and pixel size of every file in screenshot_paths_json. The
-- image viewer frames a screenshot at its device's aspect ratio with it.
-- Runs from before this column fall back to an inference from the filename.
ALTER TABLE runs ADD COLUMN screenshot_meta_json TEXT NOT NULL DEFAULT '[]';

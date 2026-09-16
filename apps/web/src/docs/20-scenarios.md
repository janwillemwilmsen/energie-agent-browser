# Scenarios

A scenario is an ordered list of steps executed top-to-bottom against a live browser. Steps are color-coded by kind in the editor.

## Step kinds

| Kind | Does |
| --- | --- |
| `navigate` | Open a URL |
| `click` / `type` / `fill` / `select` / `check` / `uncheck` | Interact with an element (selector = role/name, locator, or ordinal) |
| `scroll` | Scroll to an element, or to the bottom (triggers lazy-loading) |
| `screenshot` | Capture the page — see below |
| `wait` | Fixed delay or wait for a selector |
| `evaluate` | Run a JavaScript snippet in the page |
| `record_start` / `record_stop` | Bracket a video recording segment |
| `close` | Close the page |

## Editing steps

- **✎ on a step row** opens the edit modal. Screenshot steps get friendly fields; every other kind exposes its payload JSON.
- Drag the `⠿` handle (or use ▲/▼) to reorder.
- **edit raw** next to the *Steps* heading jumps to the Admin raw-steps editor with this scenario preselected — useful for fixing a malformed payload by hand.

## Screenshot format & quality

Screenshot steps support a per-step **file format** — `png` (lossless, default), `jpeg`, or `webp` — plus a **quality** (1–100) for the lossy formats. Full-page captures of long pages shrink dramatically with `webp` at quality 70–85. Diffs keep working across format changes: runs pair screenshots by label + viewport, ignoring the extension.

Other screenshot options: **full page** vs viewport, a one-off **mobile viewport** capture, and **annotate** (numbered labels on interactive elements, legend in the run log).

## Retries, recording, preflights

- **Retry policy** (above the step list): how often a failed step retries and how long to wait before/after.
- **🎥 Record this scenario** captures a `.webm` of each run → **Recordings** page.
- Attach a [preflight](/docs/preflights) so runs start logged-in / cookie-consented.

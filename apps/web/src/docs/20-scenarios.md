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
| `press` | Press a key or chord on the focused element — `Enter`, `Tab`, `Space`, `Escape`, `ArrowDown`, `Control+a`, `Shift+Tab` (agent-browser `press`). No selector: focus comes from the previous click/fill |
| `evaluate` | Run a JavaScript snippet in the page |
| `record_start` / `record_stop` | Bracket a video recording segment |
| `close` | Close the page |

## Targeting an element

A step's selector can be one of three things:

- **role + name** (what the snapshot picker records): resolved against the accessibility tree before each attempt; `ordinal` / `ancestorPath` disambiguate duplicates.
- **locator** (`+ by selector…`): a raw agent-browser locator handed to the CLI as-is — `#id`, CSS, `[data-testid="x"]`, `text=Submit`, `xpath=//button`.
- **find** (`+ find…`): an agent-browser semantic locator, `agent-browser find <by> <value> …`, resolved by the browser tool in the live page. `by` is `role` (with an optional accessible-name filter), `text`, `label`, `placeholder`, `alt`, `title` or `testid`. Names match as a case-insensitive substring unless **exact**. Useful when the snapshot name carries invisible characters or a label isn't associated with its input. Only `click`, `fill`, `check` and `wait` accept a find selector — the actions `find` offers. Two limits seen with agent-browser 0.38: `text` only matches elements without child elements (a label that also contains an icon or tooltip is skipped), and `label` finds the *input* a label describes, so a label without `for=` that doesn't wrap its input matches nothing.

Payload example:

```json
{ "selector": { "role": "", "name": "", "find": { "by": "role", "value": "checkbox", "name": "Ik heb zonnepanelen" } } }
```

## Editing steps

- **✎ on a step row** opens the edit modal. Screenshot steps get friendly fields; every other kind exposes its payload JSON.
- Drag the `⠿` handle (or use ▲/▼) to reorder.
- **edit raw** next to the *Steps* heading jumps to the Admin raw-steps editor with this scenario preselected — useful for fixing a malformed payload by hand.
- **compact** (same spot) caps the step list at a fixed height with its own scrollbar, so on a long scenario the add-step buttons and **Run now** stay in view. The choice is remembered in this browser.

## Screenshot format & quality

Screenshot steps support a per-step **file format** — `png` (lossless, default), `jpeg`, or `webp` — plus a **quality** (1–100) for the lossy formats. Full-page captures of long pages shrink dramatically with `webp` at quality 70–85. Diffs keep working across format changes: runs pair screenshots by label + viewport, ignoring the extension.

Other screenshot options: **capture area** (full page vs viewport), a one-off **mobile viewport** capture, and **annotate** (numbered labels on interactive elements, legend in the run log).

> **Full-page shot comes out viewport-sized?** Some sites (e.g. the Greenchoice sign-up funnel) pin the page to the window height and scroll inside an inner panel, so the document has nothing beyond the viewport to capture. Tick **Expand inner scroll containers** on the screenshot step: the runner temporarily unlocks that panel so the document grows to the real content height, captures, then restores the layout. The run log shows what it unlocked ("expand scrollers: 1 inner scroller(s) unlocked, document now 1927px tall").

> **Screenshotting a modal or dialog?** Use a **viewport** capture. A full-page capture renders the page beyond the viewport, and fixed overlays (the dialog and its backdrop) are not drawn in that mode — you get the dimmed page but no modal. The ✎ editor on a screenshot step switches the capture area; "+ screenshot (viewport)" adds one directly.

## Retries, recording, preflights

- **Retry policy** (above the step list): how often a failed step retries and how long to wait before/after.
- **🎥 Record this scenario** captures a `.webm` of each run → **Recordings** page.
- Attach a [preflight](/docs/preflights) so runs start logged-in / cookie-consented.

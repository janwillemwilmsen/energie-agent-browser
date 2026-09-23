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

## Screenshot format & quality

Screenshot steps support a per-step **file format** — `png` (lossless, default), `jpeg`, or `webp` — plus a **quality** (1–100) for the lossy formats. Full-page captures of long pages shrink dramatically with `webp` at quality 70–85. Diffs keep working across format changes: runs pair screenshots by label + viewport, ignoring the extension.

Other screenshot options: **full page** vs viewport, a one-off **mobile viewport** capture, and **annotate** (numbered labels on interactive elements, legend in the run log).

## Retries, recording, preflights

- **Retry policy** (above the step list): how often a failed step retries and how long to wait before/after.
- **🎥 Record this scenario** captures a `.webm` of each run → **Recordings** page.
- Attach a [preflight](/docs/preflights) so runs start logged-in / cookie-consented.

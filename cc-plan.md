# energie-agent-browser — Project Plan & Architecture Reference

> A React + SQLite web application that drives the Vercel Labs **`agent-browser`** CLI
> against a remote **browserless** instance to capture mobile/desktop screenshots, run
> scripted pre-screenshot interaction scenarios, expose the accessibility-tree snapshot
> with element refs, perform visual (pixel) diffs between runs, and re-execute scenarios
> on-demand or on a cron schedule.

This document describes the full system: the stack, the monorepo layout, every page and
its behaviour, the complete HTTP/WebSocket API, the database schema, the agent-browser
integration layer, and the deployment/operational concerns.

---

## 1. High-level overview

The product lets a non-developer build a **scenario**: a target URL plus an ordered list of
**steps** (navigate, click, type, fill, scroll, wait, evaluate JS, screenshot). Running a
scenario drives a real Chrome browser (hosted remotely on browserless, controlled over CDP
via the `agent-browser` daemon) through those steps and captures PNG screenshots. Runs are
stored, can be browsed as timelines/galleries, and any two runs can be **pixel-diffed** to
spot visual regressions. Scenarios can be scheduled with cron expressions.

A key capability is **preflights**: reusable, named step sequences (typically a login or
cookie-consent flow) that establish browser state. A scenario can opt into a preflight so it
starts "already logged in". Credentials for login flows are held in agent-browser's own
encrypted **Auth Vault**, never in the app's database.

### Core data flow

```
Browser (React SPA)
   │  REST  /api/*            WS  /ws/terminal, /ws/screencast
   ▼
Fastify server (apps/server)
   │  spawns native binary
   ▼
agent-browser daemon (node-pty / child_process)  ──CDP/wss──►  browserless (remote Chrome)
   │
   ├─ better-sqlite3  →  data/sqlite.db
   └─ filesystem      →  data/screenshots/<run_id>/*.png, data/diffs/*.png, data/preview/*.jpg
```

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | Vite 5 + React 18 + TypeScript, React Router v6, xterm.js (`@xterm/xterm` + addon-fit), `@dnd-kit` (drag-reorder), `cronstrue` (cron humanizing) |
| **Backend** | Node.js (ESM), Fastify 4 (`@fastify/cors`, `@fastify/static`, `@fastify/websocket`), better-sqlite3 12, node-pty 1, node-cron 3, `p-queue` (serialize scheduled runs), `pngjs` + `pixelmatch` (visual diff), `zod` (validation), `ws` |
| **Browser automation** | `agent-browser` ^0.27 (native per-platform binary, invoked directly) → browserless v2 over CDP/wss |
| **Shared** | `@eab/shared` — Zod schemas, step/selector/a11y types, shared between server & web |
| **Dev tooling** | `tsx` (run/watch TS directly, no build step for the server), `vitest` (server tests), `npm-run-all` (parallel dev), npm workspaces |
| **Deployment** | Nixpacks (`nixpacks.toml`) → single container that serves both the API and the built SPA on `$PORT` (Coolify/Docker target) |

The server runs TypeScript **directly via `tsx`** in both dev and production (`start` =
`tsx src/index.ts`); `build` is only a `tsc --noEmit` type-check. The web app is built with
Vite to `apps/web/dist`, which the server serves statically when present.

---

## 3. Monorepo layout

```
/                         npm workspaces root
├── apps/
│   ├── server/           Fastify API + agent-browser driver + scheduler + WS
│   │   ├── src/
│   │   │   ├── index.ts            Fastify bootstrap, route registration, SPA fallback, graceful shutdown
│   │   │   ├── config.ts           env parsing + browserlessCdpUrl() (stealth launch params)
│   │   │   ├── db/
│   │   │   │   ├── index.ts        better-sqlite3 singleton (WAL, foreign_keys ON)
│   │   │   │   └── migrate.ts      file-based migration runner (_migrations table)
│   │   │   ├── agentBrowser/
│   │   │   │   ├── driver.ts       daemon lifecycle, command exec, session-name/state mgmt
│   │   │   │   ├── parser.ts       parse agent-browser YAML-ish a11y snapshot → tree
│   │   │   │   └── launchConnect.cjs   (launch helper)
│   │   │   ├── scenarios/
│   │   │   │   ├── runner.ts       executeScenario(): step engine, retries, restarts, viewports
│   │   │   │   ├── preflightExecutor.ts   shared preflight step exec (record/replay/run)
│   │   │   │   ├── selector.ts     resolve SelectorStrategy → @eN ref against a11y tree
│   │   │   │   └── selector.test.ts
│   │   │   ├── routes/             one module per resource (see API section)
│   │   │   ├── scheduler/index.ts  node-cron registration + p-queue(concurrency:1)
│   │   │   ├── ws/
│   │   │   │   ├── terminal.ts     /ws/terminal → pty shell
│   │   │   │   └── screencast.ts   /ws/screencast → ~1.5s jpeg frames
│   │   │   └── diff/pixelDiff.ts   pngjs + pixelmatch diff
│   │   └── stealth/init.js         page-init anti-bot patches
│   └── web/              Vite + React SPA
│       ├── src/
│       │   ├── main.tsx, App.tsx   router + nav layout
│       │   ├── lib/                api.ts (REST client), screencast.tsx, TerminalShell.tsx, SnapshotPicker.tsx
│       │   └── pages/              Home, Scenarios, ScenarioEditor, ScenarioTimeline, Runs, Screenshots, Diffs, Preflight, Schedules, Terminal
│       └── vite.config.ts          dev server :5173, proxies /api + /ws → :3011
├── packages/shared/     @eab/shared — Zod schemas + types (a11y.ts, schemas.ts)
├── migrations/          001..006 *.sql
├── data/                sqlite.db (+ -wal/-shm), screenshots/, diffs/, preview/, agent-browser-logs/, swagger.json
├── scripts/wait-for-port.mjs   web dev waits for API port before starting Vite
├── nixpacks.toml        deployment build/start config
├── package.json         workspaces + dev/build/migrate scripts
└── tsconfig.base.json
```

### Root npm scripts
- `dev` → runs `dev:server` (tsx watch) + `dev:web` (vite) in parallel.
- `build` → builds every workspace.
- `test` → runs each workspace's tests if present (server uses vitest).
- `migrate` → applies SQL migrations.

---

## 4. Configuration & environment

`apps/server/src/config.ts` loads `.env` from the repo root. Variables:

| Var | Required | Default | Purpose |
|---|---|---|---|
| `BROWSERLESS_URL` | **yes** | — | wss URL of the browserless instance (e.g. `wss://browserless.chatle.nl`) |
| `BROWSERLESS_TOKEN` | **yes** | — | browserless auth token (added as `?token=` and used in env) |
| `PORT` | no | `3001` (`.env` sets `3011`) | API + SPA port |
| `WEB_ORIGIN` | no | `http://localhost:5173` | CORS origin |
| `DATA_DIR` | no | `./data` | sqlite + screenshots + diffs + logs root |
| `MIGRATIONS_DIR` | no | `./migrations` | SQL migration files |
| `AGENT_BROWSER_BIN` | no | `agent-browser` | (binary name; the driver actually resolves the native per-platform exe directly) |
| `SESSION_IDLE_TTL_MS` | no | `300000` | session idle TTL knob |
| `STEALTH_ENABLED` | no | `true` | master toggle for anti-bot evasion |
| `STEALTH_USER_AGENT` | no | Win10 Chrome 148 UA | UA spoof |
| `STEALTH_LAUNCH_ARGS` | no | see below | whitespace-separated Chromium launch flags |
| `STEALTH_IGNORE_DEFAULT_ARGS` | no | `--enable-automation` | default args to strip |
| `STEALTH_INIT_SCRIPT` | no | `apps/server/stealth/init.js` | page-init patch script |

### `browserlessCdpUrl()`
Builds the wss CDP URL: forces the path to `/chromium` (browserless v2 returns 404 on the
bare root), appends `?token=`, and — when stealth is enabled — folds the Chromium launch
options (`args`, `ignoreDefaultArgs`, `userAgent`) into a **base64-encoded `launch=` query
param** (base64 is more reliable than URL-encoded JSON through query parsers).

### Stealth (Cloudflare/WAF evasion)
Two layers, both controlled by env:
1. **Browser launch** — via the `launch=<base64>` param: removes `--enable-automation`,
   sets `--disable-blink-features=AutomationControlled` etc., and a Win10 Chrome UA.
2. **Page init** — `apps/server/stealth/init.js`, attached via `AGENT_BROWSER_INIT_SCRIPTS`:
   patches `navigator.webdriver`, `navigator.plugins`, `navigator.languages`,
   `navigator.permissions.query`, `window.chrome.runtime`, WebGL `UNMASKED_VENDOR`, etc.

Stealth covers JS/browser fingerprinting only — **not** TLS (JA3/JA4) or IP reputation. For
Cloudflare's harder challenges a residential proxy on the browserless side is also needed.

---

## 5. Database schema (SQLite)

Database file: `data/sqlite.db` (WAL mode, `foreign_keys = ON`). Migrations live in
`/migrations` and are applied in filename order; applied names are tracked in a
`_migrations(name, applied_at)` table. The runner is idempotent — each file runs once inside
a transaction.

### `scenarios` (001, extended by 002/004/005/006)
The top-level recorded flow.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | |
| `url` | TEXT NOT NULL | landing URL |
| `viewport_preset` | TEXT | `desktop` \| `mobile` \| `both` (default `desktop`) |
| `brand` | TEXT | optional tag (indexed) — for filtering/grouping |
| `type` | TEXT | optional tag (indexed) |
| `retries` | INTEGER default 0 | per-step retry count |
| `retry_wait_before_ms` | INTEGER default 0 | pause before each retry |
| `retry_wait_after_ms` | INTEGER default 0 | pause after a retry that succeeds |
| `restart_on_failure` | INTEGER default 0 | whole-run restart count |
| `preflight_id` | INTEGER FK→preflights ON DELETE SET NULL | optional attached preflight |
| `created_at`, `updated_at` | TEXT | |

### `scenario_steps` (001)
Ordered steps for a scenario.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `scenario_id` | INTEGER FK→scenarios ON DELETE CASCADE | |
| `position` | INTEGER NOT NULL | order key |
| `kind` | TEXT CHECK in (`navigate`,`click`,`type`,`fill`,`scroll`,`screenshot`,`wait`,`evaluate`) | |
| `payload_json` | TEXT default `{}` | step parameters (selector, text, label, etc.) |

Index: `idx_scenario_steps_scenario(scenario_id, position)`.

### `runs` (001)
One execution of a scenario.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `scenario_id` | INTEGER FK→scenarios ON DELETE CASCADE | |
| `started_at` / `finished_at` | TEXT | |
| `status` | TEXT CHECK in (`queued`,`running`,`success`,`failed`) | |
| `log_text` | TEXT | accumulating timestamped log (updated live during the run) |
| `screenshot_paths_json` | TEXT default `[]` | JSON array of screenshot filenames |

Index: `idx_runs_scenario_started(scenario_id, started_at DESC)`.
Screenshot bytes live on disk at `data/screenshots/<run_id>/<filename>.png`.

### `schedules` (001)
Cron schedules.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `scenario_id` | INTEGER FK→scenarios ON DELETE CASCADE | |
| `cron_expr` | TEXT NOT NULL | standard 5-field cron |
| `enabled` | INTEGER default 1 | |
| `last_run_at`, `last_status` | TEXT | updated after each fire |

### `artifacts` (003) — visual diff inputs/outputs
An artifact is any comparable PNG: a **copy** of a run screenshot, or a **diff** image.
Because a diff output is itself an artifact, diffs of diffs are supported.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `kind` | TEXT CHECK in (`run_screenshot`,`diff`) | |
| `file_path` | TEXT | relative to `dataDir` (stored under `data/diffs/<id>.png`) |
| `scenario_id` | INTEGER | soft ref, for listing/filtering |
| `source_run_id` | INTEGER | **soft** ref (deliberately NOT an FK); null for diff outputs |
| `label` | TEXT | slot key `NNN-label-viewport` |
| `viewport`, `width`, `height` | | |
| `created_at` | TEXT | |

Artifacts own a **copy** of the source image, so deleting a run (which removes its screenshot
folder) leaves existing comparisons viewable.

### `comparisons` (003)
A pixel-diff between two artifacts.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `scenario_id` | INTEGER | |
| `baseline_artifact_id` | INTEGER FK→artifacts ON DELETE CASCADE | |
| `target_artifact_id` | INTEGER FK→artifacts ON DELETE CASCADE | |
| `diff_artifact_id` | INTEGER FK→artifacts ON DELETE SET NULL | the diff image |
| `threshold` | REAL default 0.1 | pixelmatch threshold |
| `mismatch_ratio` | REAL | changed/compared pixels (0..1) |
| `status` | TEXT in (`ok`,`size_mismatch`,`error`) | |
| `note` | TEXT | e.g. size-mismatch explanation |
| `created_at` | TEXT | |

### `preflights` (006)
Reusable state-establishing step sequences (login / cookie-consent).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | **also the agent-browser `--session-name`**; charset-restricted at the API |
| `description` | TEXT | |
| `steps_json` | TEXT default `[]` | JSON array of PreflightStep |
| `created_at`, `updated_at` | TEXT | |
| `deleted_at` | TEXT | **soft delete** — hides from listings, keeps on-disk auth.json recoverable |

Partial unique index `idx_preflights_name_active(name) WHERE deleted_at IS NULL` — name is
unique among active rows; soft-deleting frees the name for a replacement.

---

## 6. agent-browser integration layer (`apps/server/src/agentBrowser/driver.ts`)

This is the heart of the backend — it owns the lifecycle of agent-browser daemons and runs
CLI commands against them. Key concepts:

- **Native binary, invoked directly.** `getNativeBin()` selects
  `node_modules/agent-browser/bin/agent-browser-<os>-<arch>[.exe]` and spawns it directly
  (not via the package's JS wrapper, which pops a console window on Windows with
  `windowsHide:false`).

- **Sessions (`--session <name>`).** A "session" is a named long-lived daemon. The whole app
  shares a single session called **`default`** — the user bootstraps it once (from a Terminal
  tab) and every scenario run, the live preview, and preflight recording reuse it. Daemon
  liveness is tracked via marker files under `~/.agent-browser/` (`<session>.pid`, `.port`,
  `.stream`, etc.). `isSessionAlive()` = pid file exists **and** the recorded pid is alive;
  the daemon writes its pid only after the wss handshake succeeds, so this doubles as a
  readiness signal.

- **Session-name (`--session-name <name>`) = persistent state slot.** Maps to a preflight
  name. State (cookies/localStorage) persists under
  `~/.agent-browser/sessions/<name>.json`. A disk marker `<session>.session-name` records
  which session-name a daemon was bootstrapped with so the binding survives `tsx watch`
  hot-reloads.

- **`ensureSession(session, {sessionName?})`** — the central reconciler. If a daemon is alive
  and the session-name matches (or none was requested), reuse it (re-applying disk state when
  a name is requested, since the in-memory cookie jar can drift). On mismatch, close and
  re-bootstrap. Concurrent calls are de-duplicated via an in-flight `Promise` map.

- **State load is explicit.** agent-browser's `--session-name` startup flag only schedules
  the *auto-save* half over wss; the auto-load half is a no-op. So after bootstrap the driver
  runs `state load <path>` (`loadPersistedStateIntoDaemon`) to actually populate cookies.
  `closeSession` deliberately does **not** auto-flush state (that eroded saved auth); disk
  state is authoritative and only written by explicit saves (preflight Save / Replay).

- **Command execution helpers:**
  - `run(args, {session, timeoutMs})` — `ensureSession` then run the CLI command on the daemon.
  - `runJson(args)` — `run(['--json', ...])`, parse `{success, data}` envelope.
  - `runWithStdin(args, line)` — daemon-routed, pipes one line to stdin (for `auth save --password-stdin`, keeping passwords off argv).
  - `runDetached` / `runDetachedWithStdin` — for purely-local commands that must NOT auto-connect (auth vault CRUD, version), run with plain env.
- **Bootstrap robustness (Windows-heavy):** `spawnConnectDetached` spawns the daemon through
  **node-pty/conpty** (the native exe needs a real console for its CDP client; conpty gives
  one without a visible window) and tails the log file for failure lines (`✗ Could not
  configure browser: …`) so a failed handshake surfaces in ~1s instead of waiting out the
  40s ready timeout. `killStaleDaemons()` taskkills zombie daemons (which correlate with
  Windows error 10060) and wipes stale marker files before each fresh connect.
- **Lifecycle exports used elsewhere:** `persistSessionState`, `clearPersistedSessionState`,
  `flushSessionState`, `closeAllActiveSessions` (called on SIGINT/SIGTERM to flush every
  bound session before exit), `PREFLIGHT_RECORDER_SESSION = 'default'`.

### Snapshot parsing (`parser.ts`)
`parseSnapshotText()` parses agent-browser's YAML-ish accessibility snapshot
(`- role "name" [attr=v, ref=eN]`, indentation = hierarchy) into an `A11yTree` of
`A11yNode { ref, role, name, value?, text?, children }`.

### Selector resolution (`scenarios/selector.ts`)
`resolveSelector(strategy, tree)` finds a fresh `@eN` ref for a `SelectorStrategy`:
1. filter by `role` (case-insensitive exact),
2. exact-trim match on accessible `name`,
3. narrow by `textContains` (substring of name/text),
4. narrow by `ancestorPath` (landmark-role ancestors, in order),
5. disambiguate by `ordinal` (0-indexed document order).

Throws `SelectorNotFoundError` / `SelectorAmbiguousError` (carrying surviving candidates) so
the runner can produce a diagnostic. Refs are bound to a single snapshot and go stale on any
DOM mutation, so the runner re-snapshots before each selector-based step.

---

## 7. Scenario execution engine (`apps/server/src/scenarios/runner.ts`)

`executeScenario(scenarioId): Promise<runId>` — the orchestrator. Steps:

1. Load the scenario, its steps, and (if `preflight_id` set and not soft-deleted) the
   preflight name + steps.
2. Insert a `runs` row with status `running`; create `data/screenshots/<runId>/`.
3. Determine viewports: `both` → `['desktop','mobile']`, else the single preset.
4. **Preflight phase** (if attached): `ensureSession('default', {sessionName})` to bind the
   daemon, then execute the preflight's steps *fresh every run* (via `executePreflightSteps`).
   Running the login flow each time sidesteps IdP/Auth0 session-cookie TTL. On preflight
   failure the run is hard-failed (a logged-in scenario can't run logged-out).
5. **Restart loop** (`restart_on_failure` times): on a failed attempt, `closeSession` +
   `ensureSession` to reset the connection, then re-run the whole scenario from the top.
6. For each viewport: `applyViewport` (desktop = `set viewport 1440 900`; mobile =
   `set device "iPhone 14"`) then run every step via `executeStepWithRetries`.
7. Persist final `status`, `finished_at`, `log_text`, `screenshot_paths_json`.

### Step semantics (`executeStep`)
- **navigate** → `open <url>`.
- **click / type / fill** → snapshot the tree, `resolveSelector` → `@eN` ref, then run the
  CLI verb (`type` appends text, `fill` appends value).
- **scroll** → selector present ⇒ `scrollintoview <ref>`; `toTop` ⇒ `scroll up 100000`;
  `toBottom` ⇒ 15× `scroll down 800` with 600ms pauses (triggers IntersectionObserver lazy
  loaders); else `scroll <dir> <px>` from `dy`.
- **wait** → selector ⇒ `wait --text "<name>"` (polls live page; refs would go stale); else
  `wait <ms>`.
- **evaluate** → `eval <js>`.
- **screenshot** → filename `NNN-<label>-<viewport>.png` (NNN = step position). `fullPage`
  (default true) ⇒ `--full`; `annotate` ⇒ `--annotate` (overlays numbered element labels, the
  legend is logged); `viewport:'mobile'` ⇒ temporarily switch to the mobile device, capture,
  restore. Filename pushed to `ctx.screenshots`.

`executeStepWithRetries` retries a failing step up to `retries` times with the configured
before/after pauses. Every step appends a timestamped line to the run log, which is flushed
to `runs.log_text` live so the UI can poll it.

### Preflight executor (`scenarios/preflightExecutor.ts`)
Shared by recorder live-exec, Replay, and scenario runs so step semantics are identical
everywhere. Adds:
- **Implicit wait on selectors** (`resolveSelectorWithWait`, 15s/250ms poll) — cookie banners
  etc. appear in the a11y tree a beat after navigation. On exhaustion, `diagnoseFailure`
  reports tree size, the URL, and same-role candidate names.
- **Navigation verification** (`execNavigate`, 3 attempts) — the first `open` after a fresh
  `--session-name` daemon respawn sometimes succeeds but leaves the browser at `about:blank`;
  it re-issues `open` until the URL actually changes.
- **PreflightStep kinds:** `navigate`, `wait` (ms), `click`, `type`, and `auth-login` (runs
  `auth login <name>` — agent-browser's vault handles navigate→fill→submit using the
  encrypted profile).

---

## 8. Scheduler (`apps/server/src/scheduler/index.ts`)

- On boot, `startScheduler()` loads all `enabled=1` schedules and registers each with
  `node-cron`.
- `registerSchedule(row)` validates the cron expr and (re)registers a task; firing
  `enqueueRun` adds the scenario run to a **`p-queue` with `concurrency:1`** so scheduled
  runs never overlap (they share the single `default` browser session). After each run the
  schedule's `last_run_at` / `last_status` is updated.
- `unregisterSchedule` / re-register on every create/update so changes take effect live.

---

## 9. Visual diff (`apps/server/src/diff/pixelDiff.ts` + `routes/diffs.ts`)

- `diffPngFiles(baseline, target, out, threshold)` reads both PNGs with `pngjs`. If sizes
  differ it compares the common **top-left overlap** and flags `size_mismatch` (policy: show
  what changed above the fold rather than refusing). Runs `pixelmatch`, writes the diff PNG,
  returns mismatch pixel count + ratio + dimensions.
- In `routes/diffs.ts`, `materializeRunScreenshot` copies a run screenshot into
  artifact-owned storage (`data/diffs/<artifactId>.png`), deduped by `(source_run_id, label)`,
  so comparisons survive run deletion. `createComparison` inserts the diff artifact row first
  (to get a stable id/path), runs the diff, and inserts the `comparisons` row.
- `compare-runs` pairs two runs' screenshots by the **stable suffix** `<label>-<viewport>.png`
  (stripping the `NNN-` position prefix, which shifts when steps are inserted) and diffs each
  matching pair, reporting unmatched slots.
- Deleting a comparison only deletes artifacts no longer referenced by any other comparison
  (so diffs-of-diffs inputs are preserved).

---

## 10. HTTP API (REST)

All under `/api`. Bodies validated with Zod. JSON in/out unless noted. Served by Fastify;
in dev, Vite proxies `/api` → `http://localhost:3011`.

### Health
- `GET /health` → `{ ok, ts }`.

### Scenarios (`routes/scenarios.ts`)
- `GET /api/scenarios` — all scenarios, newest-updated first.
- `GET /api/scenarios/cards` — homepage cards: each scenario + its latest finished run's id,
  start time, status, and **last** screenshot (the final captured state, used as thumbnail).
- `GET /api/scenarios/:id` — scenario + its steps (ordered).
- `GET /api/scenarios/:id/runs` — all runs for a scenario, oldest-first (timeline data).
- `POST /api/scenarios` — create (`ScenarioCreate`). → 201 + row.
- `PUT /api/scenarios/:id` — update (`ScenarioUpdate`, partial; merges with existing).
- `DELETE /api/scenarios/:id` — delete (cascades steps/runs/schedules). → 204.
- **Steps:**
  - `POST /api/scenarios/:id/steps` — add `{position, kind, payload}`. → 201.
  - `PUT /api/scenarios/:id/steps/:stepId` — replace position/kind/payload.
  - `DELETE /api/scenarios/:id/steps/:stepId` — → 204.
  - `POST /api/scenarios/:id/steps/:stepId/move` — `{direction:'up'|'down'}`, atomic position swap.
  - `POST /api/scenarios/:id/steps/reorder` — `{order:[stepId,…]}`, rewrites positions 0..n-1 (two-phase to avoid collisions); rejects unless ids exactly match the current set.

### Runs (`routes/runs.ts`)
- `POST /api/scenarios/:id/run` — start a run. **Requires the `default` session alive**, else
  `409 session_not_ready`. Fire-and-forget; waits ~50ms for the row, returns `202` + the new run.
- `GET /api/runs` — latest 100 runs joined with scenario name/brand/type, newest first.
- `GET /api/runs/:id` — one run.
- `GET /api/runs/:id/screenshots/:name` — stream a screenshot PNG (`path.basename` guards traversal).
- `DELETE /api/runs/:id` — delete run + its screenshot folder. → 204.
- `POST /api/runs/delete` — `{ids:[…]}` bulk delete (+ folders). → `{deleted}`.
- `DELETE /api/runs` — delete all runs (+ folders). → 204.

### Snapshot (`routes/snapshot.ts`)
- `POST /api/snapshot` — `{url?, session='default', compact=true, interactiveOnly=false}`. If
  `url` given, `open` it first; then `snapshot [--compact] [--interactive]`, returns
  `{ tree, raw }` (parsed a11y tree + raw refs). Errors → `502`.

### Sessions (`routes/sessions.ts`)
- `GET /api/sessions/:name/status` → `{ name, alive, pid }`.
- `POST /api/sessions/:name/bootstrap` → `ensureSession(name)`; `{name, alive, pid}` or `502`.
- `POST /api/sessions/:name/close` → `closeSession(name)`; `{name, closed:true}`.

### Browserless health (`routes/browserlessHealth.ts`)
- `GET /api/browserless/health` — probes `<https-base>/docs` (gates `ok`, accepts 2xx/3xx)
  and `/json/version` (token-gated; version echoed but never the token). Returns
  `{ ok, checkedAt, latencyMs, docs{url,status,ok,error}, version{browser,protocolVersion,userAgent,webSocketDebuggerUrl}, cdp{configuredUrl} }`.

### Schedules (`routes/schedules.ts`)
- `GET /api/schedules` — all.
- `POST /api/schedules` — `{scenario_id, cron_expr, enabled=true}`; validates cron; registers live. → 201.
- `PUT /api/schedules/:id` — partial update; re-validates cron; re-registers.
- `DELETE /api/schedules/:id` — → 204 + unregister.

### Preflights (`routes/preflights.ts`)
- `GET /api/preflights` — active (non-deleted) preflights.
- `GET /api/preflights/:id` — one (includes soft-deleted by id).
- `POST /api/preflights` — `{name, description?, steps?}`; `409 name_taken` if active name clashes. → 201.
- `PUT /api/preflights/:id` — update; on rename checks active-name clash. **Also persists the
  captured browser auth state** — but only if the live `default` daemon's `.session-name`
  marker currently equals this preflight's name (otherwise it'd corrupt another preflight's slot).
- `DELETE /api/preflights/:id` — **soft delete** (sets `deleted_at`); on-disk auth.json kept. → 204.
- **Recorder:**
  - `POST /api/preflights/recorder/start` — `{name}` → `ensureSession('default', {sessionName:name})` (no-op if already bound). The preview then shows the live browser for free.
  - `POST /api/preflights/recorder/stop` — UI-state only; daemon kept alive.
  - `POST /api/preflights/recorder/exec-step` — `{step}` → execute one PreflightStep live.
- `POST /api/preflights/:id/replay` — close + `flushSessionState` + `clearPersistedSessionState`
  (wipe to a blank browser), re-bootstrap bound to the name, run every step fresh, then
  `persistSessionState` (one of only two places allowed to write the canonical auth.json).

### Auth profiles (`routes/authProfiles.ts`) — encrypted credential vault
All shell out to `agent-browser auth …` routed through the live `default` daemon (the CLI
always tries to bootstrap browserless even for local commands, so routing through the daemon
avoids 10060). agent-browser owns storage/encryption: `~/.agent-browser/auth/<name>.json`,
AES-GCM with the key in `~/.agent-browser/.encryption-key`. The app never touches the files.
- `GET /api/auth-profiles` — `auth list`, parsed to `[{name, username, url}]`.
- `GET /api/auth-profiles/:name` — `auth show` → `{name, url, username}` (never password).
- `POST /api/auth-profiles` — `auth save … --password-stdin` (password piped, never on argv);
  optional `usernameSelector`/`passwordSelector`/`submitSelector`. → 201.
- `DELETE /api/auth-profiles/:name` — `auth delete`. → 204.

### Diffs / comparisons / artifacts (`routes/diffs.ts`)
- `GET /api/artifacts/:id/image` — stream an artifact PNG.
- `GET /api/comparisons[?scenario_id=]` — comparisons (enriched with baseline/target/diff artifacts), newest first, ≤200.
- `GET /api/comparisons/:id` — one enriched comparison.
- `POST /api/comparisons` — `{scenarioId?, threshold=0.1, baseline, target}` where each ref is
  `{artifactId}` or `{runId, slot}`. Materializes refs, diffs, persists. Supports diff-of-diff. → 201.
- `POST /api/scenarios/:id/compare-runs` — `{baselineRunId, targetRunId, threshold=0.1}`; pairs
  screenshots by stable slot suffix and diffs each. → 201 `{created, matched, onlyBaseline, onlyTarget}`.
- `DELETE /api/comparisons/:id` — delete + GC unreferenced artifacts. → 204.

---

## 11. WebSocket API

In dev, Vite proxies `/ws` → `ws://localhost:3011`.

### `/ws/terminal` (`ws/terminal.ts`)
Spawns a pty shell (Windows: `%COMSPEC%`/cmd.exe; POSIX: first of `$SHELL`, `/bin/bash`,
`/usr/bin/bash`, `/bin/sh`, `/usr/bin/sh` that exists — slim Nixpacks images may only have
`sh`). The pty env injects agent-browser wiring: PATH (both workspace + root `node_modules/.bin`),
`AGENT_BROWSER_SESSION=default`, `BROWSERLESS_CDP_URL` (full stealth URL), `BROWSERLESS_API_URL/KEY`,
and the stealth UA/init-script. Protocol: client→server `{type:'data',data}` and
`{type:'resize',cols,rows}`; server→client `{type:'data',data}` and `{type:'exit',exitCode,signal}`.
A spawn failure (e.g. ENOENT on the shell) is surfaced as red text in the terminal rather than
a silent disconnect.

### `/ws/screencast?session=<name>` (`ws/screencast.ts`)
Live preview: every **1.5s** runs `screenshot` (jpeg, quality 60) on the daemon and sends
`{type:'frame', capturedAt, data:<base64 jpeg>}`. **One concurrent stream at a time** (a new
connection closes the previous). If the session isn't alive it sends a `{type:'help'}` message
telling the user to bootstrap via the Terminal, then closes (1011). Capture errors →
`{type:'error'}`. `inflight` guard prevents overlapping captures.

---

## 12. Shared package (`packages/shared`)

Imported as `@eab/shared` by both server and web (source `.ts` is the entry — no build step).

- **`a11y.ts`** — `A11yNode { ref, role, name, value?, text?, children[] }`, `A11yTree { root, capturedAt, url }`.
- **`schemas.ts`** — Zod schemas + inferred types:
  - `ViewportPreset`, `StepKind`, `SelectorStrategy` (role, name, textContains?, ordinal?, ancestorPath?).
  - `StepPayload` — discriminated union over the 8 step kinds (navigate/click/type/fill/scroll/screenshot/wait/evaluate) with per-kind params.
  - `Scenario`, `ScenarioCreate`, `ScenarioUpdate`, `ScenarioStep`.
  - `PreflightName` / `AuthProfileName` — `[A-Za-z0-9._-]{1,64}` (safe as CLI arg + filename).
  - `PreflightStep` — union of navigate/wait/click/type/`auth-login`(name).
  - `AuthProfile`, `AuthProfileCreate` (incl. optional CSS selector overrides).
  - `Preflight`, `PreflightCreate`, `PreflightUpdate`.
  - `Schedule`, `RunStatus`, `Run`.

---

## 13. Frontend (`apps/web`)

Vite + React 18 + React Router v6 SPA. `main.tsx` mounts `<App/>` in `<BrowserRouter>` +
`<StrictMode>`. `App.tsx` renders a fixed nav (`Home, Scenarios, Preflights, Terminal,
Schedules, Runs, Screenshots, Diffs`) + a `<main>` with the routes. Dev server on **:5173**,
proxying `/api` and `/ws` (with upgrade) to **:3011**.

### Routes
| Path | Page |
|---|---|
| `/` | Home (dashboard) |
| `/scenarios` | Scenarios (list + create) |
| `/scenarios/:id` | ScenarioEditor |
| `/scenarios/:id/timeline` | ScenarioTimeline |
| `/runs` (`?run=<id>`) | Runs |
| `/screenshots` | Screenshots |
| `/diffs` | Diffs |
| `/preflight` | Preflight |
| `/schedules` | Schedules |
| `/terminal` | Terminal |

### API client (`lib/api.ts`)
A typed `req<T>()` wrapper around `fetch` (sets JSON content-type only when there's a body,
throws `"<status> <statusText> — <body>"` on non-OK, returns `undefined` on 204). The `api`
object exposes one method per endpoint listed in §10–11, plus helpers like
`artifactImageUrl(id)` → `/api/artifacts/:id/image` (used directly as an `<img src>`). Run
screenshot URLs (`/api/runs/:id/screenshots/:file`) are built inline in pages.

### Shared components (`lib/`)
- **`PreviewStream` (`screencast.tsx`)** — opens `/ws/screencast?session=`, renders frames as
  `<img src="data:image/jpeg;base64,…">` with a status badge (idle/connecting/live/error/closed);
  closes the socket when `active` flips off.
- **`TerminalShell` (`TerminalShell.tsx`)** — xterm.js bound to `/ws/terminal`; exposes an
  imperative `send(line)` ref. Defers init via `requestAnimationFrame` until the container has
  size (avoids a StrictMode double-mount crash); a `ResizeObserver` refits and sends `resize`.
- **`SnapshotPicker` (`SnapshotPicker.tsx`)** — renders the a11y tree as an indented list with
  per-node action buttons (click/type/fill/wait/scrollIntoView). `buildStrategy()` builds a
  `SelectorStrategy` (role+name, plus `ordinal` for duplicate siblings and an `ancestorPath`
  of landmark ancestors for disambiguation). (ScenarioEditor has a near-identical inline copy.)

### Pages
- **Home (`/`)** — scenario cards from `listScenarioCards()`. Collapsible brand/type chip
  filters (client-side). Each card links to `/scenarios/:id/timeline`, shows a lazy thumbnail
  (latest run's last screenshot), tags, and last-run time/status.
- **Scenarios (`/scenarios`)** — list + collapsible create form (name, URL, viewport, brand,
  type). Inline-editable brand/type (save on blur). Per row: **Run** (resets the `default`
  session via close+bootstrap, then `startRun`; one at a time; deep-links to `/runs?run=<id>`),
  a Screenshots/timeline link, and Delete.
- **ScenarioEditor (`/scenarios/:id`)** — the most complex page. Metadata form (name, viewport,
  URL, brand, type, **"Use auth from" preflight** selector) with dirty-tracking; retry-policy
  inputs (retries + before/after waits + restart-on-failure, persisted on blur); a
  **drag-reorderable** step list (`@dnd-kit`, optimistic + `reorderSteps`, with up/down/delete
  and add-step buttons); a `PreviewStream` + **Play / Reset&Play** (polls `getRun` every 1.5s
  up to 120s); a **Snapshot** picker that adds steps from picked elements; and an embedded
  `TerminalShell` with bootstrap/reset session + quick agent-browser commands.
- **ScenarioTimeline (`/scenarios/:id/timeline`)** — cross-run screenshot grid: rows = logical
  step screenshots (keyed by filename with the `NNN-` prefix stripped so steps line up across
  runs), columns = completed runs; cells = thumbnails linking to full images.
- **Runs (`/runs`, `?run=<id>`)** — run list (polls 1.5s while watching a running run, else 4s).
  Brand/type filters. Ordered multi-select (single toggle, shift-range, select-all) driving
  **bulk delete** and **compare** (exactly two runs of the same scenario → `compareRuns` →
  navigate to `/diffs`). `RunDetail` shows the log newest-first + a live indicator + screenshot grid.
- **Screenshots (`/screenshots`)** — per-scenario gallery (polls 6s), keeping the latest run
  per (scenario, day) with a per-scenario date picker (older/newer hops between populated days),
  plus a global "reset to latest". Local-date handling avoids UTC drift.
- **Diffs (`/diffs`)** — visual diff browser. Groups comparisons by source-run pair; each
  `DiffCard` shows status, mismatch %, label, and baseline/target/diff images. A selection tray
  lets you pick two artifacts (incl. a prior diff) and re-compare (`createComparison`).
- **Preflight (`/preflight`)** — record reusable login/cookie flows bound to a named session of
  the `default` daemon. Session-bar chips load a preflight (`startPreflightRecorder`); add
  navigate/wait/`auth-login` steps and snapshot-picked click/type steps, each executed live
  (`execPreflightStep`); Save (`create`/`update` + state capture), Replay (clean), soft Delete;
  a `PreviewStream`; and an `AuthProfilesPanel` (vault CRUD; password wiped from state after save).
- **Schedules (`/schedules`)** — friendly cron builder (day chips, hour mode, minute) that
  composes `m h * * d`, humanized live with **cronstrue**; table of schedules with
  enable/disable toggle, last run/status, delete.
- **Terminal (`/terminal`)** — full-height `TerminalShell` + a `BrowserlessHealthPanel`
  (polls `browserlessHealth()` every 10s: tri-state badge, latency, configured CDP URL, `/docs`
  probe, browser/protocol/wss-debugger version). Quick buttons bootstrap the default session,
  `--version`, `get url`.

### Cross-cutting frontend notes
- A single shared browser session named **`default`** is used everywhere; because of it,
  runs are effectively serialized.
- Deep-link convention `/runs?run=<id>` opens a specific run's panel.
- Repeated UI patterns: brand/type chip filters, `status status-<status>` badges,
  `<details>` collapsibles, interval polling to stay live during runs.

---

## 14. Server bootstrap & lifecycle (`apps/server/src/index.ts`)

1. `migrate()` applies pending SQL migrations.
2. Create Fastify (logger on), register `cors` (origin = `WEB_ORIGIN`, credentials) and `websocket`.
3. `GET /health`.
4. Register all route modules + the two WS routes.
5. **Static SPA fallback:** if `apps/web/dist/index.html` exists, serve it with
   `@fastify/static` and a not-found handler that returns `index.html` for non-`/api`,
   non-`/ws` paths (so client-side routes survive a hard refresh while API/WS 404s stay honest).
   In dev (no dist) only the API is exposed and Vite serves the SPA.
6. `startScheduler()`.
7. **Graceful shutdown** (SIGINT/SIGTERM): `closeAllActiveSessions()` flushes every bound
   `--session-name` daemon's state to disk (15s cap) before `app.close()` + exit — so live
   preflight auth isn't stranded in browser memory.
8. Top-level `uncaughtException`/`unhandledRejection` handlers log and keep the API up (node-pty
   on Windows can throw a late "AttachConsole failed" that would otherwise kill the server).

Listens on `0.0.0.0:$PORT`.

---

## 15. Deployment & operations

- **Nixpacks** (`nixpacks.toml`) builds a single container that, in production, serves both the
  API and the built SPA on `$PORT` (Coolify/Docker target). The server runs via `tsx` (no
  compiled output). `migrate` runs as part of bringing the app up.
- **Data persistence:** everything stateful lives under `DATA_DIR` (sqlite db + WAL, run
  screenshots, diff artifacts, preview jpegs, agent-browser logs) plus agent-browser's own
  `~/.agent-browser/` (session markers, persisted session state, encrypted auth vault). Both
  must be on durable volumes.
- **Bootstrapping a session:** no daemon runs at startup. The user opens the **Terminal** tab
  and runs `agent-browser --session default connect "%BROWSERLESS_CDP_URL%"` (or uses the
  bootstrap button). On Windows, bootstrapping from the server process itself occasionally
  fails the outbound wss handshake with OS error 10060 — the terminal path reliably works
  around it, and the driver also retries/kills zombies.
- **Concurrency model:** one shared `default` session ⇒ scenario runs, live preview, preflight
  recording, and auth CRUD all contend for one browser. Scheduled runs are serialized through a
  `p-queue` (concurrency 1). The UI generally enforces "one run at a time" and "one preview stream".
- **Security posture:** passwords never hit argv (piped via `--password-stdin`) and never leave
  the encrypted vault; the browserless token is never echoed to the client; screenshot routes
  guard against path traversal with `path.basename`. There is **no application-level auth** on
  the API itself — deploy behind a trusted network / reverse-proxy auth.

---

## 16. Notable design decisions & gotchas (quick reference)

- **agent-browser native binary invoked directly** to avoid a console-window popup on Windows.
- **Daemon spawned through conpty (node-pty)** because the native CDP client needs a real console.
- **`--session-name` auto-load is a no-op over wss** → the driver explicitly runs `state load`.
- **`closeSession` never auto-flushes state** (it eroded saved auth); only Preflight Save and
  Replay write the canonical `~/.agent-browser/sessions/<name>.json`.
- **Preflight steps re-run fresh every scenario run**, sidestepping IdP session-cookie TTLs.
- **Diff artifacts own a copy** of each screenshot, so comparisons survive run deletion;
  `source_run_id` is a soft ref, not an FK.
- **Screenshot slot pairing strips the `NNN-` position prefix** so the same logical shot matches
  across runs taken before/after a scenario edit.
- **Preflights are soft-deleted**; on-disk auth.json is kept for recovery; the active-name
  unique index frees the name for a replacement.
- **Session readiness = pid file exists + pid alive** (daemon writes pid only post-handshake).

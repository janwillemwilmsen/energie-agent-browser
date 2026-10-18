# Projects — investigation and plan

> A **Project** is a top-level container that separates topics and brands (e.g. "Essent",
> "Eneco offers", "Internal tooling"). Every page gets a project switcher; what a page lists
> is what belongs to the active project. Brand/Type stay as free tags *within* a project.

Date: 2026-10-17. Status: proposal, nothing implemented.

---

## 1. What the investigation found

### 1.1 One root table

`scenarios` is the single root of the domain. Every other table reaches a project only through
`scenario_id`:

| Reaches a scenario via | Tables |
|---|---|
| FK `scenario_id` (CASCADE) | `scenario_steps`, `runs`, `schedules` (first id), `agent_prompts` |
| soft `scenario_id`, no FK | `artifacts`, `comparisons`, `recordings` |
| JSON array `scenario_ids_json`, no FK | `schedules` (chain), `ask_threads`, `push_subscriptions`, `email_recipients` |
| **no link at all** | `preflights` (reverse: `scenarios.preflight_id`), `ask_presets`, `app_settings` |
| not in SQLite | auth profiles (`~/.agent-browser/auth/<name>.json`), session states (`~/.agent-browser/sessions/<name>.json`) |

Consequence: **adding `project_id` to `scenarios` scopes ~80 % of the app for free** — runs,
screenshots, timelines, diffs, recordings, texts, agent prompts all join to `scenarios` already
(`runs/store.ts` even joins `brand`/`type` in at query time). The rest needs a decision each
(§3).

### 1.2 Where lists are produced

- Server: `GET /api/scenarios` (unfiltered), `/api/scenarios/cards`, `/api/runs` (+ `/daily`,
  `/count`), `/api/schedules`, `/api/preflights`, `/api/comparisons`, `/api/recordings`,
  `/api/ask/scenarios`, `/api/ask/threads`. Only `/api/runs` filters server-side today
  (`brand`/`type`/`status` → `RunFilter` in `runs/store.ts:52,140-156`); everything else
  filters client-side.
- Web: no global provider besides the `authed` flag in `App.tsx`; no header/base-URL seam in
  `lib/api.ts` (every path is a literal), but **every call passes through
  `lib/request.ts:98-110`** — one chokepoint.
- Pages re-fetch through `useResource(fetcher, { deps })` (`lib/resource.ts`).

### 1.3 Things with no request context

- Cron scheduler (`scheduler/index.ts:79-85`) — reads `schedules WHERE enabled = 1`.
- Email digest (`email.ts:434`, `:310`) — all runs in a window.
- Run-finished notifications, boot-time run reaper, detached AI agent jobs.

These never need a *filter*; at most they need the project for *labelling* (a digest grouped per
project).

### 1.4 Constraints to respect

1. `preflights.name` is **globally unique among active rows** and is also a file name
   (`~/.agent-browser/sessions/<name>.json`). It cannot become unique-per-project without
   renaming files.
2. Four JSON id lists (`schedules`, `ask_threads`, `push_subscriptions`, `email_recipients`)
   can span any scenarios → can cross projects.
3. On-disk paths carry only run id / scenario id / artifact id — no grouping segment. Nothing
   to move on disk.
4. Migrations are forward-only, filename-sorted SQL files in `migrations/`; newest is `032`.
   Two tests build a DB from them (`app.test.ts`, `runs/store.test.ts`); `store.test.ts:31`
   inserts a scenario by hand (no `project_id`) — a `NOT NULL` column needs a `DEFAULT`.
5. Auth is a single shared passphrase; a project is **not** a permission boundary, only a view.

---

## 2. Design

### 2.1 Model

```
projects
  id          INTEGER PRIMARY KEY AUTOINCREMENT
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE
  color       TEXT                       -- optional accent for the switcher chip
  position    INTEGER NOT NULL DEFAULT 0 -- switcher order
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP

scenarios.project_id   INTEGER NOT NULL DEFAULT 1 REFERENCES projects(id)   -- RESTRICT delete
preflights.project_id  INTEGER NULL REFERENCES projects(id) ON DELETE SET NULL -- NULL = shared
ask_threads.project_id INTEGER NOT NULL DEFAULT 1 REFERENCES projects(id)
schedules.project_id   INTEGER NOT NULL DEFAULT 1 REFERENCES projects(id)   -- denormalised from its scenarios
```

Project **1 = "Default"** is created by the migration and every existing row lands in it, so
the app behaves exactly as today until someone creates a second project.

Why a column on `schedules` rather than deriving it: the scheduler and the Schedules page list
schedules without touching scenarios, and the invariant "a chain stays inside one project" is
cheap to enforce on save (`assertScenariosExist` already loads the ids).

Why preflights are *nullable*: a cookie-consent preflight is typically shared by every brand;
forcing it into one project would make it invisible elsewhere. `NULL` = visible in all projects;
set = only there. Name stays globally unique (constraint 1).

### 2.2 Scoping mechanism: one header, one decorator, one remount

**Web → server:** `lib/request.ts` adds `X-Project-Id: <id>` to every request (the only place
headers are set today). The active id lives in a `ProjectProvider` React context, persisted in
`localStorage['eab.project']`.

**Server:** an `onRequest` decorator (next to the auth gate in `app.ts:79-86`) parses the header
into `req.projectId: number | null`. Null = "all projects" — keeps `curl`, scripts and old
clients working, and is what the admin Storage page wants.

**List endpoints** add `AND scenarios.project_id = ?` when `req.projectId` is set. **By-id
endpoints stay unscoped** (`/api/scenarios/:id`, `/api/runs/:id`, …): a deep link into another
project still opens; the web shows a one-line banner "belongs to project *X* — switch?".

**Create endpoints** take `project_id` from the body, falling back to `req.projectId`, then 1.

**Web pages need no per-page work:** `App.tsx` wraps `<Routes>` in `<div key={projectId}>`.
Switching project remounts every page, which re-runs every `useResource` fetch with the new
header. Pages that keep state in the URL (`/runs?scenario=12`) simply reload with it.

### 2.3 The switcher

A slim **top bar** above `<main>` (new element; today `<nav>` and `<main>` are siblings with no
shared header), present on every page including mobile:

```
┌──────────────────────────────────────────────────────────────┐
│ ▣ Essent ▾         3 scenarios · last run 2 h ago     [⚙]    │
└──────────────────────────────────────────────────────────────┘
```

- Dropdown lists projects in `position` order with their colour chip and scenario count; an
  "All projects" entry at the bottom (sets the id to null — useful on Runs/Screenshots for a
  cross-brand overview, and the only way to see an orphaned scenario).
- `⚙` → `/admin/projects`.
- Keyboard: `Ctrl/⌘ + P` opens it (checked against existing shortcuts: none use it).

### 2.4 What is project-scoped vs. global

| Area | Decision |
|---|---|
| Scenarios, steps, runs, screenshots, timelines, texts, diffs, recordings, agent prompts | **Scoped** via `scenarios.project_id` (join). |
| Schedules | **Scoped** (`schedules.project_id`); a chain may only contain scenarios of its project (validated in `POST/PUT /api/schedules`). |
| Preflights | **Scoped or shared** (`project_id` nullable). The preflight picker in the scenario editor shows the project's own + shared ones. |
| Ask threads | **Scoped** at creation (`project_id` = active project); the scenario picker inside a thread is filtered. |
| Ask presets | Global. |
| Notifications (push subscriptions, email recipients) | **Global** rows — an address is an address — but the scenario checklists in `/notifications` show the active project's scenarios, and the saved id lists keep whatever was ticked in other projects (the page already merges by id). Digest emails group runs by project (label only). |
| Auth profiles, session states | Global (owned by the `agent-browser` binary, name-keyed). Shown unfiltered under Preflights/Admin. |
| Devices, theme, AI settings, browser backend, env, storage | Global admin settings. |
| Home dashboard cards | Scoped (`/api/scenarios/cards`). |
| Brand / Type tags | Unchanged: free tags *inside* a project. The tag chips naturally show only the active project's values because the rows are already filtered. |

### 2.5 Managing projects — `/admin/projects`

- Create / rename / recolour / reorder.
- Delete: only when it holds no scenarios, schedules or threads (`RESTRICT`); the page offers
  "move everything to … first".
- **Bulk move**: "move all scenarios with brand = *Essent* to project *Essent*" — the realistic
  way to split the current 52 scenarios into projects in one go. Moving a scenario carries its
  runs/recordings/diffs along automatically (they hang off its id) and re-points its schedules
  (a schedule whose chain would then cross projects is flagged, not silently split).
- Scenario editor gets a *Project* field (a move) next to Brand/Type.

### 2.6 Export / import

`PortableScenario` gains `project: string | null` (by **name**, like `preflight_name`). Import
resolves the name, creates the project if missing, or falls back to the active project when
absent. Bundle version stays 1 (the field is optional). Zip export prefixes folders with the
project name when more than one project is in the selection.

---

## 3. Impact inventory

### Database — 1 migration (`033_projects.sql`)

- `CREATE TABLE projects`; `INSERT (id 1, 'Default')`.
- `ALTER TABLE scenarios ADD COLUMN project_id … DEFAULT 1` + `CREATE INDEX idx_scenarios_project`.
- Same for `ask_threads`, `schedules` (backfilled from `scenario_id`'s project — all 1 now).
- `ALTER TABLE preflights ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`.
- No data moves on disk. Reversible by ignoring the column.

### Server — ~12 files

| File | Change |
|---|---|
| `app.ts` | `req.projectId` decorator; register `projectsRoutes`. |
| new `routes/projects.ts` | CRUD + `POST /api/projects/:id/move-scenarios { brand?, type?, scenarioIds? }`. |
| `routes/scenarios.ts` | filter in `GET /`, `/cards`; `project_id` in create/copy/update column lists (3 places the survey flagged); return it in rows. |
| `runs/store.ts` | `RunFilter.projectId` → `scenarios.project_id = ?` in `filterSql`; `listLatestPerDay(projectId?)`, `count`. |
| `routes/runs.ts` | pass `req.projectId` into the filter for `/api/runs`, `/daily`, `/count`, `/paused`. |
| `routes/schedules.ts` | filter list; validate chain ⊂ project; set `project_id`. |
| `routes/preflights.ts` | list: `project_id IS NULL OR project_id = ?`; field on create/update. |
| `routes/diffs.ts`, `routes/recordings.ts` | join `scenarios` for the list filter (both have soft `scenario_id`). |
| `routes/ask.ts` | threads + `/ask/scenarios` filtered; `project_id` on thread create. |
| `routes/screenshotsZip.ts` | project folder prefix (cosmetic). |
| `email.ts` | digest grouped by project (cosmetic, phase 4). |
| `scheduler/index.ts` | **no change** (runs schedules regardless of project). |

`packages/shared/src/rows.ts`: `Project` row type; `project_id` on `Scenario`, `Schedule`,
`Preflight`, `AskThread`.

### Web — ~8 files touched, 3 new

| File | Change |
|---|---|
| new `lib/project.tsx` | `ProjectProvider`, `useProject()`, `localStorage` persistence, `X-Project-Id` getter. |
| `lib/request.ts` | add the header (one line). |
| `App.tsx` | provider; top bar with `ProjectSwitcher`; `key={projectId}` on the routes wrapper; "belongs to another project" banner helper. |
| new `lib/ProjectSwitcher.tsx` | the dropdown. |
| new `pages/AdminProjects.tsx` | management page; link on `Admin.tsx`. |
| `pages/ScenarioEditor.tsx` | *Project* field (move). |
| `pages/Schedules.tsx` | scenario picker already project-filtered by the API; show validation error text. |
| `lib/scenarioIO.ts` | `project` field in the 4 places (interface, `toPortable`, `validate`, `import`). |
| `styles.css` | top bar + switcher + project chip. |

Everything else (Runs, Screenshots, Diffs, Recordings, Home, Timeline, Canvas, Notifications
lists) works unchanged because of the header + remount.

### Tests

- `app.test.ts`: create scenario in project 2 → listed with header 2, not with header 1, listed
  without header.
- `runs/store.test.ts`: `RunFilter.projectId`.
- new `routes/projects.test.ts` (inject): CRUD, delete-refused-when-not-empty, bulk move,
  schedule chain validation.
- web: `project.test.ts` for the persistence/header helper.

---

## 4. Phases (each shippable on its own)

| # | Scope | Effort | Visible result |
|---|---|---|---|
| 1 | Migration + `Project` row types + `projects` CRUD routes + `req.projectId` decorator | ½ day | Nothing visible; app identical ("Default" holds everything). |
| 2 | Scope the list endpoints (scenarios, cards, runs×4, schedules, preflights, diffs, recordings, ask); create endpoints default to the header; schedule chain validation | 1 day | Still invisible without a client header; testable with `curl -H 'X-Project-Id: 2'`. |
| 3 | Web: provider, header, top-bar switcher, remount, admin page with bulk move, editor field | 1 day | **The feature.** Split scenarios by brand in one click, switch at the top of every page. |
| 4 | Polish: export/import field, zip prefix, digest grouping, deep-link banner, `⌘P` | ½ day | Round-trips and niceties. |

≈ 3 days. Phases 1–2 can land on `main` at any time with zero user-visible change, which makes
the risky part (schema) separable from the UI work.

---

## 5. Decisions needed before phase 1

1. **Preflights: shared-or-scoped (nullable) as proposed, or always scoped?** Proposal: nullable.
2. **"All projects" entry in the switcher** — yes (proposal) or force a project always?
3. **Project as a permission boundary later?** Not now (single passphrase). The design keeps the
   door open: a future per-user allowed-project list would sit in the same decorator.
4. **Colour per project** — cosmetic; proposal yes, reusing the theme accent when unset.
5. **Initial split**: create projects from the existing distinct `brand` values automatically in
   the migration? Proposal: **no** — keep the migration dumb (everything in "Default") and do
   the split with the bulk-move tool, so the operator sees what moves where.

---

## 6. Rejected alternatives

- **Project in the URL** (`/p/essent/runs`): every `<Link>`/`navigate` in ~30 pages changes;
  the header + remount approach touches none of them. URLs stay stable across a rename.
- **Project as a tag like brand/type** (client-side filter only): doesn't scope preflights,
  schedules or Ask, duplicates the two existing tag-filter implementations a third time, and
  gives no server-side guarantee for schedules.
- **Separate SQLite file per project**: clean isolation, but one scheduler/queue, one
  agent-browser daemon and one set of global settings would have to fan out over N databases;
  far more than the use case (separating topics) needs.
- **Cookie instead of header for the active project**: works, but hides the scope from `curl`
  and makes "All projects" awkward; a header is explicit per request.

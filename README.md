# energie-agent-browser

React + SQLite webapp that drives the Vercel Labs `agent-browser` CLI against a remote
browserless instance to take mobile/desktop screenshots, run pre-screenshot interaction
scenarios, expose the accessibility-tree snapshot with refs, and re-execute scenarios
on-demand or on a weekly cron.

## Stack

- **Frontend** — Vite + React SPA (`apps/web`), xterm.js terminal
- **Backend** — Fastify + better-sqlite3 + node-pty + node-cron (`apps/server`)
- **Shared** — Zod schemas, step types (`packages/shared`)

## Getting started

```sh
cp .env.example .env
# BROWSER_MODE=local (the default in every deployment config) runs agent-browser's
# own installed browser: `npx agent-browser install --with-deps` once.
# BROWSER_MODE=browserless connects to a remote instance and needs BROWSERLESS_URL/TOKEN.

npm install
npm run migrate
npm run dev
```

- Web app:  http://localhost:5173
- API:      http://localhost:3011

## Bootstrapping a browser session

The first time you load the editor or terminal, no agent-browser daemon is running.
You bootstrap a named session via the **Terminal** tab in the UI (the
**Bootstrap default session** button sends the right line for the configured mode):

```
# BROWSER_MODE=local — opening a page is what launches the local browser
agent-browser --session editor open about:blank
# BROWSER_MODE=browserless — the terminal shell exports BROWSERLESS_CDP_URL
agent-browser --session editor connect "%BROWSERLESS_CDP_URL%"
```

Replace `editor` with `default`, `myscenario`, etc. for separate isolated sessions.
After ~5 seconds the session is alive and you can:

- Take snapshots from the editor
- Start the live preview (one stream at a time, polls jpeg at ~1.5s)
- Run scenarios end-to-end
- Schedule scenarios via cron

On Windows, daemons bootstrapped from the Fastify server process itself
occasionally fail the outbound wss handshake with OS error 10060. Using the
terminal to bootstrap reliably works around this.

## Layout

```
/apps/server          Fastify + node-pty + node-cron + better-sqlite3
/apps/web             Vite + React + xterm.js
/packages/shared      Zod schemas, step types, API DTOs
/migrations           001_init.sql
/data                 sqlite.db, screenshots/<run_id>/*.png, agent-browser-logs/
```

## Stealth (Cloudflare / WAF evasion)

Stealth is on by default (`STEALTH_ENABLED=true`). It patches the most common
bot-detection vectors at two layers:

- **Browser launch** (folded into the `?launch=<base64>` param on the wss URL):
  removes `--enable-automation`, sets `--disable-blink-features=AutomationControlled`
  and a few other flags, sets a Win10 Chrome UA. See `STEALTH_LAUNCH_ARGS`,
  `STEALTH_IGNORE_DEFAULT_ARGS`, `STEALTH_USER_AGENT` in `.env.example`.
- **Page init** (`apps/server/stealth/init.js`, attached via
  `AGENT_BROWSER_INIT_SCRIPTS`): patches `navigator.webdriver`,
  `navigator.plugins`, `navigator.languages`, `navigator.permissions.query`,
  `window.chrome.runtime`, WebGL `UNMASKED_VENDOR`, and a few other tells.
  Adapted from public puppeteer-extra-stealth bits.

Verified locally:

```
navigator.webdriver        → undefined
navigator.plugins.length   → 5
navigator.languages        → ["en-US","en"]
window.chrome.runtime      → object
```

Stealth covers JS/browser fingerprinting. It does **not** address TLS
fingerprinting (JA3/JA4) or IP reputation — for Cloudflare's harder challenges
you'll also need a residential proxy on the browserless side.

To disable: `STEALTH_ENABLED=false` in `.env`.

## Endpoints

- `GET/POST/PUT/DELETE /api/scenarios[/:id]`
- `GET/POST/PUT/DELETE /api/scenarios/:id/steps[/:stepId]`
- `POST /api/scenarios/:id/run` → run async, returns run row
- `GET /api/runs[/:id]`
- `GET /api/runs/:id/screenshots/:name` → PNG stream
- `GET/POST/PUT/DELETE /api/schedules[/:id]`
- `POST /api/snapshot` `{ url?, session? }` → parsed a11y tree
- `WS /ws/terminal` → xterm pty
- `WS /ws/screencast?session=<name>` → ~1.5s jpeg frames

# MCP server

The app is an **MCP server**: an AI client such as Claude Code, Claude Desktop or Cursor can connect to it and create Scenarios, add Steps, run them, read the results and compare Runs — by talking to it in plain language. The endpoint is `/api/mcp` on the same host and port as the web UI, authenticated with a **bearer token**.

> **Nothing in the app changes when you use it.** Every tool calls the same API routes the web UI uses, with the same validation; a Scenario built over MCP is an ordinary Scenario you can open, edit, play and schedule in the UI.

## Set up

1. **Choose a token** — any long random string, e.g. `openssl rand -hex 32`.
2. **Set it on the server** as `EAB_API_TOKEN` (in `.env` locally; in the host's environment variables in production) and **restart the server**. An empty or missing token keeps the endpoint closed: without it `/api/mcp` only answers to the browser's login cookie, which MCP clients don't have.
3. **Point your client at it** — URL `http(s)://<host>:<port>/api/mcp`, header `Authorization: Bearer <token>`. The local dev server is `http://localhost:3011/api/mcp` (the Vite port 5173 also proxies `/api`).

### Claude Code

```bash
claude mcp add --transport http energie-agent http://localhost:3011/api/mcp --header "Authorization: Bearer <token>"
```

Keep it on one line in PowerShell: the `\` line continuation you see in bash examples is not PowerShell syntax (it fails with *Missing expression after unary operator '--'*). The command only stores the config; the API server has to be running when a tool is called. Check with `claude mcp list`.

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "energie-agent": {
      "type": "http",
      "url": "http://localhost:3011/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "energie-agent": {
      "url": "http://localhost:3011/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Clients that only speak stdio

Bridge with `mcp-remote`, which turns the HTTP endpoint into a local stdio server:

```json
{
  "mcpServers": {
    "energie-agent": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3011/api/mcp", "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

### Check it works

bash / Git Bash:

```bash
curl -s http://localhost:3011/api/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

PowerShell, where `curl` is an alias for `Invoke-WebRequest` and a trailing backslash does not continue a line:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3011/api/mcp `
  -Headers @{ Authorization = "Bearer <token>"; Accept = "application/json, text/event-stream" } `
  -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' |
  ConvertTo-Json -Depth 5
```

A JSON list of tools means you're in. `401` means the token didn't match (or isn't set on the server); an HTML page means you hit the SPA on the wrong port.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Projects, for `project_id` on the other tools |
| `list_scenarios` | Scenarios (id, url, viewport, preflight), with an optional name filter |
| `get_scenario` | One Scenario with its ordered Steps and their step ids |
| `create_scenario` | Name + start URL, optionally a Preflight (by name or id), viewport, tags, recording, and the initial Steps |
| `update_scenario` | Change settings: name, url, viewport, preflight (name, id or `null`), mode, tags, recording, backend, retries, notes |
| `add_steps` | Append Steps, or insert at an index |
| `update_step` | Replace one Step in place |
| `remove_step` | Delete one Step (Runs untouched) |
| `reorder_steps` | Set the full Step order |
| `list_preflights` | Preflights with their Steps and the Scenarios using them |
| `create_preflight` | A new login / cookie-consent sequence |
| `update_preflight` | Rename, describe or replace its Steps |
| `list_auth_profiles` | Saved logins — name, username, url, selector overrides; never the password |
| `run_scenario` | Start a Run; returns the run id at once |
| `wait_for_run` | Block until the Run finishes (up to 10 min), then return it |
| `get_run` | Status, screenshot and text filenames, log tail |
| `list_runs` | Recent Runs of one Scenario or all |
| `get_screenshot` | One screenshot as an image, downscaled to view (max 1000 px wide, top 3000 px) |
| `compare_runs` | Pixel-diff two Runs; mismatch ratio per screenshot |
| `resume_run` | Continue a Run parked on a `pause` Step |
| `snapshot_page` | Open a URL in the shared browser and return its accessibility tree — the roles and names selectors are written against |
| `list_schedules` / `create_schedule` | Cron schedules |

The browser only opens pages that Steps navigate to — the Scenario's url is a label, not an automatic first action. `create_scenario` and `add_steps` therefore insert a `navigate` to the url as Step 1 when a Scenario gets its first Steps and none of them navigates first (the response says so in `note`). Start your own list with a `navigate` to control it.

Every Step kind the editor offers is available: `navigate`, `click`, `fill`, `type`, `select`, `check`, `uncheck`, `press`, `scroll` (by pixels, to bottom, to top, or element into view), `wait` (ms or until a selector resolves), `screenshot` (full page or viewport, mobile device, zoom, format), `record_start` / `record_stop`, `save_text`, `evaluate`, `pause`, `close`. Selectors are the same `{role, name}` pairs as in the [Step editor](/docs/scenarios), with `ordinal`, `locator` and `find` for the hard cases. The tool descriptions carry this guide, so the client knows the vocabulary without reading these docs.

**Deliberately missing:** deleting Scenarios, Runs or Preflights. MCP has no confirmation step and those deletes take screenshot directories with them — do that in the UI.

## Example

> Create a scenario "helloworld" on https://helloworld.com using the preflight "helloworld-cookie": scroll to the bottom and back to the top, start a recording, take a full-page screenshot and a viewport screenshot, click the "Hello" button, stop the recording. Then run it and tell me whether it differs from last night's run.

The client will typically call `list_preflights` (to resolve the name), `create_scenario` with the Steps, `run_scenario`, `wait_for_run`, `list_runs` (to find last night's), `compare_runs`, and perhaps `get_screenshot` to look at a diff — and come back with an answer. If a selector is uncertain it can call `snapshot_page` first to read the real button names.

## How it works

- **In-process.** A tool call becomes a request to the app's own API through Fastify's `inject()`: no second server, no duplicated logic, the same 400 with the same field name when a Step is malformed.
- **Stateless.** Each MCP request gets a fresh server and transport (Streamable HTTP, plain JSON responses). There is no session to expire; `GET`/`DELETE` on the endpoint answer `405`.
- **Same gate.** The bearer token is checked by the same login gate as the cookie (`auth.ts`), so it also works for scripts against any `/api/*` route. The web UI never uses it.
- **Project scope.** Tools take an optional `project_id`; without it, lists cover every project and new Scenarios land in the default project — the same as the UI's "All projects".

## Gotchas

- **Restart after setting the token** — environment is read once at server start. Keep a single `EAB_API_TOKEN` line in `.env`: with two, dotenv silently uses the last one, and the client sending the other gets `401 {"error":"unauthenticated"}`.
- **Runs are asynchronous** — `run_scenario` returns in milliseconds; the Run may wait behind scheduled Runs on the same browser. Use `wait_for_run` (default 3 min, max 10) rather than polling `get_run` in a loop.
- **The browser is shared** — `snapshot_page` drives the same `default` session Scenario Runs and the Preflight recorder use. Don't snapshot while a Run is live.
- **Screenshots are downscaled** for the client's eyes (JPEG, ≤1000 px wide, cropped to the top 3000 px). The originals on disk are untouched; raise `max_width` / `max_height` when needed.
- **`pause` Steps** park a Run until someone clicks Resume — `wait_for_run` reports `paused: true`, and `resume_run` continues it.
- **Preflights hold their own Steps** — `add_steps` is for Scenarios; change a Preflight with `update_preflight` (it replaces the whole list).

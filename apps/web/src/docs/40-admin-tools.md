# Admin tools

Everything under **/admin** is operational tooling — things you need occasionally, kept out of the main navigation.

## The tools

| Tool | Use it to |
| --- | --- |
| **Terminal** | Bootstrap the agent-browser session and run CLI commands directly |
| **Raw scenario steps** | Hand-edit step rows: position, kind, raw `payload_json`. No validation beyond well-formed JSON — edit with care |
| **Export / import scenarios** | Move scenarios between instances (e.g. dev → prod) as a portable bundle |
| **Export / import preflights** | Same for preflights (name, description, steps, retry policy). Import these first — scenario import links preflights by name. The saved browser state is not exported; Replay on the target to rebuild it |
| **Network inspector** | Terminal + helpers to inspect the live session's network traffic |
| **Session state files** | List/delete persisted `--session-name` cookie/state files |
| **Storage** | Database + screenshot/recording disk usage; delete runs or recordings to free space |
| **Environment variables** | View and edit the server's `.env` from the browser |
| **AI scenario builder** | Pick which model the ✨ AI task agent uses (takes effect immediately) |

## Environment variables page

Edits the `.env` file at the repo root. Secret-looking values (tokens, keys, passwords) are masked until revealed. On every save the previous content is backed up to `.env.bak`, and comments/ordering are preserved.

> **Most values are read once at server start** — restart the server after saving for changes to take effect. (The AI model override is the exception: it lives in the database and applies to the next task.)

## Troubleshooting quick hits

- **Screenshot fails with "0 width"** — the page was mid-navigation; the runner already waits and retries a few times, but a `wait` step before the screenshot helps on slow pages.
- **Run blocked by Cloudflare/WAF** — stealth options (`STEALTH_*` env vars) control the launch args and user agent; recordings deliberately tap the existing stealthed page for this reason.
- **Disk filling up** — check **Admin → Storage**; lossy [screenshot formats](/docs/scenarios) reduce future growth.

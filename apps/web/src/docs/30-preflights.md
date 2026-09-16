# Preflights

A preflight records a **one-time browser flow** — typically a login or a cookie-consent click-through — whose resulting state (cookies, localStorage) is reused by scenarios, so every scheduled run starts from a ready session instead of hitting the consent wall.

## How it works

1. On **Preflights**, create a preflight with a name. Taking the first action binds the `default` browser to that preflight's `--session-name` and loads any saved state.
2. Add a `navigate` step, snapshot the page, and pick nodes to `click` / `type` — each action **runs live** while you build, so cookies accumulate as you go.
3. Attach the preflight to a scenario in the scenario editor. Per scenario you choose how it's applied: re-run the preflight's steps in a clean browser, or reuse the saved session state.

## Auth profiles

Credentials don't belong in step payloads. Store them as an **auth profile** (encrypted at rest under `~/.agent-browser/auth/`, AES-GCM) and reference the profile from a preflight with the `auth-login` step. The profile holds the login URL, username/password, and the field selectors.

## Session state

Preflight state lives in agent-browser's per-`--session-name` files. When a flow goes stale (expired login, changed consent banner), just open the preflight and run it again — or clear its file under **Admin → Session state files** and rebuild from scratch.

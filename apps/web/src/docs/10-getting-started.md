# Getting started

Energie Agent Browser automates browser flows on energy-supplier websites: you build **scenarios** (a sequence of browser steps), run them on demand or on a **schedule**, and collect **screenshots**, **recordings**, and visual **diffs** of the results. Under the hood every action is executed by [agent-browser](https://github.com/vercel-labs/agent-browser) driving a real Chromium.

## The 5-minute tour

| Page | What it's for |
| --- | --- |
| **Scenarios** | Build and edit step sequences; run them; enable video recording |
| **Preflights** | Record one-time login / cookie-consent flows that scenarios reuse |
| **Schedules** | Run scenarios automatically (cron-style) |
| **Runs** | Every execution with status, log, and its captured screenshots |
| **Screenshots** | Browse captures per scenario, download zips, open the timeline |
| **Recordings** | Watch the `.webm` videos of recorded runs |
| **Diffs** | Pixel-compare screenshots between two runs |
| **Admin** | Operational tools — raw step editor, storage, env vars, and more |

## Your first scenario

1. Go to **Scenarios** → create a scenario with a name and start URL.
2. In the editor, take a **snapshot** of the page — click any node in the accessibility tree to add a `click` / `type` step targeting it.
3. Add a `screenshot` step (and pick a [file format](/docs/scenarios) to keep files small).
4. Press **Play** to run it, then check the run on the **Runs** page.

Prefer describing over clicking? The **✨ AI task** button lets you type what the browser should do; the agent performs it live and each action becomes a step.

## Sessions

The editor drives a live browser bound to a `--session-name`. Cookies and localStorage persist in that session's state file — that's what [preflights](/docs/preflights) build on. Session state files can be inspected and deleted under **Admin → Session state files**.

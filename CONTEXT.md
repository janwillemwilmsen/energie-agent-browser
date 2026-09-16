# energie-agent-browser

Drives a real Chrome browser through scripted interaction sequences on target websites, captures screenshots, and compares them across runs.

## Language

**Scenario**:
A target URL plus an ordered list of Steps, run on demand or on a Schedule.
_Avoid_: test, flow, script

**Step**:
One instruction in a Scenario or Preflight: navigate, click, type, fill, select, check, uncheck, scroll, wait, evaluate, screenshot, record start/stop, close, or auth-login. Every Step has a kind and a payload.
_Avoid_: action, command, instruction

**Selector**:
How a Step names its target element: either a raw locator handed to the browser as-is, or a role plus name resolved against the page's accessibility tree.
_Avoid_: target, element ref

**Preflight**:
A named, reusable Step sequence that establishes browser state (a login, a cookie consent) before a Scenario's own Steps run.
_Avoid_: setup, login flow, fixture

**Auth Profile**:
A named set of login credentials held in the browser tool's encrypted vault, referenced by an auth-login Step.
_Avoid_: account, credentials, login

**Run**:
One execution of a Scenario, with its log, status, and the Screenshots it produced.
_Avoid_: job, execution, test run

**Screenshot**:
An image captured by a screenshot Step during a Run, identified by its position in the Scenario so it pairs with the same slot in other Runs.
_Avoid_: capture, image, artifact

**Diff**:
A pixel comparison of the same Screenshot slot across two Runs.
_Avoid_: comparison, visual regression

**Schedule**:
A cron expression that triggers Runs of one or more Scenarios.
_Avoid_: cron, job, timer

**Browser**:
The seam through which Steps act on a page: run a command, take an accessibility snapshot, close the session. Satisfied by the real browser tool in production and by a fake in tests.
_Avoid_: driver, CLI, daemon, agent-browser (when meaning the seam)

**Session**:
One live browser connection, named, that Steps act on. Preflight state persists across the Sessions that reuse its name.
_Avoid_: daemon, connection, tab

**Step executor**:
The single place that carries out a Step against a Browser, including selector resolution with implicit wait, fallbacks, and per-Step retries. Scenario runs, Preflight replay, the Preflight recorder, and the AI scenario agent all go through it.
_Avoid_: runner (that is the Scenario-level orchestration), executor (ambiguous)

**Step editor**:
The single place Steps are added, picked from a snapshot, edited, reordered and removed, used by the Scenario editor and the Preflight page. Persistence sits behind its Step store seam: one adapter writes each Scenario Step through the server, the other keeps a Preflight's Steps in a draft saved with the Preflight.
_Avoid_: step list, step form

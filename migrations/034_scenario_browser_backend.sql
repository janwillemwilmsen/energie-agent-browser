-- Per-scenario browser override: which backend (local / cdp / browserless-cloud /
-- browserbase / kernel, see the server's agentBrowser/backend.ts) a run of this
-- scenario drives, instead of the active one on Admin → Browser. NULL = the
-- admin default, so nothing changes for existing scenarios. The kinds are
-- validated by the API (shared BrowserBackendKind), not by a CHECK, so adding
-- a backend later needs no migration.
ALTER TABLE scenarios ADD COLUMN browser_backend TEXT;

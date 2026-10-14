import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DeviceProfile } from '@eab/shared';
import { api } from '../lib/api.js';
import { useResource } from '../lib/resource.js';

// Devices a screenshot step may emulate. The list is Playwright's
// deviceDescriptorsSource.json (vendored, or a newer version pasted here);
// the ticked names are what the screenshot step's device dropdown offers.

const PLAYWRIGHT_URL = 'https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json';

// Group by the leading word so the list reads as iPhone / iPad / Pixel / …
function groupOf(name: string): string {
  const m = /^(iPhone|iPad|Pixel|Galaxy|Nexus|Moto|Nokia|LG|Kindle|Blackberry|Microsoft|Desktop)/i.exec(name);
  return m ? m[1]! : 'Other';
}

export function AdminDevices() {
  const { data, error, setError, refresh } = useResource(() => api.getDevices(), {
    initial: { devices: [] as DeviceProfile[], enabled: [] as string[], customSource: false },
  });
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [savedEnabled, setSavedEnabled] = useState<Set<string>>(new Set());
  useEffect(() => {
    setEnabled(new Set(data.enabled));
    setSavedEnabled(new Set(data.enabled));
  }, [data.enabled]);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // The editable source: fetched when the toggle is opened (it is large).
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [sourceSaving, setSourceSaving] = useState(false);
  useEffect(() => {
    if (!sourceOpen || source != null) return;
    api.getDeviceSource().then((r) => setSource(r.source)).catch((e) => setError(e.message));
  }, [sourceOpen, source, setError]);

  const dirty = useMemo(() => {
    if (enabled.size !== savedEnabled.size) return true;
    for (const n of enabled) if (!savedEnabled.has(n)) return true;
    return false;
  }, [enabled, savedEnabled]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, DeviceProfile[]>();
    for (const d of data.devices) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      const g = groupOf(d.name);
      (map.get(g) ?? map.set(g, []).get(g)!).push(d);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [data.devices, filter]);

  function toggle(name: string, on: boolean) {
    setEnabled((cur) => {
      const next = new Set(cur);
      if (on) next.add(name); else next.delete(name);
      return next;
    });
  }

  async function saveEnabled() {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.updateDevices({ enabled: Array.from(enabled) });
      setSavedEnabled(new Set(r.enabled));
      setEnabled(new Set(r.enabled));
      setNote(`Saved — ${r.enabled.length} device${r.enabled.length === 1 ? '' : 's'} in the screenshot dropdown.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveSource() {
    if (source == null) return;
    setSourceSaving(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.updateDevices({ source });
      setNote(`Source saved — ${r.devices.length} devices${r.customSource ? '' : ' (vendored list restored)'}.`);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSourceSaving(false);
    }
  }

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">Admin</Link> / Devices</p>
      <h1>Devices</h1>
      <p className="muted">
        The devices a screenshot step can emulate. Tick the ones to offer in the step's device dropdown and
        save. The list is Playwright's{' '}
        <a className="link" href={PLAYWRIGHT_URL} target="_blank" rel="noreferrer">deviceDescriptorsSource.json</a>
        {' '}({data.devices.length} devices{data.customSource ? ', pasted version' : ', vendored copy'}) — paste a newer
        version under “Edit source” to update it.
      </p>
      <p className="muted">
        How emulation works: agent-browser applies the user agent of the built-in device of the same family (iPhone 14
        for iOS, Pixel 7 for Android) and the device's own viewport and scale. Neither built-in nor listed devices
        emulate touch or a coarse pointer — a page that branches on those renders its desktop variant.
      </p>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}

      <details className="card devices-help">
        <summary><h3>Screen vs. viewport, the fold line, and fixing a device</h3></summary>
        <p>
          A phone's <strong>screen</strong> is not what a page gets. The browser's address bar and toolbar take a
          slice of it, so the <strong>viewport</strong> — the area the page is laid out in — is smaller: an iPhone 14
          has a 390×844 screen but gives a page 390×664 on first paint. Each entry in Playwright's list can carry
          both sizes, and the executor lays the page out in the entry's <code>viewport</code>.
        </p>
        <p>
          Older entries in the list (the ones marked <span className="devices-warn">viewport = full screen</span>)
          have no separate <code>screen</code>: their <code>viewport</code> is the whole screen. Captures on those
          devices are a little taller than reality, and the viewer's <strong>fold line</strong> — the line across a
          full-page screenshot where the first paint ended — sits too low for them. The viewer then also draws a
          dashed <em>estimated real fold</em> (screen minus typical browser bars: 180 px on an iPhone, 74 on an
          iPad, 76 on Android), labelled as the estimate it is.
        </p>
        <p>
          <strong>To make such a device exact</strong>, give it the modern shape under “Edit source”: keep the
          physical size as <code>screen</code> and set <code>viewport</code> to the page area. The simplest way is
          to copy the numbers from a modern entry of the same size class. For example, iPhone X as it ships:
        </p>
        <pre className="devices-example">{`"iPhone X": {
  "userAgent": "…",
  "viewport": { "width": 375, "height": 812 },
  "deviceScaleFactor": 3, "isMobile": true, "hasTouch": true, "defaultBrowserType": "webkit"
}`}</pre>
        <p>becomes</p>
        <pre className="devices-example">{`"iPhone X": {
  "userAgent": "…",
  "screen":   { "width": 375, "height": 812 },
  "viewport": { "width": 375, "height": 635 },
  "deviceScaleFactor": 3, "isMobile": true, "hasTouch": true, "defaultBrowserType": "webkit"
}`}</pre>
        <p>
          Save the source and the marker disappears, new captures use the corrected viewport, and the viewer draws a
          single, accurate fold line. The same edit works for a device that is not in the list at all: add an entry
          with a unique name, a <code>userAgent</code> (copy one from the same family — it only decides whether the
          iPhone or the Android user agent is used), <code>screen</code>, <code>viewport</code> and{' '}
          <code>deviceScaleFactor</code>, then tick it above. Landscape entries are separate devices; add one with
          the width and height swapped if you need it.
        </p>
        <p className="muted">
          Where the page-area numbers come from: measure on the device (Safari → Web Inspector, or{' '}
          <code>window.innerHeight</code> on first load), or take them from Playwright's modern entries of the same
          family. Mobile browser bars collapse on scroll, so the first-paint value is the conservative one.
        </p>
      </details>

      <div className="devices-toolbar">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter devices…"
        />
        <span className="muted">{enabled.size} selected</span>
        <button type="button" className="chip" onClick={() => setEnabled(new Set(data.devices.filter((d) => d.builtin).map((d) => d.name)))} title="Only agent-browser's own built-in devices">
          built-ins only
        </button>
        <button type="button" className="chip" onClick={() => setEnabled(new Set())}>none</button>
      </div>

      {groups.map(([group, list]) => (
        <details key={group} className="devices-group" open>
          <summary>
            <strong>{group}</strong>{' '}
            <span className="muted">{list.filter((d) => enabled.has(d.name)).length} of {list.length}</span>
          </summary>
          <ul className="devices-list">
            {list.map((d) => (
              <li key={d.name}>
                <label>
                  <input type="checkbox" checked={enabled.has(d.name)} onChange={(e) => toggle(d.name, e.target.checked)} />
                  <span className="devices-name">{d.name}</span>
                  <span className="muted devices-props">
                    {d.width}×{d.height} @{d.scale}× · {d.family}{d.mobile ? '' : ' · desktop-class'}{d.builtin ? ' · agent-browser built-in' : ''}
                    {d.fullScreenViewport && (
                      <span className="devices-warn" title="This descriptor has no separate screen size, so its viewport is the whole screen; the page area under the browser's address bar and toolbar is smaller. The fold line sits too low for it — paste a corrected viewport in the source to fix.">
                        {' '}· viewport = full screen
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      ))}

      <div className="devices-save">
        <button type="button" onClick={() => void saveEnabled()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save selection' : 'Saved'}
        </button>
        {dirty && (
          <button type="button" className="scenario-meta-cancel" onClick={() => setEnabled(new Set(savedEnabled))} disabled={saving}>
            Revert
          </button>
        )}
      </div>

      <details className="card" open={sourceOpen} onToggle={(e) => setSourceOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary><h3>Edit source</h3></summary>
        <p className="muted">
          The full device list as JSON, in Playwright's format. Paste a newer{' '}
          <a className="link" href={PLAYWRIGHT_URL} target="_blank" rel="noreferrer">deviceDescriptorsSource.json</a>
          {' '}here and save; an empty box restores the vendored copy. Devices that disappear from the list drop out of the
          dropdown; a scenario that still names one keeps working if agent-browser knows it, and fails with the name otherwise.
        </p>
        <textarea
          className="devices-source"
          value={source ?? ''}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          rows={24}
          placeholder={source == null ? 'Loading…' : ''}
          disabled={source == null}
        />
        <div className="devices-save">
          <button type="button" onClick={() => void saveSource()} disabled={source == null || sourceSaving}>
            {sourceSaving ? 'Saving…' : 'Save source'}
          </button>
        </div>
      </details>
    </section>
  );
}

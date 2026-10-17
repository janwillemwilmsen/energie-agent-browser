import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DeviceProfile, DeviceSize } from '@eab/shared';
import { api } from '../lib/api.js';
import { useResource } from '../lib/resource.js';

// Devices a screenshot step may emulate. The list is Playwright's
// deviceDescriptorsSource.json (vendored, or a newer version pasted here);
// the ticked names are what the screenshot step's device dropdown offers.
// Screen and viewport sizes are edited inline; saving writes them into the
// stored source.

const PLAYWRIGHT_URL = 'https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json';

// Group by the leading word so the list reads as iPhone / iPad / Pixel / …
function groupOf(name: string): string {
  const m = /^(iPhone|iPad|Pixel|Galaxy|Nexus|Moto|Nokia|LG|Kindle|Blackberry|Microsoft|Desktop)/i.exec(name);
  return m ? m[1]! : 'Other';
}

/** The four size fields of one row, as typed (strings, so a half-typed value survives). */
interface SizeEdit {
  sw: string;
  sh: string;
  vw: string;
  vh: string;
}

function editOf(d: DeviceProfile): SizeEdit {
  return { sw: String(d.screen.width), sh: String(d.screen.height), vw: String(d.width), vh: String(d.height) };
}

function toSize(w: string, h: string): DeviceSize | null {
  const width = Number(w);
  const height = Number(h);
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? { width, height } : null;
}

export function AdminDevices() {
  const { data, setData, error, setError } = useResource(() => api.getDevices(), {
    initial: { devices: [] as DeviceProfile[], enabled: [] as string[], customSource: false },
  });
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [savedEnabled, setSavedEnabled] = useState<Set<string>>(new Set());
  useEffect(() => {
    setEnabled(new Set(data.enabled));
    setSavedEnabled(new Set(data.enabled));
  }, [data.enabled]);
  // Size edits, by device name; only rows that were typed in.
  const [edits, setEdits] = useState<Record<string, SizeEdit>>({});
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

  const byName = useMemo(() => new Map(data.devices.map((d) => [d.name, d] as const)), [data.devices]);

  const selectionDirty = useMemo(() => {
    if (enabled.size !== savedEnabled.size) return true;
    for (const n of enabled) if (!savedEnabled.has(n)) return true;
    return false;
  }, [enabled, savedEnabled]);

  // The size patch to send: every edited row whose numbers changed. `invalid`
  // names rows that do not parse (blank, zero, a decimal) — nothing saves then.
  const { sizes, invalid } = useMemo(() => {
    const sizes: Record<string, { screen: DeviceSize; viewport: DeviceSize }> = {};
    const invalid: string[] = [];
    for (const [name, e] of Object.entries(edits)) {
      const d = byName.get(name);
      if (!d) continue;
      const screen = toSize(e.sw, e.sh);
      const viewport = toSize(e.vw, e.vh);
      if (!screen || !viewport) { invalid.push(name); continue; }
      const same = screen.width === d.screen.width && screen.height === d.screen.height
        && viewport.width === d.width && viewport.height === d.height;
      if (!same) sizes[name] = { screen, viewport };
    }
    return { sizes, invalid };
  }, [edits, byName]);
  const sizesDirty = Object.keys(sizes).length > 0;
  const dirty = selectionDirty || sizesDirty;

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

  function setField(d: DeviceProfile, field: keyof SizeEdit, value: string) {
    setEdits((cur) => ({ ...cur, [d.name]: { ...(cur[d.name] ?? editOf(d)), [field]: value } }));
  }

  function revert() {
    setEnabled(new Set(savedEnabled));
    setEdits({});
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.updateDevices({
        ...(selectionDirty ? { enabled: Array.from(enabled) } : {}),
        ...(sizesDirty ? { sizes } : {}),
      });
      setData(r);
      setEdits({});
      if (sizesDirty) setSource(null); // the source text changed; refetch when the box is open
      const n = Object.keys(sizes).length;
      setNote(
        `Saved — ${r.enabled.length} device${r.enabled.length === 1 ? '' : 's'} in the screenshot dropdown` +
        (n ? `, ${n} size${n === 1 ? '' : 's'} written to the source.` : '.'),
      );
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
      setData(r);
      setEdits({});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSourceSaving(false);
    }
  }

  const sizeInput = (d: DeviceProfile, field: keyof SizeEdit, value: string, label: string) => (
    <input
      type="number"
      className="devices-size"
      min={1}
      step={1}
      value={value}
      aria-label={`${d.name} ${label}`}
      onChange={(e) => setField(d, field, e.target.value)}
    />
  );

  const saveBar = (
    <div className="devices-save">
      <button type="button" onClick={() => void save()} disabled={!dirty || saving || invalid.length > 0}>
        {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
      </button>
      {dirty && (
        <button type="button" className="scenario-meta-cancel" onClick={revert} disabled={saving}>
          Revert
        </button>
      )}
      {invalid.length > 0 && (
        <span className="error">Sizes must be whole numbers above 0: {invalid.join(', ')}</span>
      )}
      {sizesDirty && invalid.length === 0 && (
        <span className="muted">{Object.keys(sizes).length} size change{Object.keys(sizes).length === 1 ? '' : 's'} to write into the source</span>
      )}
    </div>
  );

  return (
    <section>
      <p className="breadcrumb"><Link to="/admin">Admin</Link> / Devices</p>
      <h1>Devices</h1>
      <p className="muted">
        The devices a screenshot step can emulate. Tick the ones to offer in the step's device dropdown and
        save. The list is Playwright's{' '}
        <a className="link" href={PLAYWRIGHT_URL} target="_blank" rel="noreferrer">deviceDescriptorsSource.json</a>
        {' '}({data.devices.length} devices{data.customSource ? ', edited version' : ', vendored copy'}) — paste a newer
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
        <summary><h3>Screen vs. viewport, and fixing a device</h3></summary>
        <p>
          A phone's <strong>screen</strong> is not what a page gets. The browser's address bar and toolbar take a
          slice of it, so the <strong>viewport</strong> — the area the page is laid out in — is smaller: an iPhone 14
          has a 390×844 screen but gives a page 390×664 on first paint. The executor lays the page out in the entry's
          viewport, and the viewer's <strong>fold line</strong> marks that height on a full-page capture.
        </p>
        <p>
          Playwright's modern entries (iPhone 11–17, Pixel 5–9, Galaxy S21 and newer, …) carry both sizes. Its older
          ones (iPhone X/XR/8/SE, Pixel 2–4, Galaxy S24, older iPads, …) carry only a viewport that is really the whole
          screen, so the page is laid out too tall and the fold sits too low. Those rows show the viewport numbers in
          the screen column as well, marked <span className="devices-derived">like this</span>.
        </p>
        <p>
          <strong>To fix one</strong>, type the real page area into its viewport fields (keep the screen as the
          physical size) and save — the numbers are written into the source and the next capture uses them. The
          simplest values are those of a modern entry of the same size class, or measure on the device:{' '}
          <code>window.innerHeight</code> on first load (Safari → Web Inspector). Mobile browser bars collapse on
          scroll, so the first-paint value is the conservative one.
        </p>
        <p className="muted">
          A device that is not in the list at all is added under “Edit source”: an entry with a unique name, a{' '}
          <code>userAgent</code> copied from the same family (it only decides whether the iPhone or the Android user
          agent is used), <code>screen</code>, <code>viewport</code> and <code>deviceScaleFactor</code>. Landscape
          entries are separate devices; add one with the width and height swapped if you need it.
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
      </div>

      {groups.map(([group, list]) => (
        <details key={group} className="devices-group" open={filter.trim() !== '' || undefined}>
          <summary>
            <strong>{group}</strong>{' '}
            <span className="muted">{list.filter((d) => enabled.has(d.name)).length} of {list.length}</span>
          </summary>
          <table className="devices-table">
            <thead>
              <tr>
                <th>Device</th>
                <th title="Physical size in CSS px (Playwright's screen)">Screen</th>
                <th title="The area the page is laid out in (Playwright's viewport)">Viewport</th>
                <th>Scale</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => {
                const e = edits[d.name] ?? editOf(d);
                const changed = d.name in sizes;
                return (
                  <tr key={d.name} className={changed ? 'devices-row-changed' : undefined}>
                    <td>
                      <label className="devices-pick">
                        <input type="checkbox" checked={enabled.has(d.name)} onChange={(ev) => toggle(d.name, ev.target.checked)} />
                        <span className="devices-name">{d.name}</span>
                      </label>
                    </td>
                    <td className={d.screenFromViewport && !(d.name in edits) ? 'devices-derived' : undefined}
                      title={d.screenFromViewport ? 'The source has no screen size for this entry; these are its viewport numbers' : undefined}>
                      {sizeInput(d, 'sw', e.sw, 'screen width')}
                      <span className="devices-x">×</span>
                      {sizeInput(d, 'sh', e.sh, 'screen height')}
                    </td>
                    <td>
                      {sizeInput(d, 'vw', e.vw, 'viewport width')}
                      <span className="devices-x">×</span>
                      {sizeInput(d, 'vh', e.vh, 'viewport height')}
                    </td>
                    <td className="muted">@{d.scale}×</td>
                    <td className="muted devices-props">
                      {d.family}{d.mobile ? '' : ' · desktop-class'}{d.builtin ? ' · agent-browser built-in' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      ))}

      {saveBar}

      <details className="card" open={sourceOpen} onToggle={(e) => setSourceOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary><h3>Edit source</h3></summary>
        <p className="muted">
          The full device list as JSON, in Playwright's format. Paste a newer{' '}
          <a className="link" href={PLAYWRIGHT_URL} target="_blank" rel="noreferrer">deviceDescriptorsSource.json</a>
          {' '}here and save; an empty box restores the vendored copy. Sizes saved inline above are already in this text;
          pasting a fresh list replaces them. Devices that disappear from the list drop out of the dropdown; a scenario
          that still names one keeps working if agent-browser knows it, and fails with the name otherwise.
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

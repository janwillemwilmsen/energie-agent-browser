import { useEffect, useMemo, useState } from 'react';
import { api, type EmailRecipient, type Scenario } from '../lib/api.js';
import {
  pushSupported,
  notificationPermission,
  getExistingSubscription,
  enablePush,
  saveScenarioSelection,
  disablePush,
  sendTestNotification,
} from '../lib/push.js';

// A destination is somewhere alerts go: this browser (web push) or an email
// address (Resend). 'browser' selects the push subscription; a number selects
// the email recipient with that id.
type DestKey = 'browser' | number;

export function Notifications() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [recipients, setRecipients] = useState<EmailRecipient[]>([]);
  const [emailStatus, setEmailStatus] = useState<{ enabled: boolean; from: string } | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [browserSaved, setBrowserSaved] = useState<{ fail: number[]; success: number[] }>({
    fail: [],
    success: [],
  });

  const [selectedKey, setSelectedKey] = useState<DestKey>('browser');
  const [failSelected, setFailSelected] = useState<Set<number>>(new Set());
  const [successSelected, setSuccessSelected] = useState<Set<number>>(new Set());
  const [dailyDigest, setDailyDigest] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedBrands, setSelectedBrands] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  const supported = pushSupported();
  const permission = notificationPermission();

  const brands = useMemo(() => collectTagValues(scenarios, 'brand'), [scenarios]);
  const types = useMemo(() => collectTagValues(scenarios, 'type'), [scenarios]);

  const visibleScenarios = useMemo(() => {
    return scenarios.filter((s) => {
      const brandOk = selectedBrands.size === 0 || (s.brand != null && selectedBrands.has(s.brand));
      const typeOk = selectedTypes.size === 0 || (s.type != null && selectedTypes.has(s.type));
      return brandOk && typeOk;
    });
  }, [scenarios, selectedBrands, selectedTypes]);

  const activeFilterCount = selectedBrands.size + selectedTypes.size;

  function toggleFilter(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  useEffect(() => {
    void (async () => {
      setError(null);
      try {
        const [list, st, recs] = await Promise.all([
          api.listScenarios(),
          api.emailStatus(),
          api.listEmailRecipients(),
        ]);
        setScenarios(list);
        setEmailStatus(st);
        setRecipients(recs);
        const sub = await getExistingSubscription();
        let browser = { fail: [] as number[], success: [] as number[] };
        if (sub) {
          const status = await api.pushStatus(sub.endpoint);
          setPushSubscribed(status.subscribed);
          if (status.subscribed) {
            browser = { fail: status.scenarioIds, success: status.successScenarioIds };
          }
        }
        setBrowserSaved(browser);
        // Default destination is this browser; show its saved selection.
        setFailSelected(new Set(browser.fail));
        setSuccessSelected(new Set(browser.success));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, []);

  // Warn before reload/close while there are unticked-but-unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function applySaved(key: DestKey, recs: EmailRecipient[], browser: { fail: number[]; success: number[] }) {
    if (key === 'browser') {
      setFailSelected(new Set(browser.fail));
      setSuccessSelected(new Set(browser.success));
      setDailyDigest(false);
    } else {
      const r = recs.find((x) => x.id === key);
      setFailSelected(new Set(r?.scenarioIds ?? []));
      setSuccessSelected(new Set(r?.successScenarioIds ?? []));
      setDailyDigest(r?.dailyDigest ?? false);
    }
  }

  function trySelect(key: DestKey) {
    if (key === selectedKey) return;
    if (dirty && !confirm('Discard unsaved changes for the current destination?')) return;
    applySaved(key, recipients, browserSaved);
    setSelectedKey(key);
    setDirty(false);
    setNotice(null);
    setError(null);
  }

  function toggle(set: 'fail' | 'success', id: number) {
    const update = set === 'fail' ? setFailSelected : setSuccessSelected;
    update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
    setNotice(null);
  }

  // Toggle-all only touches the currently visible (filtered) scenarios, so a
  // brand/type filter lets you bulk-tick one group without clearing the rest.
  function toggleAll(set: 'fail' | 'success') {
    const current = set === 'fail' ? failSelected : successSelected;
    const update = set === 'fail' ? setFailSelected : setSuccessSelected;
    const allChecked =
      visibleScenarios.length > 0 && visibleScenarios.every((s) => current.has(s.id));
    const next = new Set(current);
    for (const s of visibleScenarios) {
      if (allChecked) next.delete(s.id);
      else next.add(s.id);
    }
    update(next);
    setDirty(true);
    setNotice(null);
  }

  const selectedRecipient =
    selectedKey === 'browser' ? null : recipients.find((r) => r.id === selectedKey) ?? null;

  async function onSave() {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const fail = Array.from(failSelected);
      const success = Array.from(successSelected);
      if (selectedKey === 'browser') {
        const wasSubscribed = pushSubscribed;
        if (wasSubscribed) await saveScenarioSelection(fail, success);
        else await enablePush(fail, success);
        setPushSubscribed(true);
        setBrowserSaved({ fail, success });
        setNotice(wasSubscribed ? 'Saved.' : 'Notifications enabled for this browser and selection saved.');
      } else {
        const updated = await api.updateEmailRecipient(selectedKey, {
          scenarioIds: fail,
          successScenarioIds: success,
          dailyDigest,
        });
        setRecipients((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setNotice('Saved.');
      }
      setDirty(false);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      if (selectedKey === 'browser') {
        await sendTestNotification();
        setNotice('Test push sent — you should see a notification shortly.');
      } else {
        await api.sendEmailTest(selectedKey);
        setNotice('Test email sent — check the inbox (and spam folder).');
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDisableBrowser() {
    setBusy('disable');
    setError(null);
    setNotice(null);
    try {
      await disablePush();
      setPushSubscribed(false);
      setBrowserSaved({ fail: [], success: [] });
      setFailSelected(new Set());
      setSuccessSelected(new Set());
      setDirty(false);
      setNotice('Notifications disabled for this browser.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onAddEmail(e: React.FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (dirty && !confirm('Discard unsaved changes for the current destination?')) return;
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const created = await api.addEmailRecipient(email);
      setNewEmail('');
      const nextRecipients = recipients.some((r) => r.id === created.id)
        ? recipients.map((r) => (r.id === created.id ? created : r))
        : [...recipients, created];
      setRecipients(nextRecipients);
      applySaved(created.id, nextRecipients, browserSaved);
      setSelectedKey(created.id);
      setDirty(false);
      setNotice('Address added — tick the scenarios below, then press Save.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteEmail() {
    if (!selectedRecipient) return;
    if (!confirm(`Remove ${selectedRecipient.email} from email notifications?`)) return;
    setBusy('delete');
    setError(null);
    setNotice(null);
    try {
      await api.deleteEmailRecipient(selectedRecipient.id);
      const next = recipients.filter((r) => r.id !== selectedRecipient.id);
      setRecipients(next);
      applySaved('browser', next, browserSaved);
      setSelectedKey('browser');
      setDirty(false);
      setNotice('Recipient removed.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSendDigest() {
    setBusy('digest');
    setError(null);
    setNotice(null);
    try {
      const r = await api.sendEmailDigest();
      setNotice(
        `Digest sent to ${r.sent} recipient(s), covering ${r.runCount} run(s).` +
          (r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''),
      );
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  const settingsTitle =
    selectedKey === 'browser' ? '🔔 This browser' : `✉️ ${selectedRecipient?.email ?? ''}`;

  return (
    <div>
      <h1>Notifications</h1>
      <p className="muted">
        Run alerts go to <strong>destinations</strong>: this browser (push notifications, even when
        the tab is closed) and any email addresses you add (via Resend). Pick a destination, tick
        the scenarios and outcomes it should be alerted about, then press <strong>Save</strong>.
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}

      <h2 style={{ marginTop: 16 }}>Destinations</h2>
      <div className="dest-list">
        <button
          onClick={() => trySelect('browser')}
          className={selectedKey === 'browser' ? 'dest-row selected' : 'dest-row'}
        >
          <span>🔔 This browser</span>
          <span className="muted">
            {!supported
              ? 'not supported'
              : permission === 'denied'
                ? 'permission blocked'
                : pushSubscribed
                  ? `enabled — ${browserSaved.fail.length} ❌ / ${browserSaved.success.length} ✅`
                  : 'not enabled yet'}
          </span>
        </button>
        {recipients.map((r) => (
          <button
            key={r.id}
            onClick={() => trySelect(r.id)}
            className={selectedKey === r.id ? 'dest-row selected' : 'dest-row'}
          >
            <span>✉️ {r.email}</span>
            <span className="muted">
              {r.scenarioIds.length} ❌ / {r.successScenarioIds.length} ✅
              {r.dailyDigest ? ' · 📰 digest' : ''}
            </span>
          </button>
        ))}
      </div>
      <form
        onSubmit={onAddEmail}
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: 520, marginTop: 8 }}
      >
        <input
          type="email"
          placeholder="name@example.com"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
          aria-label="Email address to add"
        />
        <button type="submit" disabled={busy != null || !newEmail.trim()}>
          {busy === 'add' ? 'Adding…' : '+ Add address'}
        </button>
      </form>

      <h2 style={{ marginTop: 24 }}>
        Settings — {settingsTitle}
        {dirty && (
          <span style={{ marginLeft: 12, fontSize: 14, color: '#facc15', fontWeight: 600 }}>
            ● Unsaved changes
          </span>
        )}
      </h2>

      {selectedKey === 'browser' && !supported && (
        <p className="error">
          This browser doesn't support the Web Push / Service Worker APIs. Try a recent Chrome, Edge,
          or Firefox. (Note: iOS only supports web push for installed/Home-Screen PWAs.)
        </p>
      )}
      {selectedKey === 'browser' && supported && permission === 'denied' && (
        <p className="error">
          Notification permission is blocked for this site. Re-allow it in the browser's site
          settings, then reload.
        </p>
      )}
      {selectedKey !== 'browser' && emailStatus && !emailStatus.enabled && (
        <p className="error">
          Email sending is not configured. Set <code>RESEND_API_KEY</code> (and{' '}
          <code>EMAIL_FROM</code> with a domain verified in Resend) in <code>.env</code>, then
          restart the server. Selections still save — mails go out once configured.
        </p>
      )}

      {selectedKey !== 'browser' && selectedRecipient && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0' }}>
          <input
            type="checkbox"
            checked={dailyDigest}
            onChange={(e) => {
              setDailyDigest(e.target.checked);
              setDirty(true);
              setNotice(null);
            }}
          />
          Daily digest at 09:00 with the status of all runs of the last 24 hours
        </label>
      )}

      <details className="filter-panel" open={activeFilterCount > 0}>
        <summary>
          Filter{' '}
          {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount} active</span>}
        </summary>
        <div className="filter-body">
          <div className="filter-group">
            <div className="filter-group-label">Brand</div>
            {brands.length === 0 ? (
              <span className="muted">No brands yet</span>
            ) : (
              <div className="chip-row">
                {brands.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`chip${selectedBrands.has(b) ? ' chip-on' : ''}`}
                    onClick={() => toggleFilter(selectedBrands, b, setSelectedBrands)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="filter-group">
            <div className="filter-group-label">Type</div>
            {types.length === 0 ? (
              <span className="muted">No types yet</span>
            ) : (
              <div className="chip-row">
                {types.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${selectedTypes.has(t) ? ' chip-on' : ''}`}
                    onClick={() => toggleFilter(selectedTypes, t, setSelectedTypes)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="filter-clear"
              onClick={() => {
                setSelectedBrands(new Set());
                setSelectedTypes(new Set());
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </details>

      <table className="table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ width: 80 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={
                    visibleScenarios.length > 0 &&
                    visibleScenarios.every((s) => failSelected.has(s.id))
                  }
                  onChange={() => toggleAll('fail')}
                  aria-label="Toggle failure notifications for all filtered scenarios"
                />
                ❌ Fail
              </label>
            </th>
            <th style={{ width: 100 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={
                    visibleScenarios.length > 0 &&
                    visibleScenarios.every((s) => successSelected.has(s.id))
                  }
                  onChange={() => toggleAll('success')}
                  aria-label="Toggle success notifications for all filtered scenarios"
                />
                ✅ Success
              </label>
            </th>
            <th>Scenario</th>
            <th>URL</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">No scenarios yet.</td>
            </tr>
          ) : visibleScenarios.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                No scenarios match the current filters.
              </td>
            </tr>
          ) : (
            visibleScenarios.map((s) => (
              <tr key={s.id}>
                <td data-label="Fail">
                  <input
                    type="checkbox"
                    checked={failSelected.has(s.id)}
                    onChange={() => toggle('fail', s.id)}
                    aria-label={`Notify ${settingsTitle} on failure of ${s.name}`}
                  />
                </td>
                <td data-label="Success">
                  <input
                    type="checkbox"
                    checked={successSelected.has(s.id)}
                    onChange={() => toggle('success', s.id)}
                    aria-label={`Notify ${settingsTitle} on success of ${s.name}`}
                  />
                </td>
                <td data-label="Scenario"><code>{s.name}</code></td>
                <td data-label="URL" style={{ wordBreak: 'break-all' }}>{s.url}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button
          onClick={onSave}
          disabled={busy != null || (selectedKey === 'browser' && !supported)}
          style={dirty ? { outline: '2px solid #facc15' } : undefined}
        >
          {busy === 'save'
            ? 'Saving…'
            : selectedKey === 'browser' && !pushSubscribed
              ? '🔔 Enable & save'
              : '💾 Save selection'}
        </button>
        {selectedKey === 'browser' ? (
          pushSubscribed && (
            <>
              <button onClick={onTest} disabled={busy != null}>
                {busy === 'test' ? 'Sending…' : 'Send test notification'}
              </button>
              <button className="btn-danger" onClick={onDisableBrowser} disabled={busy != null}>
                {busy === 'disable' ? 'Disabling…' : 'Disable on this browser'}
              </button>
            </>
          )
        ) : (
          selectedRecipient && (
            <>
              <button onClick={onTest} disabled={busy != null || !emailStatus?.enabled}>
                {busy === 'test' ? 'Sending…' : 'Send test email'}
              </button>
              <button
                onClick={onSendDigest}
                disabled={busy != null || recipients.every((r) => !r.dailyDigest)}
                title="Send the daily digest (all runs of the last 24 hours) right now to every address with the digest enabled"
              >
                {busy === 'digest' ? 'Sending…' : 'Send digest now'}
              </button>
              <button className="btn-danger" onClick={onDeleteEmail} disabled={busy != null}>
                {busy === 'delete' ? 'Removing…' : 'Remove address'}
              </button>
            </>
          )
        )}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {selectedKey === 'browser'
          ? 'The browser selection only affects this browser; every browser subscribes independently.'
          : 'Changes apply to this email address only. Unsaved changes are highlighted until you press Save.'}
      </p>
    </div>
  );
}

// Mirrors the /runs filter: distinct non-empty tag values, sorted.
function collectTagValues(scenarios: Scenario[], key: 'brand' | 'type'): string[] {
  const set = new Set<string>();
  for (const s of scenarios) {
    const v = s[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

import { useEffect, useState } from 'react';
import { api, type Scenario } from '../lib/api.js';
import {
  pushSupported,
  notificationPermission,
  getExistingSubscription,
  enablePush,
  saveScenarioSelection,
  disablePush,
  sendTestNotification,
} from '../lib/push.js';

export function Notifications() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [failSelected, setFailSelected] = useState<Set<number>>(new Set());
  const [successSelected, setSuccessSelected] = useState<Set<number>>(new Set());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const supported = pushSupported();
  const permission = notificationPermission();

  async function refresh() {
    setError(null);
    try {
      const list = await api.listScenarios();
      setScenarios(list);
      const sub = await getExistingSubscription();
      if (sub) {
        const status = await api.pushStatus(sub.endpoint);
        setSubscribed(status.subscribed);
        setFailSelected(new Set(status.scenarioIds));
        setSuccessSelected(new Set(status.successScenarioIds));
      } else {
        setSubscribed(false);
        setFailSelected(new Set());
        setSuccessSelected(new Set());
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function toggle(set: 'fail' | 'success', id: number) {
    const update = set === 'fail' ? setFailSelected : setSuccessSelected;
    update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(set: 'fail' | 'success') {
    const current = set === 'fail' ? failSelected : successSelected;
    const update = set === 'fail' ? setFailSelected : setSuccessSelected;
    const allChecked = scenarios.length > 0 && scenarios.every((s) => current.has(s.id));
    update(allChecked ? new Set() : new Set(scenarios.map((s) => s.id)));
  }

  async function onEnable() {
    setBusy('enable');
    setError(null);
    setNotice(null);
    try {
      await enablePush(Array.from(failSelected), Array.from(successSelected));
      setSubscribed(true);
      setNotice('Notifications enabled for this browser.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      await saveScenarioSelection(Array.from(failSelected), Array.from(successSelected));
      setSubscribed(true);
      setNotice('Saved.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDisable() {
    setBusy('disable');
    setError(null);
    setNotice(null);
    try {
      await disablePush();
      setSubscribed(false);
      setFailSelected(new Set());
      setSuccessSelected(new Set());
      setNotice('Notifications disabled for this browser.');
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
      await sendTestNotification();
      setNotice('Test push sent — you should see a notification shortly.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1>Notifications</h1>
      <p className="muted">
        Get a browser push notification when a scenario run <strong>fails</strong> or{' '}
        <strong>succeeds</strong> — even when this tab is closed (the browser just has to be
        running). Each browser subscribes independently and picks which scenarios and outcomes it
        wants.
      </p>

      {!supported && (
        <p className="error">
          This browser doesn't support the Web Push / Service Worker APIs. Try a recent Chrome, Edge,
          or Firefox. (Note: iOS only supports web push for installed/Home-Screen PWAs.)
        </p>
      )}
      {supported && permission === 'denied' && (
        <p className="error">
          Notification permission is blocked for this site. Re-allow it in the browser's site
          settings, then reload.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {!subscribed ? (
          <button onClick={onEnable} disabled={!supported || busy != null}>
            {busy === 'enable' ? 'Enabling…' : '🔔 Enable notifications on this browser'}
          </button>
        ) : (
          <>
            <button onClick={onSave} disabled={busy != null}>
              {busy === 'save' ? 'Saving…' : '💾 Save selection'}
            </button>
            <button onClick={onTest} disabled={busy != null}>
              {busy === 'test' ? 'Sending…' : 'Send test notification'}
            </button>
            <button className="btn-danger" onClick={onDisable} disabled={busy != null}>
              {busy === 'disable' ? 'Disabling…' : 'Disable on this browser'}
            </button>
          </>
        )}
      </div>

      <table className="table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ width: 80 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={scenarios.length > 0 && scenarios.every((s) => failSelected.has(s.id))}
                  onChange={() => toggleAll('fail')}
                  aria-label="Toggle failure notifications for all scenarios"
                />
                ❌ Fail
              </label>
            </th>
            <th style={{ width: 100 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={scenarios.length > 0 && scenarios.every((s) => successSelected.has(s.id))}
                  onChange={() => toggleAll('success')}
                  aria-label="Toggle success notifications for all scenarios"
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
          ) : (
            scenarios.map((s) => (
              <tr key={s.id}>
                <td data-label="Fail">
                  <input
                    type="checkbox"
                    checked={failSelected.has(s.id)}
                    onChange={() => toggle('fail', s.id)}
                    aria-label={`Notify on failure of ${s.name}`}
                  />
                </td>
                <td data-label="Success">
                  <input
                    type="checkbox"
                    checked={successSelected.has(s.id)}
                    onChange={() => toggle('success', s.id)}
                    aria-label={`Notify on success of ${s.name}`}
                  />
                </td>
                <td data-label="Scenario"><code>{s.name}</code></td>
                <td data-label="URL" style={{ wordBreak: 'break-all' }}>{s.url}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {subscribed && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Tick the outcomes you want alerts for per scenario, then{' '}
          <strong>Save selection</strong>. Changes only affect this browser.
        </p>
      )}
    </div>
  );
}

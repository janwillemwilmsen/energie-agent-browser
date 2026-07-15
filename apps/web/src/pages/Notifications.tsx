import { useEffect, useState } from 'react';
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

      <EmailNotifications scenarios={scenarios} />
    </div>
  );
}

function EmailNotifications({ scenarios }: { scenarios: Scenario[] }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ enabled: boolean; from: string } | null>(null);
  const [recipients, setRecipients] = useState<EmailRecipient[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [failSelected, setFailSelected] = useState<Set<number>>(new Set());
  const [successSelected, setSuccessSelected] = useState<Set<number>>(new Set());
  const [dailyDigest, setDailyDigest] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [st, list] = await Promise.all([api.emailStatus(), api.listEmailRecipients()]);
      setStatus(st);
      setRecipients(list);
      if (selectedId != null && !list.some((r) => r.id === selectedId)) setSelectedId(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  function select(r: EmailRecipient) {
    setSelectedId(r.id);
    setFailSelected(new Set(r.scenarioIds));
    setSuccessSelected(new Set(r.successScenarioIds));
    setDailyDigest(r.dailyDigest);
    setNotice(null);
    setError(null);
  }

  const selected = recipients.find((r) => r.id === selectedId) ?? null;

  function toggle(set: 'fail' | 'success', id: number) {
    const update = set === 'fail' ? setFailSelected : setSuccessSelected;
    update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const created = await api.addEmailRecipient(email);
      setNewEmail('');
      await load();
      select(created);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (selectedId == null) return;
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      await api.updateEmailRecipient(selectedId, {
        scenarioIds: Array.from(failSelected),
        successScenarioIds: Array.from(successSelected),
        dailyDigest,
      });
      await load();
      setNotice('Saved.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (selected == null) return;
    if (!confirm(`Remove ${selected.email} from email notifications?`)) return;
    setBusy('delete');
    setError(null);
    setNotice(null);
    try {
      await api.deleteEmailRecipient(selected.id);
      setSelectedId(null);
      await load();
      setNotice('Recipient removed.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    if (selectedId == null) return;
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      await api.sendEmailTest(selectedId);
      setNotice('Test email sent — check the inbox (and spam folder).');
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

  return (
    <div style={{ marginTop: 32 }}>
      <h2>
        Email{' '}
        <button onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide email notifications' : '✉️ Email notifications'}
        </button>
      </h2>
      {!open ? (
        <p className="muted">
          Send scenario run alerts and a daily 09:00 digest to email addresses (via Resend).
        </p>
      ) : (
        <>
          {status && !status.enabled && (
            <p className="error">
              Email sending is not configured. Set <code>RESEND_API_KEY</code> (and{' '}
              <code>EMAIL_FROM</code> with a domain verified in Resend) in <code>.env</code>, then
              restart the server.
            </p>
          )}
          {error && <p className="error">{error}</p>}
          {notice && <p style={{ color: '#4ade80', fontWeight: 600 }}>{notice}</p>}

          <form onSubmit={onAdd} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
            <input
              type="email"
              placeholder="name@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              style={{ minWidth: 260 }}
              aria-label="Email address to add"
            />
            <button type="submit" disabled={busy != null || !newEmail.trim()}>
              {busy === 'add' ? 'Adding…' : '+ Add address'}
            </button>
            <button
              type="button"
              onClick={onSendDigest}
              disabled={busy != null || recipients.every((r) => !r.dailyDigest)}
              title="Send the daily digest (all runs of the last 24 hours) right now to every address with the digest enabled"
            >
              {busy === 'digest' ? 'Sending…' : 'Send digest now'}
            </button>
          </form>

          {recipients.length === 0 ? (
            <p className="muted">No email addresses yet — add one above.</p>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {recipients.map((r) => (
                <button
                  key={r.id}
                  onClick={() => select(r)}
                  style={r.id === selectedId ? { outline: '2px solid #4ade80' } : undefined}
                  title={`${r.scenarioIds.length} failure + ${r.successScenarioIds.length} success selection(s)${r.dailyDigest ? ', daily digest' : ''}`}
                >
                  {r.email}
                  {r.dailyDigest ? ' 📰' : ''}
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div>
              <p className="muted" style={{ margin: '4px 0 8px' }}>
                Notification settings for <strong>{selected.email}</strong>:
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={dailyDigest}
                  onChange={(e) => setDailyDigest(e.target.checked)}
                />
                Daily digest at 09:00 with the status of all runs of the last 24 hours
              </label>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>❌ Fail</th>
                    <th style={{ width: 100 }}>✅ Success</th>
                    <th>Scenario</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted">No scenarios yet.</td>
                    </tr>
                  ) : (
                    scenarios.map((s) => (
                      <tr key={s.id}>
                        <td data-label="Fail">
                          <input
                            type="checkbox"
                            checked={failSelected.has(s.id)}
                            onChange={() => toggle('fail', s.id)}
                            aria-label={`Email ${selected.email} on failure of ${s.name}`}
                          />
                        </td>
                        <td data-label="Success">
                          <input
                            type="checkbox"
                            checked={successSelected.has(s.id)}
                            onChange={() => toggle('success', s.id)}
                            aria-label={`Email ${selected.email} on success of ${s.name}`}
                          />
                        </td>
                        <td data-label="Scenario"><code>{s.name}</code></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button onClick={onSave} disabled={busy != null}>
                  {busy === 'save' ? 'Saving…' : '💾 Save selection'}
                </button>
                <button onClick={onTest} disabled={busy != null || !status?.enabled}>
                  {busy === 'test' ? 'Sending…' : 'Send test email'}
                </button>
                <button className="btn-danger" onClick={onDelete} disabled={busy != null}>
                  {busy === 'delete' ? 'Removing…' : 'Remove address'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

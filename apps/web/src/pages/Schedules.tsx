import { useEffect, useState } from 'react';
import cronstrue from 'cronstrue';
import { api, type Schedule, type Scenario } from '../lib/api.js';

const WEEKDAYS = [
  { v: '1', l: 'Mon' },
  { v: '2', l: 'Tue' },
  { v: '3', l: 'Wed' },
  { v: '4', l: 'Thu' },
  { v: '5', l: 'Fri' },
  { v: '6', l: 'Sat' },
  { v: '0', l: 'Sun' },
];

export function Schedules() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState<number | ''>('');
  const [hour, setHour] = useState('9');
  const [minute, setMinute] = useState('0');
  const [day, setDay] = useState('*');
  const [enabled, setEnabled] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.listSchedules());
      setScenarios(await api.listScenarios());
    } catch (e: any) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const cronExpr = `${minute} ${hour} * * ${day}`;
  let humanized = '';
  try {
    humanized = cronstrue.toString(cronExpr);
  } catch (e: any) {
    humanized = `invalid: ${e.message}`;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!scenarioId) {
      setErr('Pick a scenario');
      return;
    }
    try {
      await api.createSchedule({ scenario_id: Number(scenarioId), cron_expr: cronExpr, enabled });
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function toggle(s: Schedule) {
    await api.updateSchedule(s.id, { enabled: !s.enabled });
    await load();
  }

  async function remove(id: number) {
    if (!confirm('Delete schedule?')) return;
    await api.deleteSchedule(id);
    await load();
  }

  return (
    <section>
      <h1>Schedules</h1>
      {err && <p className="error">{err}</p>}

      <form onSubmit={create} className="card">
        <h3>New schedule</h3>
        <label>
          Scenario
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— pick a scenario —</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1 }}>
            Day of week
            <select value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="*">Every day</option>
              {WEEKDAYS.map((d) => (
                <option key={d.v} value={d.v}>
                  {d.l}
                </option>
              ))}
            </select>
          </label>
          <label style={{ width: 80 }}>
            Hour
            <input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} />
          </label>
          <label style={{ width: 80 }}>
            Minute
            <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} />
          </label>
        </div>
        <p className="muted">
          Cron: <code>{cronExpr}</code> &mdash; {humanized}
        </p>
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <button type="submit">Add</button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Scenario</th>
            <th>Cron</th>
            <th>When</th>
            <th>Enabled</th>
            <th>Last run</th>
            <th>Last status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            let when = '';
            try { when = cronstrue.toString(s.cron_expr); } catch {}
            return (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{scenarios.find((sc) => sc.id === s.scenario_id)?.name ?? s.scenario_id}</td>
                <td><code>{s.cron_expr}</code></td>
                <td>{when}</td>
                <td>
                  <button onClick={() => toggle(s)}>{s.enabled ? 'on' : 'off'}</button>
                </td>
                <td>{s.last_run_at ?? '—'}</td>
                <td>{s.last_status ?? '—'}</td>
                <td>
                  <button onClick={() => remove(s.id)}>Delete</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

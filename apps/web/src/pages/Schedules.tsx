import { useEffect, useMemo, useState } from 'react';
import cronstrue from 'cronstrue';
import { api, type Schedule, type Scenario } from '../lib/api.js';

const WEEKDAYS: { v: number; l: string }[] = [
  { v: 1, l: 'Mon' },
  { v: 2, l: 'Tue' },
  { v: 3, l: 'Wed' },
  { v: 4, l: 'Thu' },
  { v: 5, l: 'Fri' },
  { v: 6, l: 'Sat' },
  { v: 0, l: 'Sun' },
];

type HourMode = 'every' | 'stepped' | 'specific' | 'range';

function daysToField(days: number[]): string {
  if (days.length === 0 || days.length === 7) return '*';
  // cronstrue handles ranges nicely; collapse 1-5 into "1-5" for readability
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  // Detect Mon-Fri
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return '1-5';
  // Detect Sat+Sun
  if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) return '0,6';
  return sorted.join(',');
}

function hoursToField(mode: HourMode, hour: string, hourStep: string, hourStart: string, hourEnd: string): string {
  switch (mode) {
    case 'every':
      return '*';
    case 'stepped':
      return `*/${hourStep || '1'}`;
    case 'range':
      return `${hourStart || '0'}-${hourEnd || '23'}`;
    case 'specific':
    default:
      return hour || '0';
  }
}

export function Schedules() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState<number | ''>('');

  // Day-of-week chips. Empty = every day (*).
  const [days, setDays] = useState<number[]>([]);

  // Hour controls.
  const [hourMode, setHourMode] = useState<HourMode>('specific');
  const [hour, setHour] = useState('9');
  const [hourStep, setHourStep] = useState('1');
  const [hourStart, setHourStart] = useState('9');
  const [hourEnd, setHourEnd] = useState('17');

  const [minute, setMinute] = useState('0');

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

  const cronExpr = useMemo(() => {
    const m = minute || '0';
    const h = hoursToField(hourMode, hour, hourStep, hourStart, hourEnd);
    const d = daysToField(days);
    return `${m} ${h} * * ${d}`;
  }, [minute, hour, hourMode, hourStep, hourStart, hourEnd, days]);

  let humanized = '';
  try {
    humanized = cronstrue.toString(cronExpr);
  } catch (e: any) {
    humanized = `invalid: ${e.message}`;
  }

  function toggleDay(v: number) {
    setDays((prev) => (prev.includes(v) ? prev.filter((d) => d !== v) : [...prev, v]));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!scenarioId) {
      setErr('Pick a scenario');
      return;
    }
    try {
      await api.createSchedule({ scenario_id: Number(scenarioId), cron_expr: cronExpr, enabled: true });
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

        <div>
          <div className="filter-group-label">Days</div>
          <div className="chip-row">
            <button
              type="button"
              className={`chip ${days.length === 0 ? 'chip-on' : ''}`}
              onClick={() => setDays([])}
            >
              Every day
            </button>
            <button
              type="button"
              className={`chip ${daysToField(days) === '1-5' ? 'chip-on' : ''}`}
              onClick={() => setDays([1, 2, 3, 4, 5])}
            >
              Workdays
            </button>
            <button
              type="button"
              className={`chip ${daysToField(days) === '0,6' ? 'chip-on' : ''}`}
              onClick={() => setDays([0, 6])}
            >
              Weekends
            </button>
          </div>
          <div className="chip-row" style={{ marginTop: 6 }}>
            {WEEKDAYS.map((d) => (
              <button
                key={d.v}
                type="button"
                className={`chip ${days.includes(d.v) ? 'chip-on' : ''}`}
                onClick={() => toggleDay(d.v)}
              >
                {d.l}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ flex: 1, minWidth: 160 }}>
            Hour
            <select value={hourMode} onChange={(e) => setHourMode(e.target.value as HourMode)}>
              <option value="specific">Specific hour</option>
              <option value="every">Every hour</option>
              <option value="stepped">Every N hours</option>
              <option value="range">Hour range</option>
            </select>
          </label>
          {hourMode === 'specific' && (
            <label style={{ width: 90 }}>
              At
              <input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} />
            </label>
          )}
          {hourMode === 'stepped' && (
            <label style={{ width: 90 }}>
              N
              <input
                type="number"
                min={1}
                max={23}
                value={hourStep}
                onChange={(e) => setHourStep(e.target.value)}
              />
            </label>
          )}
          {hourMode === 'range' && (
            <>
              <label style={{ width: 90 }}>
                From
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hourStart}
                  onChange={(e) => setHourStart(e.target.value)}
                />
              </label>
              <label style={{ width: 90 }}>
                To
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hourEnd}
                  onChange={(e) => setHourEnd(e.target.value)}
                />
              </label>
            </>
          )}
          <label style={{ width: 90 }}>
            Minute
            <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} />
          </label>
        </div>

        <p className="muted">
          Cron: <code>{cronExpr}</code> &mdash; {humanized}
        </p>
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

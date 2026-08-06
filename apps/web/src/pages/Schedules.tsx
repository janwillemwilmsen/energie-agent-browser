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

const MONTHS: { v: number; l: string }[] = [
  { v: 1, l: 'Jan' },
  { v: 2, l: 'Feb' },
  { v: 3, l: 'Mar' },
  { v: 4, l: 'Apr' },
  { v: 5, l: 'May' },
  { v: 6, l: 'Jun' },
  { v: 7, l: 'Jul' },
  { v: 8, l: 'Aug' },
  { v: 9, l: 'Sep' },
  { v: 10, l: 'Oct' },
  { v: 11, l: 'Nov' },
  { v: 12, l: 'Dec' },
];

type HourMode = 'every' | 'stepped' | 'specific' | 'range';

// Weekly and monthly are mutually exclusive on purpose: cron treats a
// restricted day-of-week AND day-of-month as OR ("either matches"), which is
// never what a user building "the 1st, if it's a Monday" expects.
type RepeatMode = 'weekly' | 'monthly';

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

// "1, 15" → sorted unique days clamped to 1-31. Empty/garbage falls back to
// the 1st so monthly mode can never emit "* *" (which would mean every day).
function parseDom(input: string): number[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31),
    ),
  ].sort((a, b) => a - b);
}

function domToField(input: string): string {
  const days = parseDom(input);
  return days.length === 0 ? '1' : days.join(',');
}

function monthsToField(months: number[]): string {
  if (months.length === 0 || months.length === 12) return '*';
  return [...new Set(months)].sort((a, b) => a - b).join(',');
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

  // Ordered chain of scenario ids the schedule runs sequentially. Duplicates
  // are allowed on purpose (run the same scenario at the start and end).
  const [chain, setChain] = useState<number[]>([]);

  const [mode, setMode] = useState<RepeatMode>('weekly');

  // Day-of-week chips. Empty = every day (*).
  const [days, setDays] = useState<number[]>([]);

  // Monthly mode: comma list of days of the month + month chips (empty = every month).
  const [domInput, setDomInput] = useState('1');
  const [months, setMonths] = useState<number[]>([]);

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
    if (mode === 'monthly') {
      return `${m} ${h} ${domToField(domInput)} ${monthsToField(months)} *`;
    }
    return `${m} ${h} * * ${daysToField(days)}`;
  }, [minute, hour, hourMode, hourStep, hourStart, hourEnd, days, mode, domInput, months]);

  let humanized = '';
  try {
    humanized = cronstrue.toString(cronExpr);
  } catch (e: any) {
    humanized = `invalid: ${e.message}`;
  }

  function toggleDay(v: number) {
    setDays((prev) => (prev.includes(v) ? prev.filter((d) => d !== v) : [...prev, v]));
  }

  function toggleMonth(v: number) {
    setMonths((prev) => (prev.includes(v) ? prev.filter((m) => m !== v) : [...prev, v]));
  }

  function addToChain(id: number) {
    setChain((prev) => [...prev, id]);
  }

  function removeFromChain(index: number) {
    setChain((prev) => prev.filter((_, i) => i !== index));
  }

  function moveInChain(index: number, delta: -1 | 1) {
    setChain((prev) => {
      const j = index + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j]!, next[index]!];
      return next;
    });
  }

  function scenarioName(id: number): string {
    return scenarios.find((s) => s.id === id)?.name ?? `#${id}`;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (chain.length === 0) {
      setErr('Add at least one scenario');
      return;
    }
    try {
      await api.createSchedule({ scenario_ids: chain, cron_expr: cronExpr, enabled: true });
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
          Scenarios (run in order, one after another)
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addToChain(Number(e.target.value));
            }}
          >
            <option value="">— add a scenario to the chain —</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {chain.length > 0 && (
          <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {chain.map((id, i) => (
              <li key={`${id}-${i}`}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <code>{scenarioName(id)}</code>
                  <button
                    type="button"
                    onClick={() => moveInChain(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${scenarioName(id)} earlier`}
                    style={{ padding: '2px 8px', fontSize: 12 }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveInChain(i, 1)}
                    disabled={i === chain.length - 1}
                    aria-label={`Move ${scenarioName(id)} later`}
                    style={{ padding: '2px 8px', fontSize: 12 }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeFromChain(i)}
                    aria-label={`Remove ${scenarioName(id)} from the chain`}
                    style={{ padding: '2px 8px', fontSize: 12 }}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}

        <div>
          <div className="filter-group-label">Repeat</div>
          <div className="chip-row">
            <button
              type="button"
              className={`chip ${mode === 'weekly' ? 'chip-on' : ''}`}
              onClick={() => setMode('weekly')}
            >
              Weekly
            </button>
            <button
              type="button"
              className={`chip ${mode === 'monthly' ? 'chip-on' : ''}`}
              onClick={() => setMode('monthly')}
            >
              Monthly
            </button>
          </div>
        </div>

        {mode === 'weekly' ? (
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
        ) : (
          <>
            <div>
              <div className="filter-group-label">Day of month</div>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip ${domToField(domInput) === '1' ? 'chip-on' : ''}`}
                  onClick={() => setDomInput('1')}
                >
                  1st
                </button>
                <button
                  type="button"
                  className={`chip ${domToField(domInput) === '15' ? 'chip-on' : ''}`}
                  onClick={() => setDomInput('15')}
                >
                  15th
                </button>
                <button
                  type="button"
                  className={`chip ${domToField(domInput) === '28' ? 'chip-on' : ''}`}
                  onClick={() => setDomInput('28')}
                >
                  28th
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Day(s)
                  <input
                    value={domInput}
                    onChange={(e) => setDomInput(e.target.value)}
                    placeholder="e.g. 1 or 1,15"
                    style={{ width: 110 }}
                    aria-label="Day(s) of the month, comma-separated"
                  />
                </label>
              </div>
              {parseDom(domInput).some((d) => d >= 29) && (
                <p className="muted" style={{ marginTop: 6 }}>
                  Days 29–31 are silently skipped in months that don't have them (cron has no
                  "last day of month" — 28 is the latest day that exists in every month).
                </p>
              )}
            </div>
            <div>
              <div className="filter-group-label">Months</div>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip ${months.length === 0 ? 'chip-on' : ''}`}
                  onClick={() => setMonths([])}
                >
                  Every month
                </button>
                {MONTHS.map((m) => (
                  <button
                    key={m.v}
                    type="button"
                    className={`chip ${months.includes(m.v) ? 'chip-on' : ''}`}
                    onClick={() => toggleMonth(m.v)}
                  >
                    {m.l}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

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

      <table className="table schedules-table">
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
                <td data-label="ID">{s.id}</td>
                <td data-label="Scenario">
                  {(s.scenario_ids ?? [s.scenario_id]).map(scenarioName).join(' → ')}
                </td>
                <td data-label="Cron"><code>{s.cron_expr}</code></td>
                <td data-label="When">{when}</td>
                <td data-label="Enabled">
                  <button onClick={() => toggle(s)}>{s.enabled ? 'on' : 'off'}</button>
                </td>
                <td data-label="Last run">{s.last_run_at ?? '—'}</td>
                <td data-label="Last status">{s.last_status ?? '—'}</td>
                <td className="schedule-actions">
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

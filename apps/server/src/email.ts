import { Resend } from 'resend';
import cron from 'node-cron';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { getSetting, setSetting } from './settings.js';

// --- Resend client -----------------------------------------------------------
// The Node SDK returns { data, error } and never throws for API errors, so
// every send checks `error` explicitly (per Resend's own guidance).
let client: Resend | null = null;

export function emailEnabled(): boolean {
  return config.email.resendApiKey.length > 0;
}

function getResend(): Resend {
  if (!client) client = new Resend(config.email.resendApiKey);
  return client;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
}): Promise<SendResult> {
  if (!emailEnabled()) return { ok: false, error: 'RESEND_API_KEY is not configured' };
  const { data, error } = await getResend().emails.send(
    {
      from: config.email.from,
      to: [opts.to],
      ...(config.email.replyTo ? { replyTo: config.email.replyTo } : {}),
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    },
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id };
}

// --- Templates ----------------------------------------------------------------
// Kept deliberately simple and accessible: lang/dir on <html> AND on the body's
// direct child (clients strip <html> attributes), a <title>, one <h1> (skipped
// for one-line alerts), real <th scope="col"> headers on the data table.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function runsUrl(): string | null {
  const base = config.email.appBaseUrl.replace(/\/$/, '');
  return base ? `${base}/runs` : null;
}

function baseHtml(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f6f6;">
<div lang="en" dir="ltr" style="max-width:640px;margin:0 auto;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;background:#ffffff;">
${inner}
<p style="margin-top:32px;font-size:12px;color:#595959;">Sent by Energie Agent Browser. Manage email notifications on the app's Notifications page.</p>
</div>
</body>
</html>`;
}

// --- Recipient storage ---------------------------------------------------------
export interface EmailRecipient {
  id: number;
  email: string;
  scenarioIds: number[];
  successScenarioIds: number[];
  dailyDigest: boolean;
  weeklyDigest: boolean;
  monthlyDigest: boolean;
}

interface RecipientRow {
  id: number;
  email: string;
  scenario_ids_json: string;
  success_scenario_ids_json: string;
  daily_digest: number;
  weekly_digest: number;
  monthly_digest: number;
}

function parseIds(json: string): number[] {
  try {
    return JSON.parse(json) as number[];
  } catch {
    return [];
  }
}

function toRecipient(r: RecipientRow): EmailRecipient {
  return {
    id: r.id,
    email: r.email,
    scenarioIds: parseIds(r.scenario_ids_json),
    successScenarioIds: parseIds(r.success_scenario_ids_json),
    dailyDigest: r.daily_digest === 1,
    weeklyDigest: r.weekly_digest === 1,
    monthlyDigest: r.monthly_digest === 1,
  };
}

export function listRecipients(): EmailRecipient[] {
  const rows = getDb()
    .prepare('SELECT * FROM email_recipients ORDER BY email')
    .all() as RecipientRow[];
  return rows.map(toRecipient);
}

export function getRecipient(id: number): EmailRecipient | null {
  const row = getDb().prepare('SELECT * FROM email_recipients WHERE id = ?').get(id) as
    | RecipientRow
    | undefined;
  return row ? toRecipient(row) : null;
}

export function addRecipient(email: string): EmailRecipient {
  getDb()
    .prepare('INSERT INTO email_recipients (email) VALUES (?) ON CONFLICT(email) DO NOTHING')
    .run(email);
  const row = getDb().prepare('SELECT * FROM email_recipients WHERE email = ?').get(email) as RecipientRow;
  return toRecipient(row);
}

export function updateRecipient(
  id: number,
  patch: {
    scenarioIds: number[];
    successScenarioIds: number[];
    dailyDigest: boolean;
    weeklyDigest: boolean;
    monthlyDigest: boolean;
  },
): EmailRecipient | null {
  const info = getDb()
    .prepare(
      `UPDATE email_recipients
       SET scenario_ids_json = ?, success_scenario_ids_json = ?,
           daily_digest = ?, weekly_digest = ?, monthly_digest = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(
      JSON.stringify(patch.scenarioIds),
      JSON.stringify(patch.successScenarioIds),
      patch.dailyDigest ? 1 : 0,
      patch.weeklyDigest ? 1 : 0,
      patch.monthlyDigest ? 1 : 0,
      id,
    );
  if (info.changes === 0) return null;
  return getRecipient(id);
}

export function deleteRecipient(id: number): boolean {
  return getDb().prepare('DELETE FROM email_recipients WHERE id = ?').run(id).changes > 0;
}

// --- Run result notifications ---------------------------------------------------
// Called by the runner next to the push notification. Fire-and-forget: a mail
// problem must never affect the run. Sends go out sequentially — Resend's
// default rate limit is 2 req/s and recipient lists here are small.
export async function notifyRunResultEmail(
  scenario: { id: number; name: string },
  runId: number,
  outcome: 'failed' | 'success',
): Promise<void> {
  try {
    if (!emailEnabled()) return;
    const targets = listRecipients().filter((r) =>
      (outcome === 'failed' ? r.scenarioIds : r.successScenarioIds).includes(scenario.id),
    );
    if (targets.length === 0) return;

    const verb = outcome === 'failed' ? 'failed' : 'succeeded';
    const subject = `Scenario ${verb}: ${scenario.name} (run #${runId})`;
    const link = runsUrl();
    const linkHtml = link
      ? `<p><a href="${esc(link)}" style="color:#1d4ed8;">View run #${runId} on the Runs page</a></p>`
      : '';
    const html = baseHtml(
      subject,
      `<p>Scenario <strong>${esc(scenario.name)}</strong> ${verb} in run <strong>#${runId}</strong>.</p>${linkHtml}`,
    );
    const text =
      `Scenario "${scenario.name}" ${verb} in run #${runId}.` + (link ? `\n${link}` : '');

    for (const r of targets) {
      const res = await sendEmail({
        to: r.email,
        subject,
        html,
        text,
        // One key per run+outcome+recipient: a retried runner call can't
        // double-send, but failure and success of the same run stay distinct.
        idempotencyKey: `run-${outcome}/${runId}-r${r.id}`,
      });
      if (!res.ok) console.error(`email: run ${outcome} notification to ${r.email} failed: ${res.error}`);
    }
  } catch (e: any) {
    console.error(`email: notifyRunResultEmail threw: ${e?.message ?? e}`);
  }
}

// --- Test email ------------------------------------------------------------------
export async function sendTestEmail(to: string): Promise<SendResult> {
  const subject = 'Test notification — Energie Agent Browser';
  const html = baseHtml(
    subject,
    `<p>Email notifications are working. You will receive scenario run alerts at this address according to your selection on the Notifications page.</p>`,
  );
  const text =
    'Email notifications are working. You will receive scenario run alerts at this address according to your selection on the Notifications page.';
  // No idempotency key: the whole point of the button is "send one now".
  return sendEmail({ to, subject, html, text });
}

// --- Run digests (daily / weekly / monthly) ---------------------------------------
interface DigestRunRow {
  id: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  scenario_name: string | null;
}

export type DigestPeriod = 'daily' | 'weekly' | 'monthly';
export const DIGEST_PERIODS: DigestPeriod[] = ['daily', 'weekly', 'monthly'];

const DIGEST_HOUR = 9; // 09:00 server-local time

interface DigestSpec {
  label: string; // "Daily" — used in subject/heading
  window: string; // SQLite datetime() modifier for the lookback
  windowText: string; // "the last 24 hours"
  settingKey: string; // app_settings key holding the last-sent period stamp
  optedIn: (r: EmailRecipient) => boolean;
  // Identifies the current period (date / Monday date / YYYY-MM); the digest
  // is sent at most once per stamp.
  stamp: (now: Date) => string;
  // Whether this period's send time (09:00 on its first day) has passed for
  // the current stamp — used by the catch-up check at startup.
  due: (now: Date) => boolean;
}

function localDateStamp(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Date of the Monday that starts the week containing `d` (local time).
function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (m.getDay() + 6) % 7; // Mon=0 … Sun=6
  m.setDate(m.getDate() - dow);
  return m;
}

const DIGEST_SPECS: Record<DigestPeriod, DigestSpec> = {
  daily: {
    label: 'Daily',
    window: '-1 day',
    windowText: 'the last 24 hours',
    settingKey: 'email_digest_last_sent', // pre-existing key; keep for continuity
    optedIn: (r) => r.dailyDigest,
    stamp: (now) => localDateStamp(now),
    due: (now) => now.getHours() >= DIGEST_HOUR,
  },
  weekly: {
    label: 'Weekly',
    window: '-7 days',
    windowText: 'the last 7 days',
    settingKey: 'email_digest_weekly_last_sent',
    optedIn: (r) => r.weeklyDigest,
    stamp: (now) => localDateStamp(mondayOf(now)),
    // Due from Monday 09:00 onwards; any later day of the same week still
    // counts as that week's (possibly late) digest.
    due: (now) => now.getDay() !== 1 || now.getHours() >= DIGEST_HOUR,
  },
  monthly: {
    label: 'Monthly',
    window: '-1 month',
    windowText: 'the last month',
    settingKey: 'email_digest_monthly_last_sent',
    optedIn: (r) => r.monthlyDigest,
    stamp: (now) => localDateStamp(now).slice(0, 7), // YYYY-MM
    due: (now) => now.getDate() !== 1 || now.getHours() >= DIGEST_HOUR,
  },
};

export function buildDigest(
  period: DigestPeriod = 'daily',
): { subject: string; html: string; text: string; runCount: number } {
  const spec = DIGEST_SPECS[period];
  const runs = getDb()
    .prepare(
      `SELECT runs.id, runs.status, runs.started_at, runs.finished_at,
              scenarios.name AS scenario_name
       FROM runs
       LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       WHERE runs.started_at >= datetime('now', ?)
       ORDER BY runs.id DESC`,
    )
    .all(spec.window) as DigestRunRow[];

  const failed = runs.filter((r) => r.status === 'failed').length;
  const success = runs.filter((r) => r.status === 'success').length;
  const other = runs.length - failed - success;

  const subject = `${spec.label} run digest: ${runs.length} run(s), ${failed} failed`;

  const rowsHtml = runs
    .map((r) => {
      const color = r.status === 'success' ? '#166534' : r.status === 'failed' ? '#b91c1c' : '#92400e';
      return `<tr>
<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;">#${r.id}</td>
<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;">${esc(r.scenario_name ?? '(deleted scenario)')}</td>
<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;color:${color};font-weight:bold;">${esc(r.status)}</td>
<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;">${esc(r.started_at)} UTC</td>
</tr>`;
    })
    .join('\n');

  const link = runsUrl();
  const table =
    runs.length === 0
      ? `<p>No scenario runs in ${spec.windowText}.</p>`
      : `<table style="border-collapse:collapse;width:100%;font-size:14px;">
<caption style="text-align:left;padding:0 0 8px;font-weight:bold;">Runs of ${spec.windowText}</caption>
<thead>
<tr>
<th scope="col" style="text-align:left;padding:6px 10px;border-bottom:2px solid #1a1a1a;">Run</th>
<th scope="col" style="text-align:left;padding:6px 10px;border-bottom:2px solid #1a1a1a;">Scenario</th>
<th scope="col" style="text-align:left;padding:6px 10px;border-bottom:2px solid #1a1a1a;">Status</th>
<th scope="col" style="text-align:left;padding:6px 10px;border-bottom:2px solid #1a1a1a;">Started</th>
</tr>
</thead>
<tbody>
${rowsHtml}
</tbody>
</table>`;

  const html = baseHtml(
    subject,
    `<h1 style="font-size:20px;margin:0 0 8px;">${spec.label} run digest</h1>
<p>${runs.length} run(s) in ${spec.windowText}: <strong>${success} succeeded</strong>, <strong>${failed} failed</strong>${other ? `, ${other} other` : ''}.</p>
${table}
${link ? `<p><a href="${esc(link)}" style="color:#1d4ed8;">Open the Runs page</a></p>` : ''}`,
  );

  const textLines = runs.map(
    (r) => `#${r.id}  ${r.scenario_name ?? '(deleted scenario)'}  ${r.status}  ${r.started_at} UTC`,
  );
  const text =
    `${spec.label} run digest — ${runs.length} run(s) in ${spec.windowText}: ${success} succeeded, ${failed} failed${other ? `, ${other} other` : ''}.\n\n` +
    (textLines.length ? textLines.join('\n') : `No scenario runs in ${spec.windowText}.`) +
    (link ? `\n\n${link}` : '');

  return { subject, html, text, runCount: runs.length };
}

// Send a period's digest to every recipient that opted in to it. `force`
// skips the once-per-period guard (used by the manual "Send digest now" button).
export async function sendDigest(
  period: DigestPeriod = 'daily',
  force = false,
): Promise<{
  sent: number;
  skipped: boolean;
  runCount: number;
  errors: string[];
}> {
  const spec = DIGEST_SPECS[period];
  const stamp = spec.stamp(new Date());
  if (!force && getSetting(spec.settingKey) === stamp) {
    return { sent: 0, skipped: true, runCount: 0, errors: [] };
  }
  const targets = listRecipients().filter(spec.optedIn);
  const { subject, html, text, runCount } = buildDigest(period);
  const errors: string[] = [];
  let sent = 0;
  for (const r of targets) {
    const res = await sendEmail({
      to: r.email,
      subject,
      html,
      text,
      // Manual re-sends get a distinct key so they actually go out.
      idempotencyKey: force ? undefined : `${period}-digest/${stamp}-r${r.id}`,
    });
    if (res.ok) sent += 1;
    else errors.push(`${r.email}: ${res.error}`);
  }
  if (!force) setSetting(spec.settingKey, stamp);
  return { sent, skipped: false, runCount, errors };
}

// Back-compat alias.
export const sendDailyDigest = (force = false) => sendDigest('daily', force);

async function maybeSendScheduledDigests(): Promise<void> {
  if (!emailEnabled()) return;
  const now = new Date();
  for (const period of DIGEST_PERIODS) {
    const spec = DIGEST_SPECS[period];
    if (!spec.due(now)) continue; // this period's 09:00 hasn't come yet
    if (getSetting(spec.settingKey) === spec.stamp(now)) continue; // already sent
    if (!listRecipients().some(spec.optedIn)) continue; // nobody wants it — don't burn the stamp
    try {
      const r = await sendDigest(period);
      if (!r.skipped) {
        console.log(
          `email: ${period} digest sent to ${r.sent} recipient(s) (${r.runCount} runs)` +
            (r.errors.length ? `; errors: ${r.errors.join('; ')}` : ''),
        );
      }
    } catch (e: any) {
      console.error(`email: ${period} digest failed: ${e?.message ?? e}`);
    }
  }
}

// Fire at 09:00 server-local time every day; each period decides for itself
// whether it's due (daily: every day, weekly: Mondays, monthly: the 1st). Also
// checked once at startup so a server that was down (or deploying) at 09:00
// still sends that period's digest later; the last-sent stamp in app_settings
// prevents duplicates either way.
export function startEmailDigestSchedule(): void {
  cron.schedule(`0 ${DIGEST_HOUR} * * *`, () => void maybeSendScheduledDigests());
  void maybeSendScheduledDigests();
}

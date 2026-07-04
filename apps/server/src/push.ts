import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from './config.js';
import { getDb } from './db/index.js';

// --- VAPID key management ---------------------------------------------------
// Web Push signs each message with a VAPID keypair. The keys MUST stay stable —
// changing them invalidates every existing subscription. Precedence:
//   1. VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars (set these in prod to pin).
//   2. A generated pair persisted at DATA_DIR/vapid.json (survives restarts on
//      the mounted volume). Auto-created on first use so there's zero setup.
let configured = false;
let publicKey = '';

function vapidFile(): string {
  return path.join(config.dataDir, 'vapid.json');
}

function loadOrCreateVapid(): { publicKey: string; privateKey: string; subject: string } {
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv, subject };
  try {
    const saved = JSON.parse(fs.readFileSync(vapidFile(), 'utf-8'));
    if (saved.publicKey && saved.privateKey) {
      return { publicKey: saved.publicKey, privateKey: saved.privateKey, subject };
    }
  } catch {
    /* not created yet — generate below */
  }
  const keys = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(path.dirname(vapidFile()), { recursive: true });
    fs.writeFileSync(vapidFile(), JSON.stringify(keys, null, 2));
  } catch {
    /* best-effort; keys stay in memory for this process at least */
  }
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
}

export function ensurePushConfigured(): void {
  if (configured) return;
  const { publicKey: pub, privateKey, subject } = loadOrCreateVapid();
  webpush.setVapidDetails(subject, pub, privateKey);
  publicKey = pub;
  configured = true;
}

export function getVapidPublicKey(): string {
  ensurePushConfigured();
  return publicKey;
}

// --- Subscription storage ---------------------------------------------------
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  scenario_ids_json: string;
}

export function upsertSubscription(sub: PushSubscriptionInput, scenarioIds: number[]): void {
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, scenario_ids_json, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         scenario_ids_json = excluded.scenario_ids_json,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, JSON.stringify(scenarioIds));
}

export function deleteSubscription(endpoint: string): void {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

// Returns the scenario ids this endpoint is subscribed to, or null if the
// endpoint isn't registered at all.
export function getSubscriptionScenarioIds(endpoint: string): number[] | null {
  const row = getDb()
    .prepare('SELECT scenario_ids_json FROM push_subscriptions WHERE endpoint = ?')
    .get(endpoint) as { scenario_ids_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.scenario_ids_json) as number[];
  } catch {
    return [];
  }
}

// --- Sending ----------------------------------------------------------------
async function sendToRow(row: SubRow, payload: object): Promise<void> {
  ensurePushConfigured();
  const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e: unknown) {
    // 404/410 mean the browser dropped the subscription — prune it so we don't
    // keep retrying a dead endpoint.
    const status = (e as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) {
      getDb().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    }
  }
}

export async function sendTestToEndpoint(endpoint: string): Promise<boolean> {
  const row = getDb()
    .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
    .get(endpoint) as SubRow | undefined;
  if (!row) return false;
  await sendToRow(row, {
    title: 'Test notification',
    body: 'Scenario failure alerts are working ✅',
    url: '/runs',
  });
  return true;
}

// Called by the runner when a scenario run finishes as 'failed'. Fire-and-forget
// (never let a push error affect the run). Only browsers that opted in for this
// scenario id are notified.
export async function notifyScenarioFailure(
  scenario: { id: number; name: string },
  runId: number,
): Promise<void> {
  try {
    const rows = getDb().prepare('SELECT * FROM push_subscriptions').all() as SubRow[];
    const targets = rows.filter((r) => {
      try {
        return (JSON.parse(r.scenario_ids_json) as number[]).includes(scenario.id);
      } catch {
        return false;
      }
    });
    if (targets.length === 0) return;
    const payload = {
      title: `Scenario failed: ${scenario.name}`,
      body: `Run #${runId} failed — tap to view.`,
      url: '/runs',
      scenarioId: scenario.id,
      runId,
    };
    await Promise.all(targets.map((r) => sendToRow(r, payload)));
  } catch {
    /* never throw into the run */
  }
}

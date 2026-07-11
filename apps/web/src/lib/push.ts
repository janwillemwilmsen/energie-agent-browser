import { api } from './api.js';

// VAPID public keys are base64url; PushManager wants a BufferSource. Back the
// view with an explicit ArrayBuffer so the type is Uint8Array<ArrayBuffer>
// (not Uint8Array<ArrayBufferLike>, which recent lib.dom rejects as BufferSource).
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  const reg = existing ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  return reg;
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// Subscribe this browser (creating the SW registration + push subscription if
// needed) and register it server-side with the chosen scenario ids. Returns the
// subscription's endpoint so the caller can query/report status.
export async function enablePush(
  scenarioIds: number[],
  successScenarioIds: number[],
): Promise<string> {
  if (!pushSupported()) throw new Error('This browser does not support push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }
  const reg = await ensureRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api.pushVapidKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  await api.pushSubscribe({
    subscription: {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    },
    scenarioIds,
    successScenarioIds,
  });
  return sub.endpoint;
}

// Update the selected scenarios for the already-subscribed browser.
export async function saveScenarioSelection(
  scenarioIds: number[],
  successScenarioIds: number[],
): Promise<void> {
  const sub = await getExistingSubscription();
  if (!sub) {
    // Not subscribed yet — treat as a fresh enable.
    await enablePush(scenarioIds, successScenarioIds);
    return;
  }
  const json = sub.toJSON();
  await api.pushSubscribe({
    subscription: {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    },
    scenarioIds,
    successScenarioIds,
  });
}

export async function disablePush(): Promise<void> {
  const sub = await getExistingSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

export async function sendTestNotification(): Promise<void> {
  const sub = await getExistingSubscription();
  if (!sub) throw new Error('Enable notifications first.');
  await api.pushTest(sub.endpoint);
}

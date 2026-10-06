import { cdpApiBase, type BackendKind, type BrowserBackend } from './backend.js';

// What a hosted browser provider will tell us about the account behind an API
// key. None of them exposes a credit balance or remaining budget over their
// API (that lives in their dashboards, hence the links), so this reports what
// they do expose — plan, concurrency, usage so far — as plain label/value
// facts the admin page lists under the backend.

export interface AccountFact {
  label: string;
  value: string;
}

export interface ProviderAccount {
  kind: BackendKind;
  checkedAt: string;
  ok: boolean;
  dashboardUrl: string | null;
  facts: AccountFact[];
  /** Why there are no facts (no key, API error, …); null when ok. */
  error: string | null;
}

const TIMEOUT_MS = 8_000;

/** Where to look at usage/billing for each backend; null when there is nowhere to go. */
export function dashboardUrl(backend: BrowserBackend): string | null {
  switch (backend.kind) {
    case 'local': return null;
    case 'cdp': return /browserless\.io$/i.test(safeHost(backend.url)) ? 'https://account.browserless.io/' : null;
    case 'browserless-cloud': return 'https://account.browserless.io/';
    case 'browserbase': return 'https://www.browserbase.com/overview';
    case 'kernel': return 'https://dashboard.onkernel.com/';
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: controller.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    return JSON.parse(text);
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : (e?.message ?? String(e)));
  } finally {
    clearTimeout(timer);
  }
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (v: number | null, unit = '') => (v == null ? '—' : `${v.toLocaleString('en-US')}${unit}`);

// browserless `/pressure`: live load of the instance (works on browserless.io
// and self-hosted). Usage/units are dashboard-only.
async function browserlessFacts(httpBase: string, token: string): Promise<AccountFact[]> {
  const json = (await getJson(`${httpBase}/pressure?token=${encodeURIComponent(token)}`)) as { pressure?: Record<string, unknown> };
  const p = json.pressure ?? {};
  return [
    { label: 'Running / max concurrent', value: `${fmt(n(p.running))} / ${fmt(n(p.maxConcurrent))}` },
    { label: 'Queued / max queued', value: `${fmt(n(p.queued))} / ${fmt(n(p.maxQueued))}` },
    { label: 'Available', value: p.isAvailable === false ? 'no' : 'yes' },
  ];
}

// Browserbase: projects carry the concurrency limit; usage is minutes and
// proxy bytes for the current billing period.
async function browserbaseFacts(apiKey: string): Promise<AccountFact[]> {
  const headers = { 'X-BB-API-Key': apiKey };
  const projects = (await getJson('https://api.browserbase.com/v1/projects', headers)) as Array<{ id: string; name: string; concurrency?: number }>;
  const facts: AccountFact[] = [];
  for (const p of projects.slice(0, 5)) {
    const usage = (await getJson(`https://api.browserbase.com/v1/projects/${encodeURIComponent(p.id)}/usage`, headers)) as { browserMinutes?: number; proxyBytes?: number };
    const prefix = projects.length > 1 ? `${p.name}: ` : '';
    facts.push({ label: `${prefix}Browser minutes used`, value: fmt(n(usage.browserMinutes), ' min') });
    facts.push({ label: `${prefix}Proxy data used`, value: fmt(n(usage.proxyBytes) != null ? Math.round(usage.proxyBytes! / 1_048_576) : null, ' MB') });
    facts.push({ label: `${prefix}Max concurrent sessions`, value: fmt(n(p.concurrency)) });
  }
  if (!facts.length) facts.push({ label: 'Projects', value: 'none' });
  return facts;
}

// Kernel: plan + concurrency from the org endpoints. No spend/credit field.
async function kernelFacts(apiKey: string): Promise<AccountFact[]> {
  const headers = { authorization: `Bearer ${apiKey}` };
  const [ent, lim] = await Promise.all([
    getJson('https://api.onkernel.com/org/entitlements', headers) as Promise<{ plan?: { id?: string; effective_id?: string; is_trialing?: boolean }; limits?: { max_concurrent_browsers?: number } }>,
    getJson('https://api.onkernel.com/org/limits', headers) as Promise<{ concurrent_sessions_used?: number | null; concurrent_sessions_available?: number | null; max_concurrent_sessions?: number }>,
  ]);
  const plan = ent.plan ?? {};
  return [
    { label: 'Plan', value: `${plan.id ?? '—'}${plan.is_trialing ? ' (trial)' : ''}` },
    { label: 'Sessions in use / available', value: `${fmt(n(lim.concurrent_sessions_used))} / ${fmt(n(lim.concurrent_sessions_available))}` },
    { label: 'Max concurrent browsers', value: fmt(n(lim.max_concurrent_sessions) ?? n(ent.limits?.max_concurrent_browsers)) },
  ];
}

export async function providerAccount(backend: BrowserBackend): Promise<ProviderAccount> {
  const base: Omit<ProviderAccount, 'ok' | 'facts' | 'error'> = {
    kind: backend.kind,
    checkedAt: new Date().toISOString(),
    dashboardUrl: dashboardUrl(backend),
  };
  const fail = (error: string): ProviderAccount => ({ ...base, ok: false, facts: [], error });
  try {
    switch (backend.kind) {
      case 'local':
        return fail('nothing to check for a local browser');
      case 'cdp':
        if (!backend.url) return fail('no URL configured');
        return { ...base, ok: true, error: null, facts: await browserlessFacts(cdpApiBase(backend.url), backend.token) };
      case 'browserless-cloud':
        if (!backend.apiKey) return fail('no API key configured');
        return { ...base, ok: true, error: null, facts: await browserlessFacts(backend.apiUrl.replace(/\/+$/, ''), backend.apiKey) };
      case 'browserbase':
        if (!backend.apiKey) return fail('no API key configured');
        return { ...base, ok: true, error: null, facts: await browserbaseFacts(backend.apiKey) };
      case 'kernel':
        if (!backend.apiKey) return fail('no API key configured');
        return { ...base, ok: true, error: null, facts: await kernelFacts(backend.apiKey) };
    }
  } catch (e: any) {
    return fail(e?.message ?? String(e));
  }
}

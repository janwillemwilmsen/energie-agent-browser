import { getSetting, setSetting } from '../settings.js';
import { currentModel } from '../agent/scenarioAgent.js';

// Streaming chat completions through the Vercel AI Gateway (OpenAI-compatible
// /v1/chat/completions with `stream: true`), with multimodal content parts —
// the Ask page sends run screenshots as image_url data URIs.
//
// The scenario builder in agent/scenarioAgent.ts keeps its own tiny
// non-streaming call: it wants one short action per turn, while Ask wants a
// long review streamed to the browser.

const GATEWAY_URL = (process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh').replace(/\/+$/, '');
const ASK_MODEL_SETTING_KEY = 'ask_model';

// Ask's model: its own admin setting, else whatever the AI task agent uses.
// Reviews want a multimodal model with a large context; the default chain
// (sonnet) qualifies.
export function askModel(): { model: string; source: 'setting' | 'agent' } {
  const own = getSetting(ASK_MODEL_SETTING_KEY);
  if (own) return { model: own, source: 'setting' };
  return { model: currentModel().model, source: 'agent' };
}

export function setAskModelSetting(model: string | null): void {
  setSetting(ASK_MODEL_SETTING_KEY, model?.trim() || null);
}

export interface GatewayModel {
  id: string;
  name: string;
  /** Accepts image input — a hard requirement for reviewing screenshots. */
  vision: boolean;
  contextWindow: number | null;
}

// The gateway's catalog, reduced to what the Ask model picker needs. Cached
// briefly: the list is ~400 entries and changes rarely.
let modelsCache: { at: number; models: GatewayModel[] } | null = null;
const MODELS_TTL_MS = 10 * 60_000;

export async function listGatewayModelsDetailed(): Promise<GatewayModel[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
  const res = await fetch(`${GATEWAY_URL}/v1/models`, {
    headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
  });
  if (!res.ok) throw new Error(`gateway /v1/models: ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id?: string; name?: string; context_window?: number; modalities?: { input?: string[] } }>;
  };
  const models = (json.data ?? [])
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id!,
      name: m.name ?? m.id!,
      vision: (m.modalities?.input ?? []).includes('image'),
      contextWindow: m.context_window ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelsCache = { at: Date.now(), models };
  return models;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamEvent {
  delta?: string;
  usage?: Usage;
  done?: boolean;
}

/**
 * Stream a completion. Yields text deltas as they arrive and, at the end, the
 * usage block when the gateway reports one (requested via stream_options).
 * `signal` aborts the upstream request when the browser goes away.
 */
export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is not configured on the server');
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI gateway ${res.status}: ${text.slice(0, 300)}`);
  }

  // SSE frames: "data: {json}\n\n" … "data: [DONE]".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage: Usage | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) throw new Error(`AI gateway: ${json.error.message ?? JSON.stringify(json.error)}`);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield { delta };
      if (json.usage) usage = json.usage;
    }
  }
  yield { usage, done: true };
}

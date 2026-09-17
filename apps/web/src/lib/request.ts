// The request core behind every API call: JSON in/out, one error shape, and
// session-expiry detection. Endpoint thunks in api.ts are thin on purpose;
// everything a caller must know about talking to the server lives here.

export interface ApiErrorIssue {
  path: string;
  message: string;
}

/**
 * Every failed request rejects with one of these. `message` is what a page
 * shows: the server's own message when it sent one, else a readable line for
 * a known code, else the HTTP status text.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The server's error code (`not_found`, `validation_error`, …) or the status text. */
  readonly code: string;
  readonly issues: ApiErrorIssue[];

  constructor(status: number, code: string, message: string, issues: ApiErrorIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

const KNOWN_CODES: Record<string, string> = {
  not_found: 'Not found.',
  unauthenticated: 'Your session has expired. Please log in again.',
  invalid_credentials: 'Incorrect login or passphrase.',
  validation_error: 'The request was invalid.',
  internal_error: 'The server hit an unexpected error.',
};

/** Build the ApiError for a failed response, reading the body once. */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const code = typeof body?.error === 'string' ? body.error : res.statusText || `http_${res.status}`;
  const serverMessage =
    typeof body?.message === 'string' ? body.message
    : typeof body?.detail === 'string' ? body.detail
    : null;
  const message =
    serverMessage
    ?? KNOWN_CODES[code]
    ?? (body ? `${res.status} ${res.statusText} (${code})` : text ? `${res.status} ${res.statusText} — ${text}` : `${res.status} ${res.statusText}`);
  const issues = Array.isArray(body?.issues)
    ? (body.issues as unknown[]).flatMap((i) =>
        i && typeof i === 'object' && typeof (i as any).message === 'string'
          ? [{ path: String((i as any).path ?? ''), message: String((i as any).message) }]
          : [],
      )
    : [];
  return new ApiError(res.status, code, message, issues);
}

// --- Session expiry ---------------------------------------------------------------

type Listener = () => void;
const unauthenticatedListeners = new Set<Listener>();

/**
 * Subscribe to "the session is no longer valid": fired when any non-auth
 * endpoint answers 401. The app shell uses it to fall back to the login gate.
 * Returns the unsubscribe function.
 */
export function onUnauthenticated(listener: Listener): () => void {
  unauthenticatedListeners.add(listener);
  return () => unauthenticatedListeners.delete(listener);
}

function isAuthEndpoint(url: string): boolean {
  return url.startsWith('/api/auth/');
}

function noteFailure(url: string, err: ApiError): void {
  if (err.status === 401 && !isAuthEndpoint(url)) {
    for (const l of unauthenticatedListeners) l();
  }
}

// --- Requests ------------------------------------------------------------------------

/**
 * Fetch and return the raw Response, rejecting with an ApiError for any
 * non-2xx status. For callers that need headers or binary bodies.
 */
export async function requestRaw(url: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  // Only declare a JSON body when we're actually sending one — Fastify rejects
  // an empty body with Content-Type: application/json as 400 Bad Request.
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const err = await errorFromResponse(res);
    noteFailure(url, err);
    throw err;
  }
  return res;
}

/** Fetch JSON. A 204 resolves to undefined. */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await requestRaw(url, init);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** The message to show for anything thrown by a request or a page. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

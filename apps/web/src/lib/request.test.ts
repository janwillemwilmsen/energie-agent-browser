import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError, onUnauthenticated, request, requestRaw } from './request.js';

// A scripted fetch: the next response the core will see.
function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const res = new Response(status === 204 ? null : text, {
    status,
    statusText: { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 500: 'Internal Server Error' }[status] ?? '',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  const spy = vi.fn(async () => res);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('request core', () => {
  it('returns parsed JSON and sends a JSON content type only with a body', async () => {
    const spy = respond(200, { ok: 1 });
    await expect(request('/api/x')).resolves.toEqual({ ok: 1 });
    expect((spy.mock.calls[0] as any)[1].headers['Content-Type']).toBeUndefined();
    respond(200, { ok: 2 });
    await request('/api/x', { method: 'POST', body: '{}' });
    const spy2 = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect((spy2.mock.calls[0] as any)[1].headers['Content-Type']).toBe('application/json');
  });

  it('resolves undefined for 204', async () => {
    respond(204, '');
    await expect(request('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('maps a server error body to one ApiError shape', async () => {
    respond(400, {
      error: 'validation_error',
      message: 'name: Required',
      issues: [{ path: 'name', message: 'Required' }],
    });
    const err = (await request('/api/x').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation_error', message: 'name: Required' });
    expect(err.issues).toEqual([{ path: 'name', message: 'Required' }]);
  });

  it('gives a readable message for a bare code, and keeps the status text otherwise', async () => {
    respond(404, { error: 'not_found' });
    await expect(request('/api/x')).rejects.toMatchObject({ code: 'not_found', message: 'Not found.' });
    respond(404, { error: 'unknown_scenario', scenario_id: 3 });
    await expect(request('/api/x')).rejects.toMatchObject({ message: '404 Not Found (unknown_scenario)' });
    respond(500, 'boom', { 'Content-Type': 'text/plain' });
    await expect(request('/api/x')).rejects.toMatchObject({ message: '500 Internal Server Error — boom' });
  });

  it('notifies subscribers on a 401 from a non-auth endpoint only', async () => {
    const seen = vi.fn();
    const off = onUnauthenticated(seen);
    respond(401, { error: 'invalid_credentials' });
    await request('/api/auth/login', { method: 'POST', body: '{}' }).catch(() => undefined);
    expect(seen).not.toHaveBeenCalled();
    respond(401, { error: 'unauthenticated' });
    await expect(request('/api/runs')).rejects.toMatchObject({ message: 'Your session has expired. Please log in again.' });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    respond(401, { error: 'unauthenticated' });
    await request('/api/runs').catch(() => undefined);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('requestRaw hands back the Response for binary callers', async () => {
    respond(200, 'zipbytes', { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="a.zip"' });
    const res = await requestRaw('/api/screenshots/zip', { method: 'POST', body: '{}' });
    expect(res.headers.get('Content-Disposition')).toContain('a.zip');
  });
});

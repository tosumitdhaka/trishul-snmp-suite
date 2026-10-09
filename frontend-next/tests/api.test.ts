import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, ApiError, setUnauthorizedHandler } from '../src/lib/api/client';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});
describe('shared API client', () => {
  it('never allows an off-origin API path', async () => {
    await expect(apiRequest('https://malicious.example/api/status', 'token')).rejects.toThrow('/api/');
    await expect(apiRequest('//malicious.example/api/status', 'token')).rejects.toThrow('/api/');
  });
  it('injects the existing auth header and preserves FormData compatibility', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', mock);
    await expect(apiRequest<{ ok: boolean }>('/api/stats/', 'secret')).resolves.toEqual({ ok: true });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Auth-Token')).toBe('secret');
    expect(headers.get('Content-Type')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });
  it('signals 401 for the active token and returns typed errors', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Expired' }), { status: 401 })));
    await expect(apiRequest('/api/settings/check', 'expired-token')).rejects.toMatchObject({
      name: 'ApiError', message: 'Expired', status: 401,
    } satisfies Partial<ApiError>);
    expect(unauthorized).toHaveBeenCalledWith('expired-token');
  });
});

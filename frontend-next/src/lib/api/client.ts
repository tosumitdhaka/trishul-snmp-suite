export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}
let unauthorizedHandler: ((token: string) => void) | null = null;
export function setUnauthorizedHandler(callback: ((token: string) => void) | null) {
  unauthorizedHandler = callback;
}
function validatePath(path: string) {
  if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('://')
      || path.includes('\\') || /[\r\n]/.test(path)) {
    throw new Error('API requests must use a local /api/ path');
  }
}
export async function apiRequest<T>(
  path: string,
  token: string | null,
  init: RequestInit = {},
): Promise<T> {
  validatePath(path);
  const headers = new Headers(init.headers);
  if (token) headers.set('X-Auth-Token', token);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401 && token && path !== '/api/settings/login') {
    unauthorizedHandler?.(token);
  }
  if (!response.ok) {
    let detail = 'Request failed (' + response.status + ')';
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'detail' in body) {
        const value = (body as { detail: unknown }).detail;
        if (typeof value === 'string') detail = value;
      }
    } catch { /* Keep a generic error for a non-JSON response. */ }
    throw new ApiError(detail, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

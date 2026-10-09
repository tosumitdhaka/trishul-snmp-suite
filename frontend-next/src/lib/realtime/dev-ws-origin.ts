/**
 * Shared by Vite's development proxy and the browser socket selector so
 * opting into direct mode cannot leave the two sides configured differently.
 * Never send a session token to a non-loopback endpoint.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function getSafeDirectWsOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (!isLoopbackHost(origin.hostname)) return null;
    if (origin.protocol !== 'ws:' && origin.protocol !== 'wss:') return null;
    // 5173 is the Vite development server, not a separate FastAPI origin.
    if (!origin.port || origin.port === '5173') return null;
    if (origin.pathname !== '/' || origin.search || origin.hash) return null;
    if (origin.username || origin.password) return null;
    return origin;
  } catch {
    return null;
  }
}

import type { QueryClient } from '@tanstack/react-query';
import { parseRealtimeEvent, type RealtimeEvent } from '../api/types';
import { getSafeDirectWsOrigin, isLoopbackHost } from './dev-ws-origin';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'unauthorized';

export function applyRealtimeUpdate(cache: QueryClient, event: RealtimeEvent) {
  switch (event.type) {
    case 'full_state':
      if (event.simulator) cache.setQueryData(['simulator', 'status'], event.simulator);
      if (event.traps) cache.setQueryData(['traps', 'status'], event.traps);
      if (event.stats) cache.setQueryData(['stats'], event.stats);
      if (event.mibs) cache.setQueryData(['mibs', 'summary'], event.mibs);
      break;
    case 'status':
      if (event.simulator) cache.setQueryData(['simulator', 'status'], event.simulator);
      if (event.traps) cache.setQueryData(['traps', 'status'], event.traps);
      break;
    case 'stats':
      if (event.stats) cache.setQueryData(['stats'], event.stats);
      break;
    case 'mibs':
      if (event.mibs) cache.setQueryData(['mibs', 'summary'], event.mibs);
      break;
    case 'trap':
      void cache.invalidateQueries({ queryKey: ['traps', 'history'] });
      break;
    case 'simulator_log':
      // Streaming logs receive a separate bounded feed in the Simulator slice.
      break;
    case 'reauth_required':
      break;
  }
}

export function handleRealtimePayload(cache: QueryClient, raw: string): RealtimeEvent | null {
  try {
    const event = parseRealtimeEvent(JSON.parse(raw) as unknown);
    if (event) applyRealtimeUpdate(cache, event);
    return event;
  } catch {
    return null;
  }
}

export interface SocketEndpointOptions {
  /** Diagnostic only: never override WebSocket origin in a production bundle. */
  development?: boolean;
  directWsOrigin?: string;
}

/**
 * The normal socket is same-origin via Vite's /api proxy.
 * For isolating proxy failures, local development can opt into a DIRECT,
 * loopback-only WebSocket connection to an existing FastAPI instance.
 * Never allow a token-bearing URL to be directed to an arbitrary host.
 */
export function socketEndpoint(
  token: string,
  location: Pick<Location, 'protocol' | 'host'>,
  options: SocketEndpointOptions = {},
): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sameOrigin = new URL(protocol + '//' + location.host + '/api/ws');
  let endpoint = sameOrigin;

  if (options.development && options.directWsOrigin && location.protocol === 'http:') {
    try {
      const browserHost = new URL('http://' + location.host).hostname;
      const direct = getSafeDirectWsOrigin(options.directWsOrigin);
      if (isLoopbackHost(browserHost) && direct) {
        endpoint = new URL('/api/ws', direct);
      }
    } catch {
      // Invalid or unsafe overrides quietly fall back to the same-origin proxy.
    }
  }

  endpoint.searchParams.set('token', token);
  return endpoint.toString();
}

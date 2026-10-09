import type { QueryClient } from '@tanstack/react-query';
import { parseRealtimeEvent, type RealtimeEvent } from '../api/types';

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

export function socketEndpoint(token: string, location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(protocol + '//' + location.host + '/api/ws');
  url.searchParams.set('token', token);
  return url.toString();
}

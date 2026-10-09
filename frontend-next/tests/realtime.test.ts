import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { handleRealtimePayload, socketEndpoint } from '../src/lib/realtime/realtime';

describe('live backend events', () => {
  it('ignores malformed or unknown messages', () => {
    const cache = new QueryClient();
    expect(handleRealtimePayload(cache, '{')).toBeNull();
    expect(handleRealtimePayload(cache, '{"type":"secret_event"}')).toBeNull();
  });
  it('updates relevant cached state from full_state and stats events', () => {
    const cache = new QueryClient();
    handleRealtimePayload(cache, '{"type":"full_state","simulator":{"running":true},"mibs":{"loaded":7}}');
    expect(cache.getQueryData(['simulator', 'status'])).toEqual({ running: true });
    expect(cache.getQueryData(['mibs', 'summary'])).toEqual({ loaded: 7 });
    handleRealtimePayload(cache, '{"type":"stats","stats":{"walker":{"walks_executed":3}}}');
    expect(cache.getQueryData(['stats'])).toEqual({ walker: { walks_executed: 3 } });
  });
  it('uses the existing token-bearing websocket handshake on both protocols', () => {
    expect(socketEndpoint('a &b', { protocol: 'https:', host: 'trishul.example' }))
      .toBe('wss://trishul.example/api/ws?token=a+%26b');
    expect(socketEndpoint('x', { protocol: 'http:', host: '127.0.0.1:8980' }))
      .toBe('ws://127.0.0.1:8980/api/ws?token=x');
  });
});

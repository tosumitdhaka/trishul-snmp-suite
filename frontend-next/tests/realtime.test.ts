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
  it('supports explicit local-only direct WebSocket isolation in development', () => {
    const local = { protocol: 'http:', host: '127.0.0.1:5173' };
    const opts = { development: true, directWsOrigin: 'ws://127.0.0.1:8980' };
    expect(socketEndpoint('demo', local, opts))
      .toBe('ws://127.0.0.1:8980/api/ws?token=demo');
    expect(socketEndpoint('demo', local, { ...opts, development: false }))
      .toBe('ws://127.0.0.1:5173/api/ws?token=demo');
    expect(socketEndpoint('demo', { protocol: 'https:', host: '127.0.0.1:5173' }, opts))
      .toBe('wss://127.0.0.1:5173/api/ws?token=demo');
    expect(socketEndpoint('demo', { protocol: 'http:', host: 'example.com' }, opts))
      .toBe('ws://example.com/api/ws?token=demo');
  });
  it('never forwards a session token to an arbitrary or malformed WebSocket origin', () => {
    const local = { protocol: 'http:', host: 'localhost:5173' };
    for (const unsafe of [
      'ws://example.com:8980',
      'ws://127.0.0.1:8980/surprise',
      'ws://user:password@127.0.0.1:8980',
      'ws://127.0.0.1:8980?debug=true',
      'https://127.0.0.1:8980',
      'not-a-valid-url',
    ]) {
      expect(socketEndpoint('sensitive', local, { development: true, directWsOrigin: unsafe }))
        .toBe('ws://localhost:5173/api/ws?token=sensitive');
    }
  });

  it('uses the existing token-bearing websocket handshake on both protocols', () => {
    expect(socketEndpoint('a &b', { protocol: 'https:', host: 'trishul.example' }))
      .toBe('wss://trishul.example/api/ws?token=a+%26b');
    expect(socketEndpoint('x', { protocol: 'http:', host: '127.0.0.1:8980' }))
      .toBe('ws://127.0.0.1:8980/api/ws?token=x');
  });
});

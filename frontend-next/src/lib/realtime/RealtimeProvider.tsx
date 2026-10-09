import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { handleRealtimePayload, socketEndpoint, type ConnectionState } from './realtime';

const RealtimeContext = createContext<ConnectionState>('offline');
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { auth, expire } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const cache = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (!token) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    function stopTimers() {
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      pingTimer = undefined;
      pongTimer = undefined;
    }
    function connect() {
      if (disposed) return;
      setConnection(delay === 1_000 ? 'connecting' : 'reconnecting');
      // URL is deliberately never written to logs (it contains a session token).
      const current = new WebSocket(socketEndpoint(token!, window.location));
      socket = current;
      current.onopen = () => {
        if (disposed || socket !== current) return;
        delay = 1_000;
        setConnection('live');
        void cache.invalidateQueries({ queryKey: ['stats'] });
        stopTimers();
        pingTimer = setInterval(() => {
          if (current.readyState !== WebSocket.OPEN) return;
          current.send('ping');
          if (pongTimer) clearTimeout(pongTimer);
          pongTimer = setTimeout(() => current.close(4000, 'pong timeout'), PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
      };
      current.onmessage = ({ data }: MessageEvent<string>) => {
        if (disposed || socket !== current) return;
        if (data === 'pong') {
          if (pongTimer) clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        }
        const event = handleRealtimePayload(cache, data);
        if (event?.type === 'reauth_required') expire(token!);
      };
      current.onclose = (event) => {
        if (disposed || socket !== current) return;
        stopTimers();
        socket = null;
        if (event.code === 4001) {
          setConnection('unauthorized');
          expire(token!);
          return;
        }
        setConnection('reconnecting');
        retryTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      };
      current.onerror = () => {
        // onclose handles reconnect; do not expose a token-bearing URL.
      };
    }
    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopTimers();
      socket?.close(1000, 'leaving preview');
    };
  }, [token, cache, expire]);
  return <RealtimeContext.Provider value={connection}>{children}</RealtimeContext.Provider>;
}
export function useRealtime() {
  return useContext(RealtimeContext);
}

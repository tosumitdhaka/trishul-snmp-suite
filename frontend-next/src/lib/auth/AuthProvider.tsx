import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest, setUnauthorizedHandler } from '../api/client';
import type { LoginResult, UserSession } from '../api/types';

const TOKEN_KEY = 'snmp_token';
const NAME_KEY = 'snmp_username';
type Session = { token: string; username: string };
type AuthState = { state: 'checking' } | { state: 'anonymous' } | ({ state: 'authenticated' } & Session);
interface AuthContextValue {
  auth: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  expire: (token: string) => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);

function readToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function persistSession(session: Session) {
  try {
    sessionStorage.setItem(TOKEN_KEY, session.token);
    sessionStorage.setItem(NAME_KEY, session.username);
  } catch { /* Auth remains usable in memory if storage is unavailable. */ }
}
function forgetSession() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(NAME_KEY);
  } catch { /* Storage can be blocked. */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState<AuthState>({ state: 'checking' });
  const activeToken = useRef<string | null>(null);
  const reset = useCallback(() => {
    activeToken.current = null;
    forgetSession();
    void queryClient.cancelQueries();
    queryClient.clear();
    setAuth({ state: 'anonymous' });
  }, [queryClient]);
  const expire = useCallback((token: string) => {
    if (token && activeToken.current === token) reset();
  }, [reset]);

  useEffect(() => {
    setUnauthorizedHandler(expire);
    return () => setUnauthorizedHandler(null);
  }, [expire]);

  useEffect(() => {
    const saved = readToken();
    if (!saved) {
      setAuth({ state: 'anonymous' });
      return;
    }
    activeToken.current = saved;
    const controller = new AbortController();
    void apiRequest<UserSession>('/api/settings/check', saved, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted || activeToken.current !== saved) return;
        setAuth({ state: 'authenticated', token: saved, username: response.user || 'Operator' });
      })
      .catch(() => {
        if (!controller.signal.aborted && activeToken.current === saved) reset();
      });
    return () => controller.abort();
  }, [reset]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiRequest<LoginResult>('/api/settings/login', null, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!result.token || !result.username) throw new Error('Incomplete authentication response');
    reset();
    activeToken.current = result.token;
    persistSession({ token: result.token, username: result.username });
    setAuth({ state: 'authenticated', token: result.token, username: result.username });
  }, [reset]);

  const logout = useCallback(async () => {
    const token = activeToken.current;
    reset(); // Fail-closed locally even if the server cannot be reached.
    if (token) {
      try { await apiRequest('/api/settings/logout', token, { method: 'POST' }); }
      catch { /* Session removed locally; remote session will expire independently. */ }
    }
  }, [reset]);

  return <AuthContext.Provider value={{ auth, login, logout, expire }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

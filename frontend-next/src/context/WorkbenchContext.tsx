import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  clearStoredSession,
  getStoredToken,
  getStoredUsername,
  setStoredSession,
  setUnauthorizedHandler,
} from '../lib/api';
import { appendBatchedSimulatorLog, normalizeSimulatorLog } from '../lib/workbench';
import type {
  AppMeta,
  MibSummary,
  ReceivedTrapEvent,
  SimulatorLogEntry,
  SimulatorStatus,
  StatsSnapshot,
  TrapReceiverStatus,
  WorkbenchHandoff,
  WorkspaceId,
} from '../types/api';

export type ThemeMode = 'light' | 'dark';
export type WsStatus = 'connecting' | 'online' | 'offline';

export interface ToastItem {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'warning' | 'info';
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface WorkbenchContextValue {
  // Meta & Theme
  meta: AppMeta | null;
  theme: ThemeMode;
  toggleTheme: () => void;

  // Auth
  authChecking: boolean;
  authenticated: boolean;
  username: string;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;

  // Navigation & Cross-workspace handoffs
  activeWorkspace: WorkspaceId;
  navigate: (workspace: WorkspaceId, handoff?: WorkbenchHandoff) => void;
  handoff: WorkbenchHandoff | null;
  clearHandoff: () => void;
  paletteOpen: boolean;
  setPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Realtime telemetry
  wsStatus: WsStatus;
  simulatorStatus: SimulatorStatus | null;
  trapStatus: TrapReceiverStatus | null;
  mibSummary: MibSummary | null;
  stats: StatsSnapshot | null;
  simulatorLogs: SimulatorLogEntry[];
  recentTraps: ReceivedTrapEvent[];
  trapsPaused: boolean;
  setTrapsPaused: React.Dispatch<React.SetStateAction<boolean>>;
  refreshLiveState: () => Promise<void>;
  clearLocalSimulatorLogs: () => void;
  setRecentTraps: React.Dispatch<React.SetStateAction<ReceivedTrapEvent[]>>;

  // Feedback
  toasts: ToastItem[];
  notify: (message: string, tone?: ToastItem['tone']) => void;
  dismissToast: (id: number) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmState: ConfirmState | null;
  resolveConfirm: (result: boolean) => void;
}

const VALID_WORKSPACES: WorkspaceId[] = [
  'overview',
  'simulator',
  'walker',
  'traps',
  'browser',
  'mibs',
  'settings',
];

function workspaceFromLocation(): WorkspaceId {
  const path = window.location.pathname.replace(/^\/(?:next\/?)?/, '').replace(/\/+$/, '');
  const segment = path.split('/')[0] as WorkspaceId;
  if (VALID_WORKSPACES.includes(segment)) return segment;
  const hash = window.location.hash.replace(/^#/, '') as WorkspaceId;
  if (hash === ('dashboard' as unknown as WorkspaceId)) return 'overview';
  if (VALID_WORKSPACES.includes(hash)) return hash;
  return 'overview';
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export const WorkbenchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      return localStorage.getItem('trishul_theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState<string>(() => getStoredUsername());

  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>(() => workspaceFromLocation());
  const [handoff, setHandoff] = useState<WorkbenchHandoff | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [simulatorStatus, setSimulatorStatus] = useState<SimulatorStatus | null>(null);
  const [trapStatus, setTrapStatus] = useState<TrapReceiverStatus | null>(null);
  const [mibSummary, setMibSummary] = useState<MibSummary | null>(null);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [simulatorLogs, setSimulatorLogs] = useState<SimulatorLogEntry[]>([]);
  const [recentTraps, setRecentTraps] = useState<ReceivedTrapEvent[]>([]);
  const [trapsPaused, setTrapsPaused] = useState(false);
  const trapsPausedRef = useRef(false);
  trapsPausedRef.current = trapsPaused;

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(1);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const notify = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = toastSeqRef.current++;
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...options, resolve });
    });
  }, []);

  const resolveConfirm = useCallback((result: boolean) => {
    setConfirmState((current) => {
      if (current) current.resolve(result);
      return null;
    });
  }, []);

  // Sync theme to documentElement & localStorage
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    root.style.colorScheme = theme;
    try {
      localStorage.setItem('trishul_theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // History navigation
  const navigate = useCallback((workspace: WorkspaceId, nextHandoff?: WorkbenchHandoff) => {
    setActiveWorkspace(workspace);
    if (nextHandoff) {
      setHandoff(nextHandoff);
    }
    const targetUrl = workspace === 'overview' ? '/' : `/${workspace}`;
    if (window.location.pathname !== targetUrl) {
      window.history.pushState({ workspace }, '', targetUrl);
    }
  }, []);

  const clearHandoff = useCallback(() => setHandoff(null), []);

  useEffect(() => {
    const onPopState = () => {
      setActiveWorkspace(workspaceFromLocation());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (authenticated) {
          setPaletteOpen((open) => !open);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authenticated]);

  // Unauthorized guard
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearStoredSession();
      setAuthenticated(false);
      setWsStatus('offline');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Boot meta + auth check
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const appMeta = await api.getMeta();
        if (active) setMeta(appMeta);
      } catch {
        // ignore meta fetch error
      }

      const token = getStoredToken();
      if (!token) {
        if (active) {
          setAuthenticated(false);
          setAuthChecking(false);
        }
        return;
      }

      try {
        const res = await api.checkAuth();
        if (active) {
          if (res.authenticated) {
            setAuthenticated(true);
            setUsername(res.username || getStoredUsername());
          } else {
            clearStoredSession();
            setAuthenticated(false);
          }
        }
      } catch {
        if (active) {
          clearStoredSession();
          setAuthenticated(false);
        }
      } finally {
        if (active) setAuthChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const refreshLiveState = useCallback(async () => {
    try {
      const [sim, trp, st, mibs, logsRes, trapsRes] = await Promise.all([
        api.getSimulatorStatus(),
        api.getTrapStatus(),
        api.getStats(),
        api.getMibStatus(),
        api.getSimulatorLogs(200),
        api.listReceivedTraps(100, 0),
      ]);
      setSimulatorStatus(sim);
      setTrapStatus(trp);
      setStats(st);
      const computedTraps =
        mibs.traps_available ??
        (mibs.active_modules || mibs.mibs || []).reduce((sum, m) => sum + (m.traps || 0), 0);
      setMibSummary({
        loaded: mibs.loaded,
        failed: mibs.failed,
        traps_available: computedTraps,
        active_bundle_id: mibs.active_bundle_id,
        producer_version: mibs.producer_version,
        needs_recompile: mibs.needs_recompile ?? mibs.recompile_recommended,
      });
      const rawLogs = logsRes.items || logsRes.logs || [];
      setSimulatorLogs(rawLogs.map((entry) => normalizeSimulatorLog(entry)));
      setRecentTraps(trapsRes.data || trapsRes.traps || []);
    } catch {
      // handled gracefully by individual views & 401 guard
    }
  }, []);

  // Managed WebSocket connection when authenticated
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;

    void refreshLiveState();

    const connect = () => {
      if (disposed) return;
      const token = getStoredToken();
      if (!token) return;
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        if (disposed) return;
        setWsStatus('online');
        pingTimer = window.setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string' || event.data === 'pong') return;
        try {
          const msg = JSON.parse(event.data) as Record<string, unknown>;
          const type = String(msg.type || '');
          if (type === 'full_state') {
            if (msg.simulator) setSimulatorStatus(msg.simulator as SimulatorStatus);
            if (msg.traps) setTrapStatus(msg.traps as TrapReceiverStatus);
            if (msg.stats) setStats(msg.stats as StatsSnapshot);
            if (msg.mibs) setMibSummary(msg.mibs as MibSummary);
          } else if (type === 'status') {
            if (msg.simulator) setSimulatorStatus(msg.simulator as SimulatorStatus);
            if (msg.traps) setTrapStatus(msg.traps as TrapReceiverStatus);
          } else if (type === 'stats') {
            const nextStats = (msg.stats || msg.data) as StatsSnapshot | undefined;
            if (nextStats) setStats(nextStats);
          } else if (type === 'mibs') {
            if (msg.mibs) setMibSummary(msg.mibs as MibSummary);
          } else if (type === 'simulator_log' && msg.entry) {
            setSimulatorLogs((prev) =>
              appendBatchedSimulatorLog(prev, msg.entry as Partial<SimulatorLogEntry>)
            );
          } else if (type === 'trap' && msg.trap) {
            if (!trapsPausedRef.current) {
              const incoming = msg.trap as ReceivedTrapEvent;
              setRecentTraps((prev) => {
                if (prev.some((t) => t.id === incoming.id)) return prev;
                return [incoming, ...prev].slice(0, 250);
              });
            }
          } else if (type === 'reauth_required') {
            clearStoredSession();
            setAuthenticated(false);
            notify('Credentials updated. Please sign in again.', 'warning');
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = (ev) => {
        if (pingTimer) window.clearInterval(pingTimer);
        if (disposed) return;
        setWsStatus('offline');
        if (ev.code === 4001) {
          clearStoredSession();
          setAuthenticated(false);
          return;
        }
        reconnectTimer = window.setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        if (!disposed) setWsStatus('offline');
      };
    };

    connect();

    return () => {
      disposed = true;
      if (pingTimer) window.clearInterval(pingTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, [authenticated, notify, refreshLiveState]);

  const login = useCallback(async (user: string, pass: string) => {
    const res = await api.login(user, pass);
    setStoredSession(res.token, res.username || user);
    setUsername(res.username || user);
    setAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // clear local session regardless
    }
    clearStoredSession();
    setAuthenticated(false);
    setWsStatus('offline');
  }, []);

  const clearLocalSimulatorLogs = useCallback(() => setSimulatorLogs([]), []);

  const value = useMemo<WorkbenchContextValue>(
    () => ({
      meta,
      theme,
      toggleTheme,
      authChecking,
      authenticated,
      username,
      login,
      logout,
      activeWorkspace,
      navigate,
      handoff,
      clearHandoff,
      paletteOpen,
      setPaletteOpen,
      wsStatus,
      simulatorStatus,
      trapStatus,
      mibSummary,
      stats,
      simulatorLogs,
      recentTraps,
      trapsPaused,
      setTrapsPaused,
      refreshLiveState,
      clearLocalSimulatorLogs,
      setRecentTraps,
      toasts,
      notify,
      dismissToast,
      confirm,
      confirmState,
      resolveConfirm,
    }),
    [
      meta,
      theme,
      toggleTheme,
      authChecking,
      authenticated,
      username,
      login,
      logout,
      activeWorkspace,
      navigate,
      handoff,
      clearHandoff,
      paletteOpen,
      wsStatus,
      simulatorStatus,
      trapStatus,
      mibSummary,
      stats,
      simulatorLogs,
      recentTraps,
      trapsPaused,
      refreshLiveState,
      clearLocalSimulatorLogs,
      toasts,
      notify,
      dismissToast,
      confirm,
      confirmState,
      resolveConfirm,
    ]
  );

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
};

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error('useWorkbench must be used within WorkbenchProvider');
  return ctx;
}

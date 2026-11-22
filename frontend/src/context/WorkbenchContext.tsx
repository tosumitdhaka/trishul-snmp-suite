import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  clearStoredSession,
  getStoredToken,
  getStoredUsername,
  setStoredSession,
  setUnauthorizedHandler,
} from '../lib/api';
import { toggleSimulatorService, toggleTrapReceiverService } from '../lib/serviceActions';
import { appendBatchedSimulatorLog, normalizeSimulatorLog } from '../lib/workbench';
import type {
  AppMeta,
  MibSummary,
  ReceivedTrapEvent,
  SimulatorActionResponse,
  SimulatorLogEntry,
  SimulatorStatus,
  StatsSnapshot,
  TrapActionResponse,
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
  invalidateLocalSession: () => void;

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
  mibRefreshVersion: number;
  stats: StatsSnapshot | null;
  simulatorLogs: SimulatorLogEntry[];
  recentTraps: ReceivedTrapEvent[];
  trapsPaused: boolean;
  setTrapsPaused: React.Dispatch<React.SetStateAction<boolean>>;
  refreshLiveState: () => Promise<void>;
  mergeMibSummary: (partial: Partial<MibSummary>) => void;
  clearLocalSimulatorLogs: () => void;
  setRecentTraps: React.Dispatch<React.SetStateAction<ReceivedTrapEvent[]>>;
  toggleSimulator: (override?: { port?: number; community?: string }) => Promise<SimulatorActionResponse>;
  toggleTrapReceiver: (override?: {
    port?: number;
    community?: string;
    resolveMibs?: boolean;
  }) => Promise<TrapActionResponse>;

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

const WORKSPACE_TITLES: Record<WorkspaceId, string> = {
  overview: 'Overview',
  simulator: 'Simulator',
  walker: 'Walk & Parse',
  traps: 'Trap Console',
  browser: 'MIB Browser',
  mibs: 'MIB Manager',
  settings: 'Settings',
};

const WS_PING_INTERVAL_MS = 25000;
const WS_PONG_TIMEOUT_MS = 5000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
const REST_OFFLINE_POLL_MS = 5000;

function workspaceFromLocation(): WorkspaceId {
  const path = window.location.pathname.replace(/^\/(?:next\/?)?/, '').replace(/\/+$/, '');
  const segment = path.split('/')[0] as WorkspaceId;
  if (VALID_WORKSPACES.includes(segment)) return segment;
  const hash = window.location.hash.replace(/^#/, '') as WorkspaceId;
  if (hash === ('dashboard' as unknown as WorkspaceId)) return 'overview';
  if (VALID_WORKSPACES.includes(hash)) return hash;
  return 'overview';
}

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('trishul_theme');
    if (saved === 'dark' || saved === 'light') return saved;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // ignore storage/media errors
  }
  return 'light';
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export const WorkbenchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

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
  const [mibRefreshVersion, setMibRefreshVersion] = useState(0);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [simulatorLogs, setSimulatorLogs] = useState<SimulatorLogEntry[]>([]);
  const [recentTraps, setRecentTraps] = useState<ReceivedTrapEvent[]>([]);
  const [trapsPaused, setTrapsPaused] = useState(false);
  const trapsPausedRef = useRef(false);
  trapsPausedRef.current = trapsPaused;

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(1);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const clearTelemetryState = useCallback(() => {
    setSimulatorStatus(null);
    setTrapStatus(null);
    setMibSummary(null);
    setStats(null);
    setSimulatorLogs([]);
    setRecentTraps([]);
    setWsStatus('offline');
  }, []);

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

  // Sync theme across data-theme (trishul-ui), .dark (Tailwind), colorScheme, and localStorage
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
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

  // Sync browser document title with active workspace
  useEffect(() => {
    const workspaceTitle = WORKSPACE_TITLES[activeWorkspace] || 'Workbench';
    const appName = meta?.name || 'Trishul SNMP Suite';
    document.title = `${workspaceTitle} · ${appName}`;
  }, [activeWorkspace, meta]);

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
      clearTelemetryState();
    });
    return () => setUnauthorizedHandler(null);
  }, [clearTelemetryState]);

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
          if (res.status === 'authenticated' && Boolean(res.user)) {
            setStoredSession(token, res.user);
            setAuthenticated(true);
            setUsername(res.user);
          } else {
            clearStoredSession();
            setAuthenticated(false);
          }
        }
      } catch (err) {
        if (active) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            clearStoredSession();
            setAuthenticated(false);
          } else {
            // Preserve stored session on transient network/5xx errors so reconnect can recover
            setAuthenticated(true);
            setUsername(getStoredUsername());
          }
        }
      } finally {
        if (active) setAuthChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const mergeMibSummary = useCallback((partial: Partial<MibSummary>) => {
    setMibSummary((prev) => ({
      loaded: partial.loaded !== undefined ? partial.loaded : prev?.loaded,
      failed: partial.failed !== undefined ? partial.failed : prev?.failed,
      traps_available:
        partial.traps_available !== undefined ? partial.traps_available : prev?.traps_available,
      total: partial.total !== undefined ? partial.total : prev?.total,
      source_files: partial.source_files !== undefined ? partial.source_files : prev?.source_files,
      active_bundle_id:
        partial.active_bundle_id !== undefined ? partial.active_bundle_id : prev?.active_bundle_id,
      active_bundle_key:
        partial.active_bundle_key !== undefined ? partial.active_bundle_key : prev?.active_bundle_key,
      total_objects:
        partial.total_objects !== undefined ? partial.total_objects : prev?.total_objects,
      producer_version:
        partial.producer_version !== undefined ? partial.producer_version : prev?.producer_version,
      missing_capabilities: partial.missing_capabilities ?? prev?.missing_capabilities,
      recompile_recommended:
        partial.recompile_recommended !== undefined
          ? partial.recompile_recommended
          : prev?.recompile_recommended,
      needs_recompile:
        partial.needs_recompile !== undefined
          ? partial.needs_recompile
          : partial.recompile_recommended !== undefined
            ? partial.recompile_recommended
            : prev?.needs_recompile,
    }));
  }, []);

  const refreshLiveState = useCallback(async () => {
    const [simRes, trpRes, stRes, bundleRes, logsRes, trapsRes] = await Promise.allSettled([
      api.getSimulatorStatus(),
      api.getTrapStatus(),
      api.getStats(),
      api.getBundleSummary(),
      api.getSimulatorLogs(200),
      api.listReceivedTraps(100, 0),
    ]);

    if (simRes.status === 'fulfilled') setSimulatorStatus(simRes.value);
    if (trpRes.status === 'fulfilled') setTrapStatus(trpRes.value);
    if (stRes.status === 'fulfilled') setStats(stRes.value);
    if (bundleRes.status === 'fulfilled') {
      const summary = bundleRes.value;
      mergeMibSummary({
        active_bundle_id: summary.active_bundle_id,
        producer_version: summary.producer_version,
        missing_capabilities: summary.missing_capabilities,
        recompile_recommended: summary.recompile_recommended,
        needs_recompile: summary.recompile_recommended,
      });
    }
    if (logsRes.status === 'fulfilled') {
      const rawLogs = logsRes.value.items || logsRes.value.logs || [];
      setSimulatorLogs(rawLogs.map((entry) => normalizeSimulatorLog(entry)));
    }
    if (trapsRes.status === 'fulfilled') {
      setRecentTraps(trapsRes.value.data || trapsRes.value.traps || []);
    }
  }, [mergeMibSummary]);

  // Managed WebSocket connection with 5s pong watchdog & exponential backoff (1s -> 30s)
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let pongTimer: number | null = null;
    let reconnectAttempt = 0;

    const clearHeartbeats = () => {
      if (pingTimer) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongTimer) {
        window.clearTimeout(pongTimer);
        pongTimer = null;
      }
    };

    void refreshLiveState();

    const connect = () => {
      if (disposed) return;
      const token = getStoredToken();
      if (!token) {
        setWsStatus('offline');
        return;
      }
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        if (disposed) return;
        reconnectAttempt = 0;
        setWsStatus('online');
        pingTimer = window.setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send('ping');
              if (pongTimer) window.clearTimeout(pongTimer);
              pongTimer = window.setTimeout(() => {
                if (!disposed && ws && ws.readyState === WebSocket.OPEN) {
                  ws.close(4000, 'Pong timeout');
                }
              }, WS_PONG_TIMEOUT_MS);
            } catch {
              // socket error handled by onclose
            }
          }
        }, WS_PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        if (event.data === 'pong') {
          if (pongTimer) {
            window.clearTimeout(pongTimer);
            pongTimer = null;
          }
          return;
        }
        if (pongTimer) {
          window.clearTimeout(pongTimer);
          pongTimer = null;
        }

        try {
          const msg = JSON.parse(event.data) as Record<string, unknown>;
          const type = String(msg.type || '');
          if (type === 'full_state') {
            if (msg.simulator) setSimulatorStatus(msg.simulator as SimulatorStatus);
            if (msg.traps) setTrapStatus(msg.traps as TrapReceiverStatus);
            if (msg.stats) setStats(msg.stats as StatsSnapshot);
            if (msg.mibs) {
              mergeMibSummary(msg.mibs as Partial<MibSummary>);
              setMibRefreshVersion((v) => v + 1);
            }
          } else if (type === 'status') {
            if (msg.simulator) setSimulatorStatus(msg.simulator as SimulatorStatus);
            if (msg.traps) setTrapStatus(msg.traps as TrapReceiverStatus);
          } else if (type === 'stats') {
            const nextStats = (msg.stats || msg.data) as StatsSnapshot | undefined;
            if (nextStats) setStats(nextStats);
          } else if (type === 'mibs') {
            if (msg.mibs) {
              mergeMibSummary(msg.mibs as Partial<MibSummary>);
              setMibRefreshVersion((v) => v + 1);
            }
          } else if (type === 'simulator_log' && msg.entry) {
            setSimulatorLogs((prev) =>
              appendBatchedSimulatorLog(prev, msg.entry as Partial<SimulatorLogEntry>)
            );
          } else if (type === 'trap' && msg.trap) {
            if (!trapsPausedRef.current) {
              const incoming = msg.trap as ReceivedTrapEvent;
              setRecentTraps((prev) => {
                if (incoming.id != null && prev.some((t) => t.id === incoming.id)) return prev;
                return [incoming, ...prev].slice(0, 250);
              });
            }
          } else if (type === 'reauth_required') {
            clearStoredSession();
            setAuthenticated(false);
            clearTelemetryState();
            notify('Credentials updated. Please sign in again.', 'warning');
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = (ev) => {
        clearHeartbeats();
        if (disposed) return;
        setWsStatus('offline');
        if (ev.code === 4001) {
          clearStoredSession();
          setAuthenticated(false);
          clearTelemetryState();
          return;
        }
        const delay = Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        if (!disposed) setWsStatus('offline');
      };
    };

    connect();

    return () => {
      disposed = true;
      clearHeartbeats();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, [authenticated, clearTelemetryState, mergeMibSummary, notify, refreshLiveState]);

  // REST fallback polling while WebSocket is offline
  useEffect(() => {
    if (!authenticated || wsStatus !== 'offline') return;
    const pollId = window.setInterval(() => {
      void refreshLiveState();
    }, REST_OFFLINE_POLL_MS);
    return () => window.clearInterval(pollId);
  }, [authenticated, refreshLiveState, wsStatus]);

  const toggleSimulator = useCallback(
    (override?: { port?: number; community?: string }) =>
      toggleSimulatorService({
        simulatorStatus,
        port: override?.port,
        community: override?.community,
        notify,
        refreshLiveState,
      }),
    [notify, refreshLiveState, simulatorStatus]
  );

  const toggleTrapReceiver = useCallback(
    (override?: { port?: number; community?: string; resolveMibs?: boolean }) =>
      toggleTrapReceiverService({
        trapStatus,
        port: override?.port,
        community: override?.community,
        resolveMibs: override?.resolveMibs,
        notify,
        refreshLiveState,
      }),
    [notify, refreshLiveState, trapStatus]
  );

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
    clearTelemetryState();
  }, [clearTelemetryState]);

  const invalidateLocalSession = useCallback(() => {
    clearStoredSession();
    setAuthenticated(false);
    clearTelemetryState();
  }, [clearTelemetryState]);

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
      invalidateLocalSession,
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
      mibRefreshVersion,
      stats,
      simulatorLogs,
      recentTraps,
      trapsPaused,
      setTrapsPaused,
      refreshLiveState,
      mergeMibSummary,
      clearLocalSimulatorLogs,
      setRecentTraps,
      toggleSimulator,
      toggleTrapReceiver,
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
      invalidateLocalSession,
      activeWorkspace,
      navigate,
      handoff,
      clearHandoff,
      paletteOpen,
      wsStatus,
      simulatorStatus,
      trapStatus,
      mibSummary,
      mibRefreshVersion,
      stats,
      simulatorLogs,
      recentTraps,
      trapsPaused,
      refreshLiveState,
      mergeMibSummary,
      clearLocalSimulatorLogs,
      toggleSimulator,
      toggleTrapReceiver,
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

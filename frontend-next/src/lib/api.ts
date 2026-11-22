import type {
  AppMeta,
  AppSettings,
  AuthCheckResponse,
  BundleDiffResponse,
  BundleRecord,
  LoginResponse,
  MibModuleTreeGroup,
  MibNodeRecord,
  MibObjectSearchItem,
  MibStatusResponse,
  ReceivedTrapEvent,
  SimulatorLogEntry,
  SimulatorStatus,
  StatsSnapshot,
  TrapCatalogItem,
  TrapReceiverStatus,
  WalkExecuteRequest,
  WalkExecuteResponse,
} from '../types/api';

const TOKEN_KEY = 'trishul_token';
const USER_KEY = 'trishul_user';

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredSession(token: string, username: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, username);
  } catch {
    // ignore storage quota errors
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

export function getStoredUsername(): string {
  try {
    return localStorage.getItem(USER_KEY) || 'admin';
  } catch {
    return 'admin';
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const token = getStoredToken();
  if (token) {
    headers['X-Auth-Token'] = token;
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: string; message?: string; error?: string };
    return data.detail || data.message || data.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  opts: { auth?: boolean } = {}
): Promise<T> {
  const useAuth = opts.auth !== false;
  const headers: Record<string, string> = useAuth ? buildAuthHeaders() : {};
  const isFormData = options.body instanceof FormData;
  if (!isFormData && options.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const mergedHeaders = {
    ...headers,
    ...(options.headers ? Object.fromEntries(new Headers(options.headers).entries()) : {}),
  };

  const res = await fetch(`/api${path}`, {
    ...options,
    headers: mergedHeaders,
    cache: 'no-store',
  });

  if (res.status === 401 && useAuth && !path.startsWith('/settings/login') && !path.startsWith('/settings/check')) {
    unauthorizedHandler?.();
  }

  if (!res.ok) {
    const msg = await parseErrorMessage(res);
    throw new ApiError(msg, res.status);
  }

  return (await res.json()) as T;
}

async function requestBlob(path: string, body: unknown): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    unauthorizedHandler?.();
  }
  if (!res.ok) {
    throw new ApiError(await parseErrorMessage(res), res.status);
  }
  const disp = res.headers.get('content-disposition') || '';
  const match = disp.match(/filename="?([^"]+)"?/i);
  const filename = match ? match[1] : 'trishul-export.bin';
  return { blob: await res.blob(), filename };
}

export const api = {
  // System & Auth
  getMeta: () => requestJson<AppMeta>('/meta', {}, { auth: false }),
  checkAuth: () => requestJson<AuthCheckResponse>('/settings/check'),
  login: (username: string, password: string) =>
    requestJson<LoginResponse>(
      '/settings/login',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      { auth: false }
    ),
  logout: () => requestJson<{ status: string }>('/settings/logout', { method: 'POST' }),
  updateCredentials: (payload: { current_password: string; username: string; password: string }) =>
    requestJson<{ status: string; message?: string }>('/settings/auth', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAppSettings: () => requestJson<AppSettings>('/settings/app'),
  updateAppSettings: (payload: Partial<AppSettings>) =>
    requestJson<AppSettings>('/settings/app', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Stats
  getStats: () => requestJson<StatsSnapshot>('/stats'),
  resetStats: () => requestJson<{ status: string }>('/stats', { method: 'DELETE' }),

  // Simulator
  getSimulatorStatus: () => requestJson<SimulatorStatus>('/simulator/status'),
  startSimulator: (port: number, community: string) =>
    requestJson<SimulatorStatus>('/simulator/start', {
      method: 'POST',
      body: JSON.stringify({ port, community }),
    }),
  stopSimulator: () => requestJson<SimulatorStatus>('/simulator/stop', { method: 'POST' }),
  restartSimulator: () => requestJson<SimulatorStatus>('/simulator/restart', { method: 'POST' }),
  getSimulatorData: () => requestJson<Record<string, unknown>>('/simulator/data'),
  saveSimulatorData: (data: Record<string, unknown>) =>
    requestJson<{ status: string; warnings?: string[]; oids_count?: number }>('/simulator/data', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getSimulatorLogs: (limit = 200) =>
    requestJson<{ items?: SimulatorLogEntry[]; logs?: SimulatorLogEntry[]; count?: number }>(
      `/simulator/logs?limit=${limit}`
    ),
  clearSimulatorLogs: () => requestJson<{ status: string }>('/simulator/logs', { method: 'DELETE' }),

  // Walker
  executeWalk: (payload: WalkExecuteRequest, signal?: AbortSignal) =>
    requestJson<WalkExecuteResponse>('/walk/execute', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    }),

  // Traps
  getTrapStatus: () => requestJson<TrapReceiverStatus>('/traps/status'),
  startTrapReceiver: (port: number, community: string, resolveMibs: boolean) =>
    requestJson<TrapReceiverStatus>('/traps/start', {
      method: 'POST',
      body: JSON.stringify({ port, community, resolve_mibs: resolveMibs }),
    }),
  stopTrapReceiver: () => requestJson<TrapReceiverStatus>('/traps/stop', { method: 'POST' }),
  setTrapResolveMibs: (resolveMibs: boolean) =>
    requestJson<TrapReceiverStatus>('/traps/resolve-mibs', {
      method: 'POST',
      body: JSON.stringify({ resolve_mibs: resolveMibs }),
    }),
  listReceivedTraps: (limit = 100, offset = 0) =>
    requestJson<{ data?: ReceivedTrapEvent[]; traps?: ReceivedTrapEvent[]; total: number }>(
      `/traps?limit=${limit}&offset=${offset}`
    ),
  clearReceivedTraps: () => requestJson<{ status: string }>('/traps', { method: 'DELETE' }),
  deleteReceivedTrap: (eventId: number) =>
    requestJson<{ status: string }>(`/traps/${eventId}`, { method: 'DELETE' }),
  sendTrap: (
    payload: {
      target: string;
      port: number;
      community: string;
      oid: string;
      varbinds: Array<{ oid: string; type: string; value: string }>;
    },
    asInform = false
  ) =>
    requestJson<{ status: string; message?: string; acknowledged?: boolean }>(
      asInform ? '/traps/send-inform' : '/traps/send',
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  replayTrap: (
    eventId: number,
    override?: { host?: string | null; port?: number | null; community?: string | null }
  ) =>
    requestJson<{ status: string; message?: string }>(`/traps/replay/${eventId}`, {
      method: 'POST',
      body: JSON.stringify(override || {}),
    }),
  decodeTrapPayload: (payload: {
    payload: string;
    encoding: 'hex' | 'base64';
    source_host?: string | null;
    source_port?: number | null;
  }) =>
    requestJson<Record<string, unknown>>('/traps/decode', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // MIB Browser
  getBrowseModules: () =>
    requestJson<{
      modules: Array<{ name: string; objects: number; notifications: number }>;
      active_bundle_id?: number | null;
    }>('/mibs/browse/modules'),
  getModuleTree: (moduleName?: string, typeFilter?: string) => {
    const params = new URLSearchParams();
    if (moduleName) params.set('module', moduleName);
    if (typeFilter) params.set('type_filter', typeFilter);
    const qs = params.toString();
    return requestJson<{ modules: MibModuleTreeGroup[]; count: number }>(
      `/mibs/browse/tree/module${qs ? `?${qs}` : ''}`
    );
  },
  getOidTree: (rootOid: string, moduleName?: string, typeFilter?: string) => {
    const params = new URLSearchParams({ root_oid: rootOid });
    if (moduleName) params.set('module', moduleName);
    if (typeFilter) params.set('type_filter', typeFilter);
    return requestJson<{ root: MibNodeRecord | null; children: MibNodeRecord[]; total_descendants: number }>(
      `/mibs/browse/tree/oid?${params.toString()}`
    );
  },
  searchBrowse: (query: string, moduleName?: string, typeFilter?: string, limit = 60) => {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (moduleName) params.set('module', moduleName);
    if (typeFilter) params.set('type_filter', typeFilter);
    return requestJson<{ results: MibNodeRecord[]; count: number }>(
      `/mibs/browse/search?${params.toString()}`
    );
  },
  getBrowseNode: (oid: string, moduleName?: string) => {
    const qs = moduleName ? `?module=${encodeURIComponent(moduleName)}` : '';
    return requestJson<{
      node: MibNodeRecord | null;
      breadcrumb: Array<{ oid: string; name: string; full_name: string; module: string }>;
      trap_objects: Array<{
        name: string;
        full_name: string;
        module: string;
        oid: string;
        syntax: string;
        input_type: string;
      }>;
    }>(`/mibs/browse/node/${encodeURIComponent(oid)}${qs}`);
  },

  // MIB Manager & Bundles
  getMibStatus: () => requestJson<MibStatusResponse>('/mibs/status'),
  getTrapCatalog: () => requestJson<{ traps: TrapCatalogItem[] }>('/mibs/traps'),
  searchObjects: (search = '', limit = 50) =>
    requestJson<{ objects: MibObjectSearchItem[] }>(
      `/mibs/objects?search=${encodeURIComponent(search)}&limit=${limit}`
    ),
  resolveOid: (oid: string, mode: 'numeric' | 'symbolic' = 'numeric') =>
    requestJson<{ resolved: boolean; output: string; input: string }>(
      `/mibs/resolve?oid=${encodeURIComponent(oid)}&mode=${mode}`
    ),
  validateMibBatch: (files: File[], sourceGroup: string) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('source_group', sourceGroup || 'common');
    return requestJson<Record<string, unknown>>('/mibs/validate-batch', {
      method: 'POST',
      body: fd,
    });
  },
  uploadMibs: (
    files: File[],
    opts: { sourceGroup: string; compileMode?: 'full' | 'partial'; compileTargets?: string[] }
  ) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('source_group', opts.sourceGroup || 'common');
    fd.append('compile_mode', opts.compileMode || 'full');
    if (opts.compileTargets) {
      fd.append('compile_targets', JSON.stringify(opts.compileTargets));
    }
    return requestJson<Record<string, unknown>>('/mibs/upload', {
      method: 'POST',
      body: fd,
    });
  },
  reloadMibs: () => requestJson<Record<string, unknown>>('/mibs/reload', { method: 'POST' }),
  deleteMibBatch: (paths: string[]) =>
    requestJson<{ status: string; count: number }>('/mibs/delete-batch', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  downloadMibSources: (paths: string[]) => requestBlob('/mibs/download', { paths }),
  exportMibCatalog: (payload: {
    format: 'json' | 'csv';
    export_type?: string;
    modules?: string[];
    notifications?: string[];
    source_groups?: string[];
  }) => requestBlob('/mibs/export', payload),

  listBundles: () =>
    requestJson<{
      bundles: BundleRecord[];
      active_bundle_id: number | null;
      previous_active_bundle_id: number | null;
    }>('/bundles'),
  diffBundle: (bundleId: number, against?: number | null) => {
    const qs = against != null ? `?against=${against}` : '';
    return requestJson<BundleDiffResponse>(`/bundles/${bundleId}/diff${qs}`);
  },
  activateBundle: (bundleId: number) =>
    requestJson<{ status?: string; active_bundle_id?: number }>(`/bundles/${bundleId}/activate`, {
      method: 'POST',
    }),
};

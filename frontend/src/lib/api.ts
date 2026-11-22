import type {
  AppMeta,
  AppSettings,
  AuthCheckResponse,
  BundleDiffResponse,
  BundleRecord,
  DecodeTrapResponse,
  DeleteMibBatchResponse,
  LoginResponse,
  MibBundleSummaryResponse,
  MibModuleTreeGroup,
  MibNodeRecord,
  MibObjectSearchItem,
  MibStatusResponse,
  ReceivedTrapEvent,
  ReloadMibsResponse,
  SaveSimulatorDataResponse,
  SendNotificationResponse,
  SimulatorActionResponse,
  SimulatorLogEntry,
  SimulatorStatus,
  StatsSnapshot,
  TrapActionResponse,
  TrapCatalogItem,
  TrapReceiverStatus,
  UploadMibsResponse,
  ValidateBatchResponse,
  WalkExecuteRequest,
  WalkExecuteResponse,
} from '../types/api';

const TOKEN_KEY = 'trishul_token';
const USER_KEY = 'trishul_user';
const LEGACY_TOKEN_KEY = 'snmp_token';
const LEGACY_USER_KEY = 'snmp_username';

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredSession(token: string, username: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, username);
    sessionStorage.setItem(LEGACY_TOKEN_KEY, token);
    sessionStorage.setItem(LEGACY_USER_KEY, username);
  } catch {
    // ignore storage quota errors
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_USER_KEY);
  } catch {
    // ignore
  }
}

export function getStoredUsername(): string {
  try {
    return (
      localStorage.getItem(USER_KEY) ||
      sessionStorage.getItem(LEGACY_USER_KEY) ||
      'admin'
    );
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

/** Format FastAPI/Pydantic JSON error payloads including 422 validation error arrays. */
export function formatApiErrorDetail(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const rec = data as { detail?: unknown; message?: unknown; error?: unknown };
    if (Array.isArray(rec.detail)) {
      const items = rec.detail
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object') {
            const err = entry as { loc?: Array<string | number>; msg?: string; type?: string };
            const loc = Array.isArray(err.loc)
              ? err.loc.filter((part) => part !== 'body').join('.')
              : '';
            const msg = err.msg || err.type || 'Validation error';
            return loc ? `${loc}: ${msg}` : msg;
          }
          return '';
        })
        .filter(Boolean);
      if (items.length > 0) return items.join('; ');
    }
    if (typeof rec.detail === 'string' && rec.detail.trim()) return rec.detail;
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
    if (typeof rec.error === 'string' && rec.error.trim()) return rec.error;
  }
  return `HTTP ${status}`;
}

export async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    return formatApiErrorDetail(data, res.status);
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
    requestJson<{ status: string; message?: string; reauth_required?: boolean }>('/settings/auth', {
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
    requestJson<SimulatorActionResponse>('/simulator/start', {
      method: 'POST',
      body: JSON.stringify({ port, community }),
    }),
  stopSimulator: () => requestJson<SimulatorActionResponse>('/simulator/stop', { method: 'POST' }),
  restartSimulator: () => requestJson<SimulatorActionResponse>('/simulator/restart', { method: 'POST' }),
  getSimulatorData: () => requestJson<Record<string, unknown>>('/simulator/data'),
  saveSimulatorData: (data: Record<string, unknown>) =>
    requestJson<SaveSimulatorDataResponse>('/simulator/data', {
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
    requestJson<TrapActionResponse>('/traps/start', {
      method: 'POST',
      body: JSON.stringify({ port, community, resolve_mibs: resolveMibs }),
    }),
  stopTrapReceiver: () => requestJson<TrapActionResponse>('/traps/stop', { method: 'POST' }),
  setTrapResolveMibs: (resolveMibs: boolean) =>
    requestJson<TrapActionResponse>('/traps/resolve-mibs', {
      method: 'POST',
      body: JSON.stringify({ resolve_mibs: resolveMibs }),
    }),
  listReceivedTraps: (limit = 100, offset = 0) =>
    requestJson<{ data?: ReceivedTrapEvent[]; traps?: ReceivedTrapEvent[]; total: number; limit?: number; offset?: number }>(
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
    requestJson<SendNotificationResponse>(
      asInform ? '/traps/send-inform' : '/traps/send',
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  replayTrap: (
    eventId: number,
    override?: {
      host?: string | null;
      port?: number | null;
      community?: string | null;
      timeout?: number | null;
      retries?: number | null;
    }
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
    requestJson<DecodeTrapResponse>('/traps/decode', {
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
  getOidTree: (rootOid: string, moduleName?: string, typeFilter?: string, depth = 1) => {
    const params = new URLSearchParams({ root_oid: rootOid, depth: String(depth) });
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
  getBundleSummary: () => requestJson<MibBundleSummaryResponse>('/mibs/bundle-summary'),
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
    return requestJson<ValidateBatchResponse>('/mibs/validate-batch', {
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
    return requestJson<UploadMibsResponse>('/mibs/upload', {
      method: 'POST',
      body: fd,
    });
  },
  reloadMibs: () => requestJson<ReloadMibsResponse>('/mibs/reload', { method: 'POST' }),
  deleteMibBatch: (paths: string[]) =>
    requestJson<DeleteMibBatchResponse>('/mibs/delete-batch', {
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
      recompile_recommended?: boolean;
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

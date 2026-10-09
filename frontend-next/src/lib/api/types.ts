// Verified 2.2.x contract subset. Generate full OpenAPI contracts before feature migration.
export interface AppMeta {
  name: string;
  version: string;
  author: string;
  description: string;
}
export interface UserSession {
  user: string;
}
export interface LoginResult {
  token: string;
  username: string;
}
export interface RuntimeStatus {
  running?: boolean;
  [field: string]: unknown;
}
export interface MibSummary {
  loaded?: number;
  failed?: number;
  total?: number;
  traps_available?: number;
  source_files?: number;
  [field: string]: unknown;
}
export interface OperationalStats {
  simulator?: { snmp_requests_served?: number; oids_loaded?: number };
  traps?: { traps_received_total?: number; traps_sent_total?: number };
  walker?: { walks_executed?: number; oids_returned?: number };
  mibs?: { reload_count?: number; upload_count?: number };
}
export type RealtimeType =
  | 'full_state' | 'status' | 'stats' | 'mibs'
  | 'trap' | 'simulator_log' | 'reauth_required';
export type RealtimeEvent = {
  type: RealtimeType;
  simulator?: RuntimeStatus;
  traps?: RuntimeStatus;
  stats?: OperationalStats;
  mibs?: MibSummary;
  trap?: Record<string, unknown>;
  entry?: Record<string, unknown>;
};
const recognizedTypes = new Set<RealtimeType>([
  'full_state', 'status', 'stats', 'mibs', 'trap', 'simulator_log', 'reauth_required',
]);
export function parseRealtimeEvent(payload: unknown): RealtimeEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.type !== 'string' || !recognizedTypes.has(record.type as RealtimeType)) {
    return null;
  }
  return record as RealtimeEvent;
}

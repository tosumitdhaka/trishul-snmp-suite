import type { MibSummary, OperationalStats, RuntimeStatus } from '../../lib/api/types';

/** REST and WebSocket MIB summaries have different shapes in v2.2.x. */
export interface MibStatusResponse extends MibSummary {
  mibs?: Array<{ traps?: number | null }>;
  source_groups?: Array<{ file_count?: number | null }>;
}

export function normalizeMibSummary(payload: MibStatusResponse): MibSummary {
  const trapsAvailable = payload.traps_available ??
    (Array.isArray(payload.mibs)
      ? payload.mibs.reduce((count, module) => count + countOrZero(module.traps), 0)
      : payload.loaded === 0 ? 0 : undefined);
  const sourceFiles = payload.source_files ??
    (Array.isArray(payload.source_groups)
      ? payload.source_groups.reduce((count, group) => count + countOrZero(group.file_count), 0)
      : undefined);
  return {
    loaded: payload.loaded,
    failed: payload.failed,
    total: payload.total,
    traps_available: trapsAvailable,
    source_files: sourceFiles,
  };
}

function countOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString('en-US') : '—';
}

export function runtimeText(
  data: RuntimeStatus | undefined,
  isPending: boolean,
  isError: boolean,
): string {
  if (!data) return isPending ? 'Checking…' : 'Unavailable';
  const status = data.running === true ? 'Running' : data.running === false ? 'Stopped' : 'Unavailable';
  return isError ? 'Last known: ' + status : status;
}

export type ActivityCount = { label: string; value: number | undefined; group: 'SNMP' | 'MIB' };
export function getActivityCounts(stats?: OperationalStats, mibs?: MibSummary): ActivityCount[] {
  return [
    { label: 'SNMP requests', value: stats?.simulator?.snmp_requests_served, group: 'SNMP' },
    { label: 'OIDs loaded', value: stats?.simulator?.oids_loaded, group: 'SNMP' },
    { label: 'Traps received', value: stats?.traps?.traps_received_total, group: 'SNMP' },
    { label: 'Traps sent', value: stats?.traps?.traps_sent_total, group: 'SNMP' },
    { label: 'Walks executed', value: stats?.walker?.walks_executed, group: 'SNMP' },
    { label: 'OIDs returned', value: stats?.walker?.oids_returned, group: 'SNMP' },
    { label: 'MIB sources', value: stats?.mibs?.upload_count ?? mibs?.source_files, group: 'MIB' },
    { label: 'MIB reloads', value: stats?.mibs?.reload_count, group: 'MIB' },
  ];
}

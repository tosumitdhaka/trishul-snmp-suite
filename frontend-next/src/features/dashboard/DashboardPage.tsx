import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, ArrowRight, ArrowUpRight, Bell, CheckCircle2, CircleAlert,
  Database, HardDrive, RefreshCw, Radio, Server, Wifi, WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { apiRequest } from '../../lib/api/client';
import type { AppMeta, MibSummary, OperationalStats, RuntimeStatus } from '../../lib/api/types';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { workspaces } from '../../lib/navigation/workspaces';
import {
  formatCount, getActivityCounts, normalizeMibSummary, runtimeText,
  type MibStatusResponse,
} from './dashboard-model';

type DataState = 'healthy' | 'stopped' | 'warning' | 'loading';
function SummaryCard({
  label, value, detail, icon: Icon, state = 'healthy',
}: {
  label: string; value: string; detail: string; icon: LucideIcon; state?: DataState;
}) {
  const statusTone = state === 'healthy' ? 'text-[var(--success)]' :
    state === 'stopped' ? 'text-[var(--muted)]' :
    state === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--accent)]';
  return (
    <div className="panel flex min-h-38 flex-col justify-between p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
        <div className="rounded-xl bg-[var(--accent-soft)] p-2.5 text-[var(--accent)]">
          <Icon size={19} aria-hidden="true" />
        </div>
      </div>
      <div className="mt-5">
        <p className={'text-2xl font-semibold tracking-tight tabular-nums ' + (state === 'warning' ? statusTone : '')}>{value}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">{detail}</p>
      </div>
    </div>
  );
}

function RuntimeCard({
  label, data, pending, error, icon,
}: { label: string; data?: RuntimeStatus; pending: boolean; error: boolean; icon: LucideIcon }) {
  const state: DataState = error || !data ? pending ? 'loading' : 'warning'
    : data.running === true ? 'healthy' : 'stopped';
  return <SummaryCard label={label} icon={icon}
    value={runtimeText(data, pending, error)}
    detail={error ? 'Status could not be refreshed' : label === 'Simulator' ? 'SNMP responder' : 'Notification listener'}
    state={state} />;
}

function CountCard({
  label, value, pending, error, icon, detail,
}: {
  label: string; value?: number; pending: boolean; error: boolean; icon: LucideIcon; detail: string;
}) {
  const hasValue = typeof value === 'number' && Number.isFinite(value);
  return <SummaryCard label={label} icon={icon}
    value={hasValue ? formatCount(value) : pending ? 'Checking…' : 'Unavailable'}
    detail={error ? 'Last known value; refresh failed' : detail}
    state={error || !hasValue ? pending ? 'loading' : 'warning' : 'healthy'} />;
}

export function DashboardPage() {
  const { auth } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const connection = useRealtime();
  const [refreshing, setRefreshing] = useState(false);
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => apiRequest<AppMeta>('/api/meta', null, { signal }),
    staleTime: 60_000,
    refetchInterval: connection === 'live' ? 60_000 : 15_000,
  });
  const simulator = useQuery({
    queryKey: ['simulator', 'status'],
    queryFn: ({ signal }) => apiRequest<RuntimeStatus>('/api/simulator/status', token, { signal }),
    enabled: !!token,
    refetchInterval: connection === 'live' ? false : 15_000,
  });
  const receiver = useQuery({
    queryKey: ['traps', 'status'],
    queryFn: ({ signal }) => apiRequest<RuntimeStatus>('/api/traps/status', token, { signal }),
    enabled: !!token,
    refetchInterval: connection === 'live' ? false : 15_000,
  });
  const mibs = useQuery({
    queryKey: ['mibs', 'summary'],
    queryFn: async ({ signal }): Promise<MibSummary> =>
      normalizeMibSummary(await apiRequest<MibStatusResponse>('/api/mibs/status', token, { signal })),
    enabled: !!token,
    staleTime: 30_000,
    refetchInterval: connection === 'live' ? false : 30_000,
  });
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: ({ signal }) => apiRequest<OperationalStats>('/api/stats/', token, { signal }),
    enabled: !!token,
    refetchInterval: connection === 'live' ? false : 30_000,
  });
  const failedQueries = [
    meta.isError ? 'metadata' : null,
    simulator.isError ? 'simulator' : null,
    receiver.isError ? 'receiver' : null,
    mibs.isError ? 'MIB summary' : null,
    stats.isError ? 'activity' : null,
  ].filter((item): item is string => item !== null);
  const mostRecentUpdate = Math.max(
    meta.dataUpdatedAt, simulator.dataUpdatedAt, receiver.dataUpdatedAt, mibs.dataUpdatedAt, stats.dataUpdatedAt,
  );
  const lastChecked = mostRecentUpdate > 0
    ? new Date(mostRecentUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Not yet available';

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.allSettled([
        meta.refetch(), simulator.refetch(), receiver.refetch(), mibs.refetch(), stats.refetch(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  const apiReachable = !meta.isError && !!meta.data;
  const wsLive = connection === 'live';

  return (
    <div className="space-y-7">
      <section aria-labelledby="dashboard-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Operations console · modern preview</p>
            <h1 id="dashboard-heading" className="mt-1 text-[clamp(1.5rem,2vw,1.85rem)] font-semibold tracking-tight">
              Operations overview
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Actual status and counters from the existing Trishul services.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" type="button" onClick={() => void refresh()}
              disabled={refreshing} aria-label="Refresh dashboard">
              <RefreshCw size={16} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <a href="/#dashboard" className="btn-secondary">
              Legacy dashboard <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--muted)]">
          <span className="inline-flex items-center gap-2">
            {apiReachable ? <CheckCircle2 size={16} className="text-[var(--success)]" aria-hidden="true" /> :
              <CircleAlert size={16} className="text-[var(--warning)]" aria-hidden="true" />}
            <strong className="font-semibold text-[var(--text)]">Backend:</strong>
            {apiReachable ? 'Reachable' : meta.isPending ? 'Checking…' : 'Unavailable'}
          </span>
          <span className="inline-flex items-center gap-2">
            {wsLive ? <Wifi size={16} className="text-[var(--success)]" aria-hidden="true" /> :
              <WifiOff size={16} className="text-[var(--warning)]" aria-hidden="true" />}
            <strong className="font-semibold text-[var(--text)]">Live updates:</strong>
            {wsLive ? 'Connected' : connection === 'unauthorized' ? 'Unauthorized' : 'Polling fallback / ' + connection}
          </span>
          {meta.data && <span className="font-medium">{meta.data.name} v{meta.data.version}</span>}
          <span className="sm:ml-auto">Latest update: {lastChecked}</span>
        </div>
        {failedQueries.length > 0 && (
          <p role="alert" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--warning)]">
            Unable to refresh {failedQueries.join(', ')}. Previously loaded values may be outdated. Use Refresh to retry.
          </p>
        )}
      </section>

      <section aria-labelledby="health-heading">
        <div className="mb-4">
          <h2 id="health-heading" className="text-lg font-semibold tracking-tight">Service health</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">A stopped service is different from a disconnected backend.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <RuntimeCard label="Simulator" data={simulator.data} pending={simulator.isPending}
            error={simulator.isError} icon={Server} />
          <RuntimeCard label="Trap receiver" data={receiver.data} pending={receiver.isPending}
            error={receiver.isError} icon={Radio} />
          <CountCard label="MIBs loaded" value={mibs.data?.loaded} pending={mibs.isPending}
            error={mibs.isError} icon={Database} detail="Active modules in compiled bundle" />
          <CountCard label="Trap types" value={mibs.data?.traps_available} pending={mibs.isPending}
            error={mibs.isError} icon={Bell} detail="Definitions in active MIB bundle" />
        </div>
      </section>

      <section aria-labelledby="activity-heading" className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-[var(--accent)]" aria-hidden="true" />
            <h2 id="activity-heading" className="text-lg font-semibold">Activity</h2>
          </div>
          <span className="text-xs text-[var(--muted)]">Eight legacy counters · {stats.isError ? 'Last known data' : 'Read only'}</span>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4">
          {getActivityCounts(stats.data, mibs.data).map((item) => (
            <div key={item.label} className="min-w-0 border-b border-r border-[var(--border)] px-5 py-5 last:border-r-0 sm:px-6">
              <dt className="text-xs font-medium text-[var(--muted)]">{item.label}</dt>
              <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {item.value === undefined && stats.isPending && item.label !== 'MIB sources'
                  ? '…' : formatCount(item.value)}
              </dd>
              <span className="mt-1 block text-[0.68rem] text-[var(--muted)]">{item.group === 'SNMP' ? 'Operations' : 'Catalog'}</span>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="launchers-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="launchers-heading" className="text-lg font-semibold tracking-tight">Workspaces</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">Explore the new shell. Operational workflows remain in the legacy console.</p>
          </div>
          <HardDrive size={20} className="text-[var(--muted)]" aria-hidden="true" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {workspaces.filter((page) => page.path !== '/').map((page) => (
            <Link key={page.path} to={page.path}
              className="group panel flex min-h-28 items-center justify-between gap-4 p-5 text-[var(--text)] no-underline transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-muted)]">
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{page.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-[var(--muted)]">{page.description}</span>
                <span className="mt-2 block text-[0.68rem] font-medium text-[var(--accent)]">
                  {page.path === '/settings' ? 'Stage 3 preview · functional settings' : 'Preview placeholder'}
                </span>
              </span>
              <ArrowRight size={18} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>
      <p className="text-xs text-[var(--muted)]">
        Modernization preview only. The dashboard is read-only; Settings can change server preferences, credentials and statistics. Other operational controls remain in the legacy interface.
      </p>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, Database, Radio, Server, Wifi } from 'lucide-react';
import { apiRequest } from '../../lib/api/client';
import type { AppMeta, MibSummary, OperationalStats, RuntimeStatus } from '../../lib/api/types';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';

function RuntimeTile({ label, value, caption, icon: Icon }: {
  label: string; value: string; caption: string; icon: typeof Activity;
}) {
  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-[var(--muted)]">{label}</p>
        <Icon size={18} className="text-[var(--accent)]" aria-hidden="true" />
      </div>
      <p className="mt-4 text-2xl font-semibold tabular-nums" aria-live="polite">{value}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">{caption}</p>
    </div>
  );
}
function runtimeLabel(data: RuntimeStatus | undefined, loading: boolean): string {
  if (!data) return loading ? 'Checking…' : 'Unavailable';
  return data.running === true ? 'Running' : data.running === false ? 'Stopped' : 'Unavailable';
}
export function ConnectivityOverview() {
  const { auth } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const ws = useRealtime();
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => apiRequest<AppMeta>('/api/meta', null, { signal }),
    staleTime: 300_000,
  });
  const simulator = useQuery({
    queryKey: ['simulator', 'status'],
    queryFn: ({ signal }) => apiRequest<RuntimeStatus>('/api/simulator/status', token, { signal }),
    enabled: !!token,
    refetchInterval: ws === 'live' ? false : 15_000,
  });
  const receiver = useQuery({
    queryKey: ['traps', 'status'],
    queryFn: ({ signal }) => apiRequest<RuntimeStatus>('/api/traps/status', token, { signal }),
    enabled: !!token,
    refetchInterval: ws === 'live' ? false : 15_000,
  });
  const mibs = useQuery({
    queryKey: ['mibs', 'summary'],
    queryFn: ({ signal }) => apiRequest<MibSummary>('/api/mibs/status', token, { signal }),
    enabled: !!token,
    staleTime: 30_000,
  });
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: ({ signal }) => apiRequest<OperationalStats>('/api/stats/', token, { signal }),
    enabled: !!token,
    refetchInterval: ws === 'live' ? false : 30_000,
  });
  return (
    <div className="space-y-6">
      <section aria-labelledby="overview-heading">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Foundation preview · read-only</p>
            <h2 id="overview-heading" className="mt-1 text-2xl font-semibold tracking-tight">System overview</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Live backend connectivity from the existing FastAPI services.
            </p>
          </div>
          <a href="/#dashboard" className="btn-secondary">
            Open legacy dashboard <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <RuntimeTile icon={Wifi} label="Backend" value={meta.isError ? 'Unavailable' : meta.isPending ? 'Checking…' : 'Reachable'}
            caption={meta.data ? meta.data.name + ' v' + meta.data.version : 'GET /api/meta'} />
          <RuntimeTile icon={Server} label="Simulator" value={runtimeLabel(simulator.data, simulator.isPending)}
            caption="SNMP responder" />
          <RuntimeTile icon={Radio} label="Trap receiver" value={runtimeLabel(receiver.data, receiver.isPending)}
            caption="Notification listener" />
          <RuntimeTile icon={Database} label="Loaded MIBs"
            value={mibs.data?.loaded != null ? mibs.data.loaded.toLocaleString() : mibs.isPending ? 'Checking…' : 'Unavailable'}
            caption="Active compiled bundle" />
        </div>
      </section>
      <section className="panel p-6" aria-labelledby="activity-heading">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-[var(--accent-soft)] p-2 text-[var(--accent)]"><Activity size={18} aria-hidden="true" /></div>
          <div>
            <h3 id="activity-heading" className="font-semibold">Activity snapshot</h3>
            <p className="text-xs text-[var(--muted)]">This is a foundation readout, not the finalized dashboard.</p>
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-5 md:grid-cols-4">
          {([
            ['SNMP requests', stats.data?.simulator?.snmp_requests_served],
            ['Traps received', stats.data?.traps?.traps_received_total],
            ['Walks executed', stats.data?.walker?.walks_executed],
            ['OIDs returned', stats.data?.walker?.oids_returned],
          ] as const).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-[var(--muted)]">{label}</dt>
              <dd className="mt-2 text-xl font-semibold tabular-nums">
                {typeof value === 'number' ? value.toLocaleString() : '—'}
              </dd>
            </div>
          ))}
        </dl>
        {stats.isError && <p role="alert" className="mt-4 text-sm text-[var(--danger)]">Unable to load activity; check backend connectivity.</p>}
      </section>
    </div>
  );
}

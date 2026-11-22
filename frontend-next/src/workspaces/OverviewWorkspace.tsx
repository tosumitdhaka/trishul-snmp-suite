import React, { useState } from 'react';
import {
  ArrowRight,
  Bell,
  Database,
  FolderTree,
  Play,
  RotateCcw,
  Route,
  Server,
  Sliders,
  Square,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatRelativeTime, formatUptime } from '../lib/workbench';
import { useWorkbench } from '../context/WorkbenchContext';
import { StatusLabel } from '../components/UiPrimitives';
import type { WorkspaceId } from '../types/api';

export const OverviewWorkspace: React.FC = () => {
  const {
    simulatorStatus,
    trapStatus,
    mibSummary,
    stats,
    simulatorLogs,
    recentTraps,
    navigate,
    notify,
    confirm,
    refreshLiveState,
  } = useWorkbench();

  const [busyService, setBusyService] = useState<'sim' | 'trap' | null>(null);

  const toggleSimulator = async () => {
    setBusyService('sim');
    try {
      if (simulatorStatus?.running) {
        await api.stopSimulator();
        notify('SNMP Simulator stopped.', 'info');
      } else {
        await api.startSimulator(simulatorStatus?.port || 1061, simulatorStatus?.community || 'public');
        notify('SNMP Simulator started.', 'success');
      }
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Simulator toggle failed', 'error');
    } finally {
      setBusyService(null);
    }
  };

  const toggleTrapReceiver = async () => {
    setBusyService('trap');
    try {
      if (trapStatus?.running) {
        await api.stopTrapReceiver();
        notify('Trap Receiver stopped.', 'info');
      } else {
        await api.startTrapReceiver(
          trapStatus?.port || 1162,
          trapStatus?.community || 'public',
          trapStatus?.resolve_mibs ?? true
        );
        notify('Trap Receiver started.', 'success');
      }
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Trap Receiver toggle failed', 'error');
    } finally {
      setBusyService(null);
    }
  };

  const handleResetStats = async () => {
    const ok = await confirm({
      title: 'Reset all activity counters?',
      message: 'This clears cumulative SNMP requests, walk runs, trap totals, and MIB reload counts.',
      confirmLabel: 'Reset Counters',
    });
    if (!ok) return;
    try {
      await api.resetStats();
      await refreshLiveState();
      notify('Activity counters reset.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to reset counters', 'error');
    }
  };

  const telemetryMetrics = [
    { label: 'SNMP Requests', value: stats?.simulator.snmp_requests_served ?? 0 },
    { label: 'OIDs Loaded', value: stats?.simulator.oids_loaded ?? 0 },
    { label: 'Traps Received', value: stats?.traps.traps_received_total ?? 0 },
    { label: 'Traps Sent', value: stats?.traps.traps_sent_total ?? 0 },
    { label: 'Walks Executed', value: stats?.walker.walks_executed ?? 0 },
    { label: 'OIDs Returned', value: stats?.walker.oids_returned ?? 0 },
    { label: 'MIB Sources', value: stats?.mibs.upload_count ?? 0 },
    { label: 'Reloads', value: stats?.mibs.reload_count ?? 0 },
  ];

  const shortcuts: Array<{
    id: WorkspaceId;
    title: string;
    copy: string;
    icon: React.ReactNode;
  }> = [
    {
      id: 'simulator',
      title: 'SNMP Simulator',
      copy: 'Manage responder runtime, custom OID overrides, and request stream',
      icon: <Server className="w-4 h-4 text-[var(--tui-success-ink)]" />,
    },
    {
      id: 'walker',
      title: 'Walk & Parse',
      copy: 'Walk targets, resolve MIB symbols/enums, and export JSON or CSV',
      icon: <Route className="w-4 h-4 text-[var(--tui-brand)]" />,
    },
    {
      id: 'traps',
      title: 'Traps Console',
      copy: 'Send traps/informs, monitor live receiver, replay and decode BER',
      icon: <Bell className="w-4 h-4 text-[var(--tui-warning-ink)]" />,
    },
    {
      id: 'browser',
      title: 'MIB Browser',
      copy: 'Explore module trees, OID subtrees, syntax, constraints, and enums',
      icon: <FolderTree className="w-4 h-4 text-[var(--tui-table-ink)]" />,
    },
    {
      id: 'mibs',
      title: 'MIB Manager',
      copy: 'Upload MIB batches, inspect failed compiles, diff & rollback bundles',
      icon: <Database className="w-4 h-4 text-[var(--tui-info-ink)]" />,
    },
    {
      id: 'settings',
      title: 'Settings',
      copy: 'Update credentials, auto-start defaults, timeout, and remote sources',
      icon: <Sliders className="w-4 h-4 text-[var(--tui-ink-secondary)]" />,
    },
  ];

  return (
    <div className="max-w-[1440px] mx-auto px-4 lg:px-6 py-6 space-y-6">
      {/* Live Runtimes & Catalog Control Strip */}
      <section aria-label="Runtime status and quick controls">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-px bg-[var(--tui-border-default)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
          {/* Simulator Quick Control */}
          <div className="lg:col-span-4 bg-[var(--tui-bg-surface)] p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[var(--tui-ink-secondary)]">SNMP Simulator</span>
                <StatusLabel
                  tone={simulatorStatus?.running ? 'success' : 'neutral'}
                  label={simulatorStatus?.running ? 'Running' : 'Stopped'}
                  liveDot={Boolean(simulatorStatus?.running)}
                />
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--tui-ink-muted)] tabular-nums truncate">
                UDP {simulatorStatus?.port ?? 1061} · Uptime {formatUptime(simulatorStatus?.uptime_seconds)}
              </div>
            </div>
            <button
              type="button"
              disabled={busyService === 'sim'}
              onClick={() => void toggleSimulator()}
              className={`h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50 ${
                simulatorStatus?.running
                  ? 'border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] hover:brightness-95 dark:hover:brightness-110'
                  : 'bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)]'
              }`}
            >
              {simulatorStatus?.running ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{simulatorStatus?.running ? 'Stop' : 'Start'}</span>
            </button>
          </div>

          {/* Trap Receiver Quick Control */}
          <div className="lg:col-span-4 bg-[var(--tui-bg-surface)] p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[var(--tui-ink-secondary)]">Trap Receiver</span>
                <StatusLabel
                  tone={trapStatus?.running ? 'success' : 'neutral'}
                  label={trapStatus?.running ? 'Listening' : 'Stopped'}
                  liveDot={Boolean(trapStatus?.running)}
                />
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--tui-ink-muted)] tabular-nums truncate">
                UDP {trapStatus?.port ?? 1162} · Uptime {formatUptime(trapStatus?.uptime_seconds)}
              </div>
            </div>
            <button
              type="button"
              disabled={busyService === 'trap'}
              onClick={() => void toggleTrapReceiver()}
              className={`h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50 ${
                trapStatus?.running
                  ? 'border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] hover:brightness-95 dark:hover:brightness-110'
                  : 'bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)]'
              }`}
            >
              {trapStatus?.running ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{trapStatus?.running ? 'Stop' : 'Start'}</span>
            </button>
          </div>

          {/* Active Catalog Summary */}
          <div className="lg:col-span-4 bg-[var(--tui-bg-surface)] p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <div>
                <div className="text-xs text-[var(--tui-ink-muted)]">MIBs Loaded</div>
                <div className="mt-0.5 text-xl font-mono font-semibold tabular-nums text-[var(--tui-ink-primary)]">
                  {mibSummary?.loaded ?? '—'}
                </div>
              </div>
              <div className="h-8 w-px bg-[var(--tui-border-subtle)]" aria-hidden="true" />
              <div>
                <div className="text-xs text-[var(--tui-ink-muted)]">Trap Types</div>
                <div className="mt-0.5 text-xl font-mono font-semibold tabular-nums text-[var(--tui-ink-primary)]">
                  {mibSummary?.traps_available ?? '—'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate('mibs')}
              className="h-8 px-2.5 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
            >
              <span>Manage</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* Hairline-Divided 8-Cell Telemetry Matrix */}
      <section aria-label="Activity telemetry">
        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-xs font-semibold text-[var(--tui-ink-muted)]">Activity Telemetry</h2>
          <button
            type="button"
            onClick={() => void handleResetStats()}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-secondary)] transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset Counters</span>
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--tui-border-default)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
          {telemetryMetrics.map((m) => (
            <div
              key={m.label}
              className="bg-[var(--tui-bg-surface)] px-4 py-3.5 hover:bg-[var(--tui-bg-subtle)] transition-colors"
            >
              <div className="text-xs text-[var(--tui-ink-muted)]">{m.label}</div>
              <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-[var(--tui-ink-primary)]">
                {m.value.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom Split: Live Event Feed + Workspace Launchpad */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Live Recent Stream */}
        <div className="lg:col-span-7 flex flex-col border border-[var(--tui-border-default)] rounded-xl bg-[var(--tui-bg-surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-between">
            <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">Recent Live Stream</h2>
            <div className="flex items-center gap-3 text-xs text-[var(--tui-ink-muted)]">
              <button
                type="button"
                onClick={() => navigate('simulator')}
                className="hover:text-[var(--tui-brand)] transition-colors cursor-pointer"
              >
                Simulator logs
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => navigate('traps')}
                className="hover:text-[var(--tui-brand)] transition-colors cursor-pointer"
              >
                Received traps
              </button>
            </div>
          </div>

          <div className="divide-y divide-[var(--tui-border-subtle)] flex-1">
            {recentTraps.slice(0, 4).map((trap) => (
              <div
                key={`trap-${trap.id}`}
                className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-[var(--tui-bg-hover)] transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Bell className="w-3.5 h-3.5 text-[var(--tui-warning)] shrink-0" />
                  <span className="font-mono font-semibold text-[var(--tui-ink-primary)] truncate">
                    {trap.trap_type || trap.trap_name || trap.trap_oid}
                  </span>
                  <span className="text-[var(--tui-ink-muted)] font-mono truncate">
                    from {trap.source || trap.source_ip || 'local'}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-[var(--tui-ink-soft)] whitespace-nowrap shrink-0">
                  {formatRelativeTime(trap.timestamp)}
                </span>
              </div>
            ))}

            {simulatorLogs
              .slice(-6)
              .reverse()
              .map((entry, idx) => (
                <div
                  key={`log-${idx}-${entry.time}`}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-[var(--tui-bg-hover)] transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Server className="w-3.5 h-3.5 text-[var(--tui-info)] shrink-0" />
                    <span className="font-mono text-[var(--tui-ink-secondary)] truncate">{entry.message}</span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--tui-ink-soft)] whitespace-nowrap shrink-0">
                    {entry.time}
                  </span>
                </div>
              ))}

            {recentTraps.length === 0 && simulatorLogs.length === 0 && (
              <div className="py-12 px-6 text-center text-xs text-[var(--tui-ink-muted)]">
                No runtime events yet. Start the SNMP Simulator or Trap Receiver above to stream live activity.
              </div>
            )}
          </div>
        </div>

        {/* Workspace Launchpad */}
        <div className="lg:col-span-5 border border-[var(--tui-border-default)] rounded-xl bg-[var(--tui-bg-surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)]">
            <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">Workspaces</h2>
          </div>
          <div className="divide-y divide-[var(--tui-border-subtle)]">
            {shortcuts.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                className="group w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[var(--tui-bg-hover)] transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] flex items-center justify-center shrink-0">
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-[var(--tui-ink-primary)]">{item.title}</div>
                  <div className="text-[11px] text-[var(--tui-ink-muted)] truncate mt-0.5">{item.copy}</div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] group-hover:text-[var(--tui-brand)] group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

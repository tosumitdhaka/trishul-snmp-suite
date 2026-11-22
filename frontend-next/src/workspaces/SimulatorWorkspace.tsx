import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  BookOpen,
  Braces,
  Download,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  countLogsByLevel,
  defaultValueForVarbind,
  downloadTextFile,
  formatRelativeTime,
  formatUptime,
  inferSnmpVarbindType,
  normalizeEnums,
} from '../lib/workbench';
import { useWorkbench } from '../context/WorkbenchContext';
import { StatusLabel } from '../components/UiPrimitives';
import { MibObjectPickerDrawer } from '../components/MibObjectPickerDrawer';
import type { MibObjectSearchItem } from '../types/api';

type LogFilterLevel = 'all' | 'info' | 'success' | 'warning' | 'error';

const NUMERIC_TYPES = new Set(['Integer', 'Gauge32', 'Counter32', 'Counter64', 'TimeTicks']);

export const SimulatorWorkspace: React.FC = () => {
  const {
    simulatorStatus,
    stats,
    simulatorLogs,
    clearLocalSimulatorLogs,
    refreshLiveState,
    notify,
    confirm,
  } = useWorkbench();

  const [port, setPort] = useState<number>(simulatorStatus?.port || 1061);
  const [community, setCommunity] = useState<string>(simulatorStatus?.community || 'public');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Live 1-second uptime ticker
  const [liveUptime, setLiveUptime] = useState<number | null>(simulatorStatus?.uptime_seconds ?? null);

  useEffect(() => {
    setLiveUptime(simulatorStatus?.uptime_seconds ?? null);
  }, [simulatorStatus?.uptime_seconds, simulatorStatus?.running]);

  useEffect(() => {
    if (!simulatorStatus?.running) return;
    const id = window.setInterval(() => {
      setLiveUptime((prev) => (prev == null ? 1 : prev + 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [simulatorStatus?.running]);

  // Custom JSON editor state
  const [jsonText, setJsonText] = useState<string>('{}');
  const [savedJsonText, setSavedJsonText] = useState<string>('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  const [savingData, setSavingData] = useState(false);
  const [oidPickerOpen, setOidPickerOpen] = useState(false);

  // Log stream state
  const [logSearch, setLogSearch] = useState('');
  const [logLevel, setLogLevel] = useState<LogFilterLevel>('all');
  const [followLogs, setFollowLogs] = useState(true);
  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (simulatorStatus) {
      setPort(simulatorStatus.port || 1061);
      setCommunity(simulatorStatus.community || 'public');
    }
  }, [simulatorStatus?.port, simulatorStatus?.community]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.getSimulatorData();
        if (!active) return;
        const formatted = JSON.stringify(data || {}, null, 2);
        setJsonText(formatted);
        setSavedJsonText(formatted);
        setJsonError(null);
      } catch (err) {
        if (active) notify(err instanceof Error ? err.message : 'Failed to load custom data', 'error');
      }
    })();
    return () => {
      active = false;
    };
  }, [notify]);

  const dirty = jsonText !== savedJsonText;

  const handleJsonChange = (next: string) => {
    setJsonText(next);
    try {
      const parsed = JSON.parse(next);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('Root value must be a JSON object mapping OIDs to values.');
      } else {
        setJsonError(null);
      }
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON syntax');
    }
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Cannot format invalid JSON');
    }
  };

  const handleInsertOidOverride = (obj: MibObjectSearchItem) => {
    let parsed: Record<string, unknown> = {};
    try {
      const current = JSON.parse(jsonText);
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        parsed = { ...(current as Record<string, unknown>) };
      }
    } catch {
      notify('Fix JSON syntax errors before inserting an OID override.', 'warning');
      return;
    }

    const snmpType = inferSnmpVarbindType(obj);
    const enums = normalizeEnums(obj.enum_values);
    const rawDef = defaultValueForVarbind(snmpType, enums, obj.constraint);
    const typedValue: string | number =
      NUMERIC_TYPES.has(snmpType) && /^-?\d+$/.test(rawDef)
        ? Number(rawDef)
        : rawDef || `custom-${obj.name}`;
    const key = `${obj.full_name || obj.oid}.0`;
    parsed[key] = typedValue;
    setJsonText(JSON.stringify(parsed, null, 2));
    setJsonError(null);
    setOidPickerOpen(false);
    notify(`Inserted override "${key}". Save to apply to responder.`, 'success');
  };

  const handleSaveData = async () => {
    if (jsonError) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      setJsonError('Invalid JSON syntax');
      return;
    }
    setSavingData(true);
    try {
      const res = await api.saveSimulatorData(parsed);
      const formatted = JSON.stringify(parsed, null, 2);
      setJsonText(formatted);
      setSavedJsonText(formatted);
      setSaveWarnings(Array.isArray(res.warnings) ? res.warnings : []);
      notify('Custom OID overrides saved.', 'success');
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save custom data', 'error');
    } finally {
      setSavingData(false);
    }
  };

  const handleLifecycle = async (action: 'start' | 'stop' | 'restart') => {
    setBusyAction(action);
    try {
      if (action === 'start') {
        await api.startSimulator(port, community.trim() || 'public');
        notify(`Simulator started on UDP ${port}.`, 'success');
      } else if (action === 'stop') {
        await api.stopSimulator();
        notify('Simulator stopped.', 'info');
      } else {
        await api.restartSimulator();
        notify('Simulator restarted.', 'success');
      }
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : `Failed to ${action} simulator`, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearLogs = async () => {
    const ok = await confirm({
      title: 'Clear simulator logs?',
      message: 'This clears the in-memory simulator request and lifecycle log history.',
      confirmLabel: 'Clear Logs',
    });
    if (!ok) return;
    try {
      await api.clearSimulatorLogs();
      clearLocalSimulatorLogs();
      notify('Simulator logs cleared.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to clear logs', 'error');
    }
  };

  const levelCounts = useMemo(() => countLogsByLevel(simulatorLogs), [simulatorLogs]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return simulatorLogs.filter((entry) => {
      const lvl = entry.level.toLowerCase();
      if (logLevel !== 'all') {
        if (logLevel === 'warning' && lvl !== 'warning' && lvl !== 'warn') return false;
        if (logLevel === 'error' && lvl !== 'error' && lvl !== 'danger') return false;
        if (logLevel !== 'warning' && logLevel !== 'error' && lvl !== logLevel) return false;
      }
      if (!q) return true;
      return (
        entry.message.toLowerCase().includes(q) ||
        entry.time.toLowerCase().includes(q) ||
        (entry.request_type || '').toLowerCase().includes(q)
      );
    });
  }, [simulatorLogs, logSearch, logLevel]);

  useEffect(() => {
    if (followLogs && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [filteredLogs.length, followLogs]);

  const running = Boolean(simulatorStatus?.running);

  return (
    <div className="h-full flex flex-col lg:flex-row overflow-hidden">
      {/* Left Workbench Pane: Runtime Control + Custom OID JSON Editor */}
      <div className="w-full lg:w-[430px] xl:w-[465px] shrink-0 flex flex-col border-b lg:border-b-0 lg:border-r border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] overflow-y-auto">
        {/* Runtime Header */}
        <div className="p-4 border-b border-[var(--tui-border-default)] space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">SNMP Responder</h2>
              <p className="text-[11px] font-mono text-[var(--tui-ink-muted)] mt-0.5 tabular-nums">
                {running
                  ? `UDP ${simulatorStatus?.port} · PID ${simulatorStatus?.pid ?? 'in-proc'}`
                  : 'Responder stopped'}
              </p>
            </div>
            <StatusLabel
              tone={running ? 'success' : 'neutral'}
              label={running ? 'RUNNING' : 'STOPPED'}
              liveDot={running}
            />
          </div>

          <div className="grid grid-cols-3 gap-px bg-[var(--tui-border-default)] border border-[var(--tui-border-default)] rounded-lg overflow-hidden text-center">
            <div className="bg-[var(--tui-bg-subtle)] py-2 px-2">
              <div className="text-[10px] text-[var(--tui-ink-muted)]">Uptime</div>
              <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] tabular-nums mt-0.5">
                {formatUptime(liveUptime)}
              </div>
            </div>
            <div className="bg-[var(--tui-bg-subtle)] py-2 px-2">
              <div className="text-[10px] text-[var(--tui-ink-muted)]">Requests</div>
              <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] tabular-nums mt-0.5">
                {stats?.simulator.snmp_requests_served ?? simulatorStatus?.requests_served ?? 0}
              </div>
            </div>
            <div className="bg-[var(--tui-bg-subtle)] py-2 px-2">
              <div className="text-[10px] text-[var(--tui-ink-muted)]">Last Activity</div>
              <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] tabular-nums mt-0.5 truncate">
                {formatRelativeTime(simulatorStatus?.last_activity)}
              </div>
            </div>
          </div>

          {/* Port & Community */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="next-sim-port" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                UDP Port
              </label>
              <input
                id="next-sim-port"
                type="number"
                min={1}
                max={65535}
                disabled={running}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] disabled:opacity-60 focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>
            <div>
              <label htmlFor="next-sim-comm" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Community
              </label>
              <input
                id="next-sim-comm"
                type="text"
                disabled={running}
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] disabled:opacity-60 focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={running || busyAction !== null}
              onClick={() => void handleLifecycle('start')}
              className="flex-1 h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center justify-center gap-1.5 bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-45 transition-colors cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Start</span>
            </button>
            <button
              type="button"
              disabled={!running || busyAction !== null}
              onClick={() => void handleLifecycle('stop')}
              className="flex-1 h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center justify-center gap-1.5 bg-[var(--tui-danger-btn-bg)] text-[var(--tui-danger-btn-ink)] hover:bg-[var(--tui-danger-btn-hover)] disabled:opacity-45 transition-colors cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
            <button
              type="button"
              disabled={!running || busyAction !== null}
              onClick={() => void handleLifecycle('restart')}
              aria-label="Restart simulator"
              title="Restart simulator"
              className="h-8 w-9 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] inline-flex items-center justify-center text-[var(--tui-ink-primary)] disabled:opacity-45 transition-colors cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Custom Data JSON Editor */}
        <div className="flex-1 flex flex-col p-4 min-h-[280px]">
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-[var(--tui-ink-primary)]">Custom OID Overrides</h3>
              {dirty && <StatusLabel tone="warning" label="Unsaved" />}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setOidPickerOpen(true)}
                title="Pick a MIB object to insert into overrides"
                className="h-7 px-2 rounded border border-[var(--tui-brand-border)] bg-[var(--tui-brand-soft)] text-[var(--tui-brand-ink)] hover:brightness-95 dark:hover:brightness-110 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <BookOpen className="w-3 h-3" />
                <span>Insert OID</span>
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={() => {
                    setJsonText(savedJsonText);
                    setJsonError(null);
                  }}
                  title="Revert unsaved edits"
                  aria-label="Revert custom OID edits"
                  className="h-7 w-7 rounded border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-secondary)] inline-flex items-center justify-center cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
              <button
                type="button"
                onClick={handleFormatJson}
                title="Format JSON"
                aria-label="Format JSON"
                className="h-7 px-2 rounded border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[11px] font-medium text-[var(--tui-ink-secondary)] inline-flex items-center gap-1 cursor-pointer"
              >
                <Braces className="w-3 h-3" />
              </button>
              <button
                type="button"
                disabled={Boolean(jsonError) || savingData}
                onClick={() => void handleSaveData()}
                className="h-7 px-2.5 rounded text-[11px] font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-45 inline-flex items-center gap-1 cursor-pointer"
              >
                <Save className="w-3 h-3" />
                <span>{savingData ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </div>

          <p className="text-[11px] text-[var(--tui-ink-muted)] mb-2">
            Map symbolic or numeric OIDs to custom values, e.g.{' '}
            <code className="px-1 py-0.5 rounded bg-[var(--tui-bg-muted)] text-[var(--tui-ink-primary)]">
              IF-MIB::ifSpeed.1
            </code>
            .
          </p>

          {saveWarnings.length > 0 && (
            <div className="mb-2 p-2.5 rounded-md bg-[var(--tui-warning-soft)] border border-[var(--tui-warning-border)] text-[11px] text-[var(--tui-warning-ink)]">
              <div className="font-semibold mb-1">Saved with warnings:</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {saveWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <textarea
            aria-label="Custom OID overrides JSON"
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full min-h-[200px] p-3 rounded-lg font-mono text-xs leading-relaxed bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] resize-none focus:border-[var(--tui-brand)] focus:outline-none"
          />

          {jsonError && (
            <div
              role="alert"
              className="mt-2 px-2.5 py-1.5 rounded-md bg-[var(--tui-danger-soft)] border border-[var(--tui-danger-border)] text-[11px] font-mono text-[var(--tui-danger-ink)]"
            >
              {jsonError}
            </div>
          )}
        </div>
      </div>

      {/* Right Workbench Pane: High-Contrast Live Activity Terminal */}
      <div className="flex-1 min-w-0 flex flex-col bg-[var(--tui-bg-canvas)] overflow-hidden">
        {/* Toolbar */}
        <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Filter activity logs..."
                aria-label="Filter activity logs"
                className="h-8 pl-8 pr-3 w-52 rounded-md text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>

            <div className="inline-flex items-center p-0.5 rounded-md bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)]">
              {(['all', 'info', 'success', 'warning', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLogLevel(lvl)}
                  className={`px-2 py-1 text-[11px] font-medium rounded-[4px] capitalize transition-colors cursor-pointer ${
                    logLevel === lvl
                      ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                      : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
                  }`}
                >
                  {lvl}{' '}
                  <span className="font-mono tabular-nums opacity-75">{levelCounts[lvl]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFollowLogs((f) => !f)}
              className={`h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border transition-colors cursor-pointer ${
                followLogs
                  ? 'bg-[var(--tui-brand-soft)] border-[var(--tui-brand-border)] text-[var(--tui-brand-ink)]'
                  : 'bg-[var(--tui-bg-surface)] border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
              }`}
            >
              <ArrowDownToLine className="w-3.5 h-3.5" />
              <span>Follow</span>
            </button>
            <button
              type="button"
              onClick={() =>
                downloadTextFile(
                  'trishul-simulator-logs.json',
                  JSON.stringify(filteredLogs, null, 2),
                  'application/json'
                )
              }
              title="Export filtered logs as JSON"
              aria-label="Export logs as JSON"
              className="h-8 w-8 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] inline-flex items-center justify-center text-[var(--tui-ink-secondary)] cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleClearLogs()}
              title="Clear logs"
              aria-label="Clear simulator logs"
              className="h-8 w-8 rounded-md border border-[var(--tui-danger-border)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-danger-soft)] inline-flex items-center justify-center text-[var(--tui-danger-ink)] cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Terminal Stream Body */}
        <div
          ref={logBoxRef}
          className="flex-1 overflow-y-auto p-4 bg-[var(--tui-bg-terminal)] text-slate-200 font-mono text-xs leading-relaxed"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-500">
              {simulatorLogs.length === 0
                ? 'Waiting for simulator activity...'
                : 'No log entries match the active filter.'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLogs.map((entry, idx) => {
                const lvl = entry.level.toLowerCase();
                const badgeColor =
                  lvl === 'success'
                    ? 'text-emerald-400'
                    : lvl === 'warning' || lvl === 'warn'
                      ? 'text-amber-400'
                      : lvl === 'error' || lvl === 'danger'
                        ? 'text-rose-400'
                        : 'text-sky-400';
                return (
                  <div
                    key={`${idx}-${entry.time}`}
                    className="flex items-start gap-3 py-1 border-b border-slate-800/70"
                  >
                    <span className="text-slate-500 shrink-0 tabular-nums">[{entry.time}]</span>
                    <span className={`uppercase text-[10px] font-semibold w-14 shrink-0 pt-0.5 ${badgeColor}`}>
                      {lvl}
                    </span>
                    <span className="text-slate-200 break-words flex-1">{entry.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Insert OID Override Drawer */}
      <MibObjectPickerDrawer
        open={oidPickerOpen}
        onClose={() => setOidPickerOpen(false)}
        title="Insert Custom OID Override"
        subtitle="Select any compiled MIB object to append a typed default override entry to the JSON editor"
        actionLabel="Insert"
        onSelect={handleInsertOidOverride}
      />
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  ArrowUpDown,
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  FolderTree,
  Play,
  Search,
  Server,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  downloadTextFile,
  formatRelativeTime,
  isNumericOid,
  normalizeWalkTableRows,
  toCsv,
  toTsv,
} from '../lib/workbench';
import { useWorkbench } from '../context/WorkbenchContext';
import { EmptyPane, SecretInput } from '../components/UiPrimitives';
import { MibObjectPickerDrawer } from '../components/MibObjectPickerDrawer';
import type { MibNodeRecord, WalkExecuteResponse, WalkHistoryEntry } from '../types/api';

const WALK_HISTORY_KEY = 'trishul_walk_history';
const WALK_DRAFT_KEY = 'trishul_walk_draft';
const WALK_TARGETS_KEY = 'trishul_walker_targets';

const QUICK_OID_PRESETS = [
  { label: 'system', oid: '1.3.6.1.2.1.1' },
  { label: 'interfaces', oid: '1.3.6.1.2.1.2' },
  { label: 'ifXTable', oid: '1.3.6.1.2.1.31.1.1' },
  { label: 'snmp', oid: '1.3.6.1.2.1.11' },
];

interface WalkDraft {
  target?: string;
  port?: number;
  community?: string;
  oid?: string;
  parse?: boolean;
  useMibs?: boolean;
  jsonFormat?: 'flat' | 'grouped';
  timeoutMs?: number;
  retries?: number;
}

function clampTimeoutMs(val: number): number {
  if (!Number.isFinite(val)) return 2000;
  return Math.min(10000, Math.max(500, Math.round(val)));
}

function clampRetries(val: number): number {
  if (!Number.isFinite(val)) return 1;
  return Math.min(5, Math.max(0, Math.round(val)));
}

function loadWalkDraft(): WalkDraft {
  try {
    const raw = localStorage.getItem(WALK_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as WalkDraft) : {};
  } catch {
    return {};
  }
}

function loadWalkHistory(): WalkHistoryEntry[] {
  try {
    const raw = localStorage.getItem(WALK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadRecentTargets(): string[] {
  try {
    const raw = localStorage.getItem(WALK_TARGETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export const WalkerWorkspace: React.FC = () => {
  const { simulatorStatus, handoff, clearHandoff, navigate, notify, refreshLiveState } = useWorkbench();

  const initialDraft = useMemo(() => loadWalkDraft(), []);
  const [target, setTarget] = useState(initialDraft.target || '127.0.0.1');
  const [port, setPort] = useState(initialDraft.port || simulatorStatus?.port || 1061);
  const [portEdited, setPortEdited] = useState(Boolean(initialDraft.port));
  const [community, setCommunity] = useState(initialDraft.community || 'public');
  const [oid, setOid] = useState(initialDraft.oid || '1.3.6.1.2.1.1');
  const [parse, setParse] = useState(initialDraft.parse ?? true);
  const [useMibs, setUseMibs] = useState(initialDraft.useMibs ?? true);
  const [jsonFormat, setJsonFormat] = useState<'flat' | 'grouped'>(initialDraft.jsonFormat || 'flat');
  const [timeoutMs, setTimeoutMs] = useState(clampTimeoutMs(initialDraft.timeoutMs ?? 2000));
  const [retries, setRetries] = useState(clampRetries(initialDraft.retries ?? 1));

  const [recentTargets, setRecentTargets] = useState<string[]>(() => loadRecentTargets());
  const [resolvedPreview, setResolvedPreview] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [oidSuggestions, setOidSuggestions] = useState<MibNodeRecord[]>([]);
  const [oidSuggestOpen, setOidSuggestOpen] = useState(false);
  const oidInputFocusedRef = useRef(false);

  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [result, setResult] = useState<WalkExecuteResponse | null>(null);
  const [lastRunTarget, setLastRunTarget] = useState<string>('127.0.0.1');
  const [viewMode, setViewMode] = useState<'table' | 'json' | 'raw'>('table');
  const [filterQuery, setFilterQuery] = useState('');
  const [sortCol, setSortCol] = useState<'oid' | 'type' | 'value'>('oid');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [history, setHistory] = useState<WalkHistoryEntry[]>(() => loadWalkHistory());
  const [pickerOpen, setPickerOpen] = useState(false);

  // Persist draft automatically (including timeoutMs & retries)
  useEffect(() => {
    try {
      localStorage.setItem(
        WALK_DRAFT_KEY,
        JSON.stringify({ target, port, community, oid, parse, useMibs, jsonFormat, timeoutMs, retries })
      );
    } catch {
      // ignore storage errors
    }
  }, [target, port, community, oid, parse, useMibs, jsonFormat, timeoutMs, retries]);

  // Consume cross-workspace handoff (e.g., from MIB Browser or Cmd+K)
  useEffect(() => {
    if (handoff?.walkOid) {
      setOid(handoff.walkOid);
      setResolvedPreview(null);
      setOidSuggestOpen(false);
      clearHandoff();
    }
  }, [handoff, clearHandoff]);

  // Keep local simulator port in sync if user has not overridden port
  useEffect(() => {
    if (!portEdited && target === '127.0.0.1' && simulatorStatus?.port) {
      setPort(simulatorStatus.port);
    }
  }, [portEdited, target, simulatorStatus?.port]);

  // Live OID / Symbol typeahead suggestions
  useEffect(() => {
    const q = oid.trim();
    if (q.length < 2) {
      setOidSuggestions([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.searchBrowse(q, undefined, undefined, 6);
        if (!active) return;
        setOidSuggestions((res.results || []).slice(0, 6));
      } catch {
        if (active) setOidSuggestions([]);
      }
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [oid]);

  const persistHistory = (next: WalkHistoryEntry[]) => {
    setHistory(next);
    try {
      localStorage.setItem(WALK_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const rememberTarget = (host: string) => {
    const clean = host.trim();
    if (!clean) return;
    const next = [clean, ...recentTargets.filter((t) => t !== clean)].slice(0, 12);
    setRecentTargets(next);
    try {
      localStorage.setItem(WALK_TARGETS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const handleResolvePreview = async () => {
    const trimmed = oid.trim();
    if (!trimmed) return;
    setResolving(true);
    try {
      const res = await api.resolveOid(trimmed, isNumericOid(trimmed) ? 'symbolic' : 'numeric');
      if (res.resolved && res.output) {
        setResolvedPreview(res.output);
      } else {
        setResolvedPreview('No translation found in active MIB bundle');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'OID resolution failed', 'error');
    } finally {
      setResolving(false);
    }
  };

  const handleCancelWalk = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setRunning(false);
      notify('SNMP walk cancelled.', 'info');
    }
  };

  const runWalk = async (override?: Partial<WalkHistoryEntry>) => {
    const reqTarget = (override?.target ?? target).trim();
    const reqPort = override?.port ?? port;
    const reqComm = (override?.community ?? community).trim() || 'public';
    const reqOid = (override?.oid ?? oid).trim();
    const reqParse = override?.parse ?? parse;
    const reqMibs = override?.use_mibs ?? useMibs;
    const reqFormat = override?.json_format ?? jsonFormat;
    const reqTimeoutMs = clampTimeoutMs(override?.timeout_ms ?? timeoutMs);
    const reqRetries = clampRetries(override?.retries ?? retries);

    if (!reqTarget || !reqOid) {
      notify('Target host and OID are required.', 'warning');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    try {
      const res = await api.executeWalk(
        {
          target: reqTarget,
          port: reqPort,
          community: reqComm,
          oid: reqOid,
          parse: reqParse,
          use_mibs: reqMibs,
          json_format: reqFormat,
          timeout_ms: reqTimeoutMs,
          retries: reqRetries,
        },
        controller.signal
      );
      setResult(res);
      setLastRunTarget(reqTarget);
      const tableAvailable = normalizeWalkTableRows(res).length > 0;
      setViewMode(tableAvailable ? 'table' : !reqParse || res.mode === 'raw' ? 'raw' : 'json');
      rememberTarget(reqTarget);

      const entry: WalkHistoryEntry = {
        id: `${Date.now()}`,
        timestamp: new Date().toISOString(),
        target: reqTarget,
        port: reqPort,
        community: reqComm,
        oid: reqOid,
        parse: reqParse,
        use_mibs: reqMibs,
        json_format: reqFormat,
        timeout_ms: reqTimeoutMs,
        retries: reqRetries,
        count: res.count ?? 0,
      };
      persistHistory(
        [
          entry,
          ...history.filter((h) => !(h.target === reqTarget && h.port === reqPort && h.oid === reqOid)),
        ].slice(0, 20)
      );
      notify(`Walk completed: ${res.count} items.`, 'success');
      await refreshLiveState();
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      notify(err instanceof Error ? err.message : 'SNMP walk failed', 'error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const tableRows = useMemo(() => normalizeWalkTableRows(result), [result]);

  const filteredRows = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const matched = tableRows.filter((row) => {
      if (!q) return true;
      return (
        row.oid.toLowerCase().includes(q) ||
        row.symbolic.toLowerCase().includes(q) ||
        row.type.toLowerCase().includes(q) ||
        row.value.toLowerCase().includes(q) ||
        row.enumLabel.toLowerCase().includes(q) ||
        row.labelsText.toLowerCase().includes(q) ||
        row.module.toLowerCase().includes(q)
      );
    });
    return [...matched].sort((a, b) => {
      const av = sortCol === 'oid' ? a.symbolic || a.oid : sortCol === 'type' ? a.type : a.value;
      const bv = sortCol === 'oid' ? b.symbolic || b.oid : sortCol === 'type' ? b.type : b.value;
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [tableRows, filterQuery, sortCol, sortDir]);

  const filteredRawLines = useMemo(() => {
    if (!result) return [];
    const lines =
      result.rawLines && result.rawLines.length > 0
        ? result.rawLines
        : result.raw
          ? result.raw.split(/\r?\n/)
          : result.mode === 'raw' && Array.isArray(result.data)
            ? result.data.map((x) => String(x))
            : [];
    const q = filterQuery.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((line) => line.toLowerCase().includes(q));
  }, [result, filterQuery]);

  const filteredJsonData = useMemo(() => {
    if (!result) return null;
    const rawData = result.data ?? result;
    const q = filterQuery.trim().toLowerCase();
    if (!q || !Array.isArray(rawData)) return rawData;
    return rawData.filter((entry) => JSON.stringify(entry).toLowerCase().includes(q));
  }, [result, filterQuery]);

  const toggleSort = (col: 'oid' | 'type' | 'value') => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const handleCopyOutput = async () => {
    if (!result) return;
    const text =
      viewMode === 'raw' && filteredRawLines.length > 0
        ? filteredRawLines.join('\n')
        : JSON.stringify(filteredJsonData ?? result.data ?? result, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      notify('Walk output copied to clipboard.', 'success');
    } catch {
      notify('Unable to copy to clipboard.', 'error');
    }
  };

  const handleCopyTsv = async () => {
    if (filteredRows.length === 0) return;
    const isGrouped = result?.json_format === 'grouped';
    const tsv = isGrouped
      ? toTsv(
          filteredRows.map((r) => ({
            metric: r.symbolic || r.oid,
            module: r.type,
            labels: r.labelsText,
            value: r.value,
            units: r.units,
            oid: r.numericOid,
          })),
          [
            { key: 'metric', label: 'Metric' },
            { key: 'module', label: 'Module/Category' },
            { key: 'labels', label: 'Labels' },
            { key: 'value', label: 'Value' },
            { key: 'units', label: 'Units' },
            { key: 'oid', label: 'OID' },
          ]
        )
      : toTsv(
          filteredRows.map((r) => ({
            oid: r.symbolic || r.oid,
            numeric_oid: r.numericOid || r.oid,
            type: r.type,
            value: r.value,
            enum_label: r.enumLabel,
          })),
          [
            { key: 'oid', label: 'Symbol' },
            { key: 'numeric_oid', label: 'OID' },
            { key: 'type', label: 'Type' },
            { key: 'value', label: 'Value' },
            { key: 'enum_label', label: 'Enum' },
          ]
        );
    try {
      await navigator.clipboard.writeText(tsv);
      notify(`Copied ${filteredRows.length} rows as TSV (spreadsheet-ready).`, 'success');
    } catch {
      notify('Unable to copy TSV to clipboard.', 'error');
    }
  };

  const handleExportJson = () => {
    if (!result) return;
    const hostLabel = (lastRunTarget || target || 'walk').replace(/[^A-Za-z0-9_.-]+/g, '_');
    downloadTextFile(
      `walk-${hostLabel}-${Date.now()}.json`,
      JSON.stringify(filteredJsonData ?? result.data ?? result, null, 2),
      'application/json'
    );
  };

  const handleExportCsv = () => {
    if (filteredRows.length === 0) return;
    const hostLabel = (lastRunTarget || target || 'walk').replace(/[^A-Za-z0-9_.-]+/g, '_');
    const isGrouped = result?.json_format === 'grouped';
    const csv = isGrouped
      ? toCsv(
          filteredRows.map((r) => ({
            metric: r.symbolic || r.oid,
            module: r.type,
            labels: r.labelsText,
            value: r.value,
            enum_label: r.enumLabel,
            units: r.units,
            oid: r.numericOid,
          })),
          [
            { key: 'metric', label: 'Metric' },
            { key: 'module', label: 'Module/Category' },
            { key: 'labels', label: 'Labels' },
            { key: 'value', label: 'Value' },
            { key: 'enum_label', label: 'Enum' },
            { key: 'units', label: 'Units' },
            { key: 'oid', label: 'OID' },
          ]
        )
      : toCsv(
          filteredRows.map((r) => ({
            oid: r.numericOid || r.oid,
            symbolic: r.symbolic,
            type: r.type,
            value: r.value,
            enum_label: r.enumLabel,
            units: r.units,
          })),
          [
            { key: 'oid', label: 'OID' },
            { key: 'symbolic', label: 'Symbolic' },
            { key: 'type', label: 'Type' },
            { key: 'value', label: 'Value' },
            { key: 'enum_label', label: 'Enum' },
            { key: 'units', label: 'Units' },
          ]
        );
    downloadTextFile(`walk-${hostLabel}-${Date.now()}.csv`, csv, 'text/csv;charset=utf-8');
  };

  const isGroupedLayout = result?.json_format === 'grouped';

  return (
    <div className="min-h-full lg:h-full flex flex-col lg:flex-row lg:overflow-hidden">
      {/* Left Rail: Target Configuration & Walk History */}
      <div className="w-full lg:w-[360px] shrink-0 flex flex-col border-b lg:border-b-0 lg:border-r border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] lg:overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runWalk();
          }}
          className="p-4 border-b border-[var(--tui-border-default)] space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">Walk Target</h2>
            <button
              type="button"
              onClick={() => {
                const simPort = simulatorStatus?.port || 1061;
                setTarget('127.0.0.1');
                setPort(simPort);
                setPortEdited(true);
                setCommunity(simulatorStatus?.community || 'public');
                notify(
                  `Targeted local simulator (127.0.0.1:${simPort}).`,
                  'info'
                );
              }}
              className="h-6 px-2 rounded border border-[var(--tui-border-control)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[11px] font-medium text-[var(--tui-ink-secondary)] hover:text-[var(--tui-ink-primary)] inline-flex items-center gap-1 cursor-pointer"
            >
              <Server className="w-3 h-3 text-[var(--tui-brand)]" />
              <span>Local Sim</span>
            </button>
          </div>

          <div>
            <label htmlFor="next-walk-host" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
              Target Host
            </label>
            <input
              id="next-walk-host"
              list="next-walk-recent-targets"
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="127.0.0.1"
              className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
            />
            <datalist id="next-walk-recent-targets">
              {recentTargets.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="next-walk-port" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Port
              </label>
              <input
                id="next-walk-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => {
                  setPort(Number(e.target.value));
                  setPortEdited(true);
                }}
                className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
              />
            </div>
            <div>
              <label htmlFor="next-walk-comm" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Community
              </label>
              <SecretInput
                id="next-walk-comm"
                value={community}
                onChange={setCommunity}
                toggleLabel="walk community"
                className="!bg-[var(--tui-bg-canvas)]"
              />
            </div>
          </div>

          <div className="relative">
            <label htmlFor="next-walk-oid" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
              Root OID / Symbol
            </label>
            <div className="flex gap-1.5">
              <input
                id="next-walk-oid"
                type="text"
                value={oid}
                autoComplete="off"
                onFocus={() => {
                  oidInputFocusedRef.current = true;
                  if (oidSuggestions.length > 0) setOidSuggestOpen(true);
                }}
                onBlur={() => {
                  oidInputFocusedRef.current = false;
                  window.setTimeout(() => {
                    if (!oidInputFocusedRef.current) setOidSuggestOpen(false);
                  }, 150);
                }}
                onChange={(e) => {
                  setOid(e.target.value);
                  setResolvedPreview(null);
                  setOidSuggestOpen(true);
                }}
                placeholder="1.3.6.1.2.1.1 or IF-MIB::ifTable"
                className="flex-1 min-w-0 h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
              />
              <button
                type="button"
                disabled={resolving || !oid.trim()}
                onClick={() => void handleResolvePreview()}
                title="Resolve OID ↔ Symbol preview"
                aria-label="Resolve OID"
                className="h-8 w-8 shrink-0 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] inline-flex items-center justify-center text-[var(--tui-ink-secondary)] hover:text-[var(--tui-brand-ink)] disabled:opacity-40 cursor-pointer"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                title="Browse MIB OIDs"
                aria-label="Browse MIB OIDs"
                className="h-8 w-8 shrink-0 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] inline-flex items-center justify-center text-[var(--tui-ink-secondary)] hover:text-[var(--tui-brand-ink)] cursor-pointer"
              >
                <FolderTree className="w-3.5 h-3.5" />
              </button>
            </div>

            {oidSuggestOpen && oidSuggestions.length > 0 && (
              <ul
                role="listbox"
                aria-label="Matching OIDs"
                className="mt-1 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] shadow-md divide-y divide-[var(--tui-border-subtle)] max-h-44 overflow-y-auto z-20"
              >
                {oidSuggestions.map((item) => {
                  const targetVal = item.full_name || item.oid;
                  return (
                    <li key={`${item.module}-${item.oid}`}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setOid(targetVal);
                          setResolvedPreview(item.oid && item.oid !== targetVal ? item.oid : null);
                          setOidSuggestOpen(false);
                        }}
                        className="w-full px-2.5 py-1.5 text-left hover:bg-[var(--tui-bg-hover)] flex items-center justify-between gap-2 cursor-pointer"
                      >
                        <span className="font-mono text-[11px] font-medium text-[var(--tui-ink-primary)] truncate">
                          {item.full_name || item.name}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--tui-ink-muted)] shrink-0">
                          {item.oid}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {resolvedPreview && (
              <div className="mt-1.5 px-2 py-1 rounded bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[10px] font-mono text-[var(--tui-brand-ink)] truncate">
                → {resolvedPreview}
              </div>
            )}

            {/* Quick OID Presets */}
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {QUICK_OID_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setOid(p.oid);
                    setResolvedPreview(null);
                  }}
                  className={`px-2 py-0.5 rounded font-mono text-[10px] border transition-colors cursor-pointer ${
                    oid === p.oid
                      ? 'bg-[var(--tui-brand-soft)] border-[var(--tui-brand-border)] text-[var(--tui-brand-ink)] font-semibold'
                      : 'bg-[var(--tui-bg-subtle)] border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer text-[var(--tui-ink-secondary)]">
              <input
                type="checkbox"
                checked={parse}
                onChange={(e) => setParse(e.target.checked)}
                className="accent-[var(--tui-brand)]"
              />
              <span>Structured</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer text-[var(--tui-ink-secondary)]">
              <input
                type="checkbox"
                checked={useMibs}
                onChange={(e) => setUseMibs(e.target.checked)}
                className="accent-[var(--tui-brand)]"
              />
              <span>Resolve MIBs</span>
            </label>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="next-walk-layout" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Layout
              </label>
              <select
                id="next-walk-layout"
                value={jsonFormat}
                onChange={(e) => setJsonFormat(e.target.value as 'flat' | 'grouped')}
                disabled={!parse}
                className="w-full h-8 px-2 rounded-md text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] disabled:opacity-50"
              >
                <option value="flat">Flat</option>
                <option value="grouped">Grouped</option>
              </select>
            </div>
            <div>
              <label htmlFor="next-walk-timeout" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Timeout (ms)
              </label>
              <input
                id="next-walk-timeout"
                type="number"
                min={500}
                max={10000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                onBlur={() => setTimeoutMs((prev) => clampTimeoutMs(prev))}
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)]"
              />
            </div>
            <div>
              <label htmlFor="next-walk-retries" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Retries
              </label>
              <input
                id="next-walk-retries"
                type="number"
                min={0}
                max={5}
                value={retries}
                onChange={(e) => setRetries(Number(e.target.value))}
                onBlur={() => setRetries((prev) => clampRetries(prev))}
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)]"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={running}
              className="tui-btn-primary flex-1 h-9 rounded-md text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-all cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{running ? 'Walking...' : 'Run Walk'}</span>
            </button>
            {running && (
              <button
                type="button"
                onClick={handleCancelWalk}
                className="h-9 px-3 rounded-md text-xs font-semibold bg-[var(--tui-danger-btn-bg)] text-[var(--tui-danger-btn-ink)] hover:bg-[var(--tui-danger-btn-hover)] inline-flex items-center gap-1 cursor-pointer"
              >
                <Square className="w-3 h-3" />
                <span>Cancel</span>
              </button>
            )}
          </div>
        </form>

        {/* Walk History */}
        <div className="flex-1 flex flex-col min-h-[160px]">
          <div className="px-4 py-2.5 border-b border-[var(--tui-border-subtle)] flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--tui-ink-primary)]">
              Walk History{' '}
              <span className="font-mono font-normal text-[var(--tui-ink-muted)]">({history.length})</span>
            </span>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => persistHistory([])}
                aria-label="Clear walk history"
                className="text-[11px] text-[var(--tui-ink-muted)] hover:text-[var(--tui-danger-ink)] cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
          <div className="divide-y divide-[var(--tui-border-subtle)] overflow-y-auto flex-1">
            {history.length === 0 ? (
              <div className="p-4 text-xs text-[var(--tui-ink-muted)] text-center">
                Recent walks appear here for quick replay.
              </div>
            ) : (
              history.map((item) => (
                <div
                  key={item.id}
                  className="px-4 py-2.5 flex items-start justify-between gap-2 hover:bg-[var(--tui-bg-hover)] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setTarget(item.target);
                      setPort(item.port);
                      setCommunity(item.community);
                      setOid(item.oid);
                      setParse(item.parse);
                      setUseMibs(item.use_mibs);
                      setJsonFormat(item.json_format);
                      setTimeoutMs(clampTimeoutMs(item.timeout_ms ?? 2000));
                      setRetries(clampRetries(item.retries ?? 1));
                      void runWalk(item);
                    }}
                    className="flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <div className="font-mono text-xs font-semibold text-[var(--tui-ink-primary)] truncate">
                      {item.target}:{item.port}
                    </div>
                    <div className="font-mono text-[11px] text-[var(--tui-ink-muted)] truncate mt-0.5">
                      {item.oid}
                    </div>
                    <div className="text-[10px] text-[var(--tui-ink-muted)] mt-0.5">
                      {item.count} items · {clampTimeoutMs(item.timeout_ms ?? 2000)}ms ·{' '}
                      {formatRelativeTime(item.timestamp)}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => persistHistory(history.filter((h) => h.id !== item.id))}
                    aria-label={`Remove ${item.oid} from history`}
                    className="p-1 text-[var(--tui-ink-muted)] hover:text-[var(--tui-danger-ink)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Right Stage: Walk Results */}
      <div className="flex-1 min-w-0 flex flex-col bg-[var(--tui-bg-canvas)] lg:overflow-hidden min-h-[380px]">
        <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-3">
            <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">Results</h2>
            {result && (
              <span className="text-xs font-mono text-[var(--tui-ink-muted)] tabular-nums">
                {result.count} items
                {result.duration_ms != null ? ` · ${result.duration_ms}ms` : ''}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--tui-ink-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter output..."
                aria-label="Filter walk output"
                className="h-8 pl-8 pr-7 w-44 rounded-md text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
              />
              {filterQuery && (
                <button
                  type="button"
                  onClick={() => setFilterQuery('')}
                  aria-label="Clear walk output filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="inline-flex items-center p-0.5 rounded-md bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)]">
              {(['table', 'json', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  disabled={m === 'table' && tableRows.length === 0}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-[4px] uppercase transition-colors cursor-pointer disabled:opacity-40 ${
                    viewMode === m
                      ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                      : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={!result}
              onClick={() => void handleCopyOutput()}
              title="Copy output"
              aria-label="Copy walk output"
              className="h-8 w-8 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] inline-flex items-center justify-center text-[var(--tui-ink-secondary)] disabled:opacity-40 cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={filteredRows.length === 0}
              onClick={() => void handleCopyTsv()}
              title="Copy table as TSV for Excel/Sheets"
              className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
            >
              <ClipboardList className="w-3.5 h-3.5" />
              <span>TSV</span>
            </button>
            <button
              type="button"
              disabled={!result}
              onClick={handleExportJson}
              className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>JSON</span>
            </button>
            <button
              type="button"
              disabled={filteredRows.length === 0}
              onClick={handleExportCsv}
              className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>
            {result && (
              <button
                type="button"
                onClick={() => setResult(null)}
                aria-label="Clear walk results"
                className="h-8 w-8 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-danger-soft)] text-[var(--tui-ink-muted)] hover:text-[var(--tui-danger-ink)] inline-flex items-center justify-center cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {!result ? (
            <EmptyPane
              icon={<Play className="w-4 h-4" />}
              title="Ready to walk"
              description="Configure a target host and OID on the left—or click Local Sim to target the built-in responder—and run a walk to inspect parsed rows."
            />
          ) : viewMode === 'table' && tableRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[11px] font-semibold text-[var(--tui-ink-muted)]">
                  <tr>
                    <th
                      scope="col"
                      aria-sort={sortCol === 'oid' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className="py-2.5 px-4"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort('oid')}
                        className="inline-flex items-center gap-1 hover:text-[var(--tui-ink-primary)] cursor-pointer"
                      >
                        <span>{isGroupedLayout ? 'Metric' : 'OID'}</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th
                      scope="col"
                      aria-sort={sortCol === 'type' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className="py-2.5 px-4 w-44"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort('type')}
                        className="inline-flex items-center gap-1 hover:text-[var(--tui-ink-primary)] cursor-pointer"
                      >
                        <span>{isGroupedLayout ? 'Module / Labels' : 'Type'}</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th
                      scope="col"
                      aria-sort={sortCol === 'value' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className="py-2.5 px-4"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort('value')}
                        className="inline-flex items-center gap-1 hover:text-[var(--tui-ink-primary)] cursor-pointer"
                      >
                        <span>Value</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th scope="col" className="py-2.5 px-3 w-12 text-right">
                      MIB
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--tui-border-subtle)] bg-[var(--tui-bg-surface)] font-mono text-xs tabular-nums">
                  {filteredRows.map((row, i) => (
                    <tr key={`${row.oid}-${i}`} className="hover:bg-[var(--tui-bg-hover)] transition-colors">
                      <td className="py-2 px-4 text-[var(--tui-ink-primary)] break-all">
                        <div className="font-medium">{row.symbolic || row.oid}</div>
                        {row.symbolic && row.numericOid && row.symbolic !== row.numericOid && (
                          <div className="text-[10px] text-[var(--tui-ink-muted)] mt-0.5">
                            {row.numericOid}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-4 text-[var(--tui-ink-muted)]">
                        <div className="whitespace-nowrap">{row.type}</div>
                        {row.labelsText && (
                          <div className="text-[10px] text-[var(--tui-ink-muted)] mt-0.5 break-all">
                            {row.labelsText}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-4 text-[var(--tui-ink-primary)] break-words">
                        <span>{row.value}</span>
                        {row.enumLabel && (
                          <span className="ml-2 text-[var(--tui-info-ink)] font-medium">
                            {row.enumLabel}({row.value})
                          </span>
                        )}
                        {row.units && (
                          <span className="ml-1.5 text-[var(--tui-ink-muted)]">{row.units}</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {(row.numericOid || row.oid) && (
                          <button
                            type="button"
                            onClick={() =>
                              navigate('browser', { browseOid: row.numericOid || row.oid })
                            }
                            title={`Inspect ${row.symbolic || row.oid} in MIB Browser`}
                            aria-label={`Inspect ${row.oid} in MIB Browser`}
                            className="p-1.5 rounded border border-[var(--tui-border-control)] hover:border-[var(--tui-brand-border)] hover:bg-[var(--tui-brand-soft)] text-[var(--tui-ink-muted)] hover:text-[var(--tui-brand-ink)] inline-flex items-center justify-center cursor-pointer"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : viewMode === 'raw' ? (
            <pre className="p-4 font-mono text-xs leading-relaxed text-[var(--tui-ink-primary)] whitespace-pre-wrap break-words">
              {filteredRawLines.length > 0
                ? filteredRawLines.join('\n')
                : 'No raw lines match the active filter.'}
            </pre>
          ) : (
            <pre className="p-4 font-mono text-xs leading-relaxed text-[var(--tui-ink-primary)] whitespace-pre-wrap break-words">
              {JSON.stringify(filteredJsonData ?? result.data ?? result, null, 2)}
            </pre>
          )}
        </div>
      </div>

      {/* Shared MIB Object Picker Drawer */}
      <MibObjectPickerDrawer
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Select Walk Root OID"
        subtitle="Pick any scalar, table, or subtree from the active compiled MIB bundle"
        actionLabel="Select"
        onSelect={(obj) => {
          setOid(obj.full_name || obj.oid);
          setResolvedPreview(obj.oid);
          setPickerOpen(false);
        }}
      />
    </div>
  );
};

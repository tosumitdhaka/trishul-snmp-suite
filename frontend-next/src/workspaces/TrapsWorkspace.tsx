import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Code2,
  Copy,
  Download,
  Eye,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  defaultValueForVarbind,
  downloadTextFile,
  formatConstraintHint,
  formatRelativeTime,
  formatUptime,
  inferSnmpVarbindType,
  normalizeEnums,
  toCsv,
  validateVarbindInput,
} from '../lib/workbench';
import { useWorkbench } from '../context/WorkbenchContext';
import { EmptyPane, SlideDrawer, StatusLabel } from '../components/UiPrimitives';
import { MibObjectPickerDrawer } from '../components/MibObjectPickerDrawer';
import type {
  EnumValue,
  MibObjectSearchItem,
  ReceivedTrapEvent,
  TrapCatalogItem,
} from '../types/api';

interface ComposerVarbind {
  id: string;
  oid: string;
  type: string;
  value: string;
  enumValues?: EnumValue[];
  constraint?: unknown;
  enrichedFor?: string;
}

const SNMP_TYPES = [
  'String',
  'Integer',
  'Gauge32',
  'Counter32',
  'Counter64',
  'TimeTicks',
  'IpAddress',
  'OID',
];

function varbindSignature(list: ComposerVarbind[]): string {
  return list.map((v) => `${v.oid.trim()}|${v.type}|${v.value.trim()}`).join(';;');
}

const DEFAULT_VARBINDS = (): ComposerVarbind[] => [
  { id: `vb-uptime-${Date.now()}`, oid: 'SNMPv2-MIB::sysUpTime.0', type: 'TimeTicks', value: '12345' },
];

export const TrapsWorkspace: React.FC = () => {
  const {
    trapStatus,
    recentTraps,
    setRecentTraps,
    trapsPaused,
    setTrapsPaused,
    handoff,
    clearHandoff,
    refreshLiveState,
    notify,
    confirm,
  } = useWorkbench();

  // Receiver state
  const [rxPort, setRxPort] = useState(trapStatus?.port || 1162);
  const [rxComm, setRxComm] = useState(trapStatus?.community || 'public');
  const [rxResolve, setRxResolve] = useState(trapStatus?.resolve_mibs ?? true);
  const [rxBusy, setRxBusy] = useState(false);

  // Composer state
  const [trapCatalog, setTrapCatalog] = useState<TrapCatalogItem[]>([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [targetIp, setTargetIp] = useState('127.0.0.1');
  const [targetPort, setTargetPort] = useState(1162);
  const [targetComm, setTargetComm] = useState('public');
  const [selectedTrapKey, setSelectedTrapKey] = useState('');
  const [trapOid, setTrapOid] = useState('1.3.6.1.6.3.1.1.5.3');
  const [asInform, setAsInform] = useState(false);
  const [varbinds, setVarbinds] = useState<ComposerVarbind[]>(() => DEFAULT_VARBINDS());
  const [sending, setSending] = useState(false);

  // Track pristine signature so auto-resolve on OID blur never clobbers manual user edits
  const autoSigRef = useRef<string>(varbindSignature(varbinds));

  // VarBind MIB Picker Drawer state ('append' or replacing a specific row ID)
  const [vbPickerOpen, setVbPickerOpen] = useState(false);
  const [vbPickerRowId, setVbPickerRowId] = useState<string | null>(null);
  const [vbPickerInitialQuery, setVbPickerInitialQuery] = useState('');

  // Stream table filter & drawers
  const [search, setSearch] = useState('');
  const [inspectedTrap, setInspectedTrap] = useState<ReceivedTrapEvent | null>(null);
  const [replayHost, setReplayHost] = useState('');
  const [replayPort, setReplayPort] = useState('');
  const [replaying, setReplaying] = useState(false);

  // BER Decoder drawer
  const [decodeOpen, setDecodeOpen] = useState(false);
  const [decodeEncoding, setDecodeEncoding] = useState<'hex' | 'base64'>('hex');
  const [decodePayload, setDecodePayload] = useState('');
  const [decodeResult, setDecodeResult] = useState<Record<string, unknown> | null>(null);
  const [decoding, setDecoding] = useState(false);

  useEffect(() => {
    if (trapStatus) {
      setRxPort(trapStatus.port || 1162);
      setRxComm(trapStatus.community || 'public');
      setRxResolve(trapStatus.resolve_mibs);
    }
  }, [trapStatus?.port, trapStatus?.community, trapStatus?.resolve_mibs]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.getTrapCatalog();
        if (active) setTrapCatalog(res.traps || []);
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const filteredCatalog = useMemo(() => {
    const q = catalogFilter.trim().toLowerCase();
    if (!q) return trapCatalog;
    return trapCatalog.filter(
      (t) =>
        t.full_name.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.oid.toLowerCase().includes(q) ||
        t.module.toLowerCase().includes(q)
    );
  }, [trapCatalog, catalogFilter]);

  const applyCatalogTrap = (item: TrapCatalogItem) => {
    setSelectedTrapKey(item.full_name);
    setTrapOid(item.oid);
    const nextVbs: ComposerVarbind[] = [
      { id: `vb-uptime-${Date.now()}`, oid: 'SNMPv2-MIB::sysUpTime.0', type: 'TimeTicks', value: '12345' },
      ...item.objects.map((obj, i) => {
        const enums = normalizeEnums(obj.enum_values);
        const inferred = inferSnmpVarbindType(obj);
        const inputType = SNMP_TYPES.includes(inferred) ? inferred : 'String';
        const defaultVal = defaultValueForVarbind(inputType, enums, obj.constraint);
        const oidStr = obj.full_name || obj.oid;
        return {
          id: `vb-${Date.now()}-${i}`,
          oid: oidStr,
          type: inputType,
          value: defaultVal,
          enumValues: enums,
          constraint: obj.constraint,
          enrichedFor: oidStr,
        };
      }),
    ];
    autoSigRef.current = varbindSignature(nextVbs);
    setVarbinds(nextVbs);
  };

  // Auto-resolve notification OID on blur or Enter (without clobbering manual varbind edits)
  const handleAutoResolveTrapOid = () => {
    const raw = trapOid.trim();
    if (!raw || trapCatalog.length === 0) return;
    const low = raw.toLowerCase();
    const match = trapCatalog.find(
      (t) =>
        t.oid === raw ||
        t.full_name.toLowerCase() === low ||
        t.name.toLowerCase() === low
    );
    if (!match) return;
    setSelectedTrapKey(match.full_name);
    const currentSig = varbindSignature(varbinds);
    if (currentSig === autoSigRef.current) {
      applyCatalogTrap(match);
      notify(`Auto-loaded ${match.objects.length} VarBind(s) for ${match.full_name}.`, 'info');
    }
  };

  // Consume cross-workspace handoff (from MIB Browser / MIB Manager / Cmd+K)
  useEffect(() => {
    if (!handoff?.trapOid && !handoff?.trapFullName) return;
    const match = trapCatalog.find(
      (t) =>
        (handoff.trapFullName && t.full_name === handoff.trapFullName) ||
        (handoff.trapOid && t.oid === handoff.trapOid)
    );
    if (match) {
      applyCatalogTrap(match);
    } else if (handoff.trapOid) {
      setTrapOid(handoff.trapOid);
    }
    clearHandoff();
  }, [handoff, trapCatalog, clearHandoff]);

  // Apply selected MIB object from picker drawer (either append new row or fill target row)
  const handlePickMibObject = (obj: MibObjectSearchItem) => {
    const enums = normalizeEnums(obj.enum_values);
    const inferred = inferSnmpVarbindType(obj);
    const snmpType = SNMP_TYPES.includes(inferred) ? inferred : 'String';
    const defVal = defaultValueForVarbind(snmpType, enums, obj.constraint);
    const oidStr = obj.full_name || obj.oid;

    if (vbPickerRowId) {
      setVarbinds((prev) =>
        prev.map((row) =>
          row.id === vbPickerRowId
            ? {
                ...row,
                oid: oidStr,
                type: snmpType,
                value: defVal,
                enumValues: enums,
                constraint: obj.constraint,
                enrichedFor: oidStr,
              }
            : row
        )
      );
      notify(`Populated VarBind with ${oidStr} (${snmpType}).`, 'success');
    } else {
      setVarbinds((prev) => [
        ...prev,
        {
          id: `vb-${Date.now()}`,
          oid: oidStr,
          type: snmpType,
          value: defVal,
          enumValues: enums,
          constraint: obj.constraint,
          enrichedFor: oidStr,
        },
      ]);
      notify(`Added VarBind ${oidStr} (${snmpType}).`, 'success');
    }
    setVbPickerOpen(false);
    setVbPickerRowId(null);
  };

  // Inline VarBind OID auto-enrich on blur
  const handleVarbindOidBlur = async (rowId: string, rawOid: string) => {
    const clean = rawOid.trim().replace(/\.\d+$/, '');
    if (!clean || clean.length < 3) return;
    const targetRow = varbinds.find((r) => r.id === rowId);
    if (!targetRow || targetRow.enrichedFor === rawOid.trim()) return;

    try {
      const res = await api.searchObjects(clean, 8);
      const low = clean.toLowerCase();
      const match = (res.objects || []).find(
        (o) =>
          o.full_name.toLowerCase() === low ||
          o.name.toLowerCase() === low ||
          o.oid === clean
      );
      if (!match) return;
      const enums = normalizeEnums(match.enum_values);
      const inferred = inferSnmpVarbindType(match);
      const snmpType = SNMP_TYPES.includes(inferred) ? inferred : 'String';
      const defVal = defaultValueForVarbind(snmpType, enums, match.constraint);
      setVarbinds((prev) =>
        prev.map((row) =>
          row.id === rowId
            ? {
                ...row,
                type: snmpType,
                enumValues: enums,
                constraint: match.constraint,
                value: row.value.trim() === '' ? defVal : row.value,
                enrichedFor: rawOid.trim(),
              }
            : row
        )
      );
    } catch {
      // silent enrichment failure
    }
  };

  const varbindErrors = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const vb of varbinds) {
      map[vb.id] = validateVarbindInput({
        oid: vb.oid,
        type: vb.type,
        value: vb.value,
        enumValues: vb.enumValues,
        constraint: vb.constraint,
      });
    }
    return map;
  }, [varbinds]);

  const handleToggleReceiver = async (action: 'start' | 'stop') => {
    setRxBusy(true);
    try {
      if (action === 'start') {
        await api.startTrapReceiver(rxPort, rxComm.trim() || 'public', rxResolve);
        notify(`Trap receiver listening on UDP ${rxPort}.`, 'success');
      } else {
        await api.stopTrapReceiver();
        notify('Trap receiver stopped.', 'info');
      }
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Receiver operation failed', 'error');
    } finally {
      setRxBusy(false);
    }
  };

  const handleToggleResolveMibs = async (next: boolean) => {
    setRxResolve(next);
    if (!trapStatus?.running) return;
    try {
      await api.setTrapResolveMibs(next);
      await refreshLiveState();
      notify(`Trap MIB resolution ${next ? 'enabled' : 'disabled'}.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update MIB resolution', 'error');
    }
  };

  const handleSendTrap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetIp.trim() || !trapOid.trim()) {
      notify('Target IP and Notification OID are required.', 'warning');
      return;
    }

    const firstInvalid = varbinds.find((vb) => Boolean(varbindErrors[vb.id]));
    if (firstInvalid) {
      notify(`VarBind "${firstInvalid.oid || 'row'}": ${varbindErrors[firstInvalid.id]}`, 'warning');
      return;
    }

    const validVarbinds = varbinds
      .filter((v) => v.oid.trim() && v.value.trim() !== '')
      .map((v) => ({ oid: v.oid.trim(), type: v.type, value: v.value.trim() }));

    setSending(true);
    try {
      const res = await api.sendTrap(
        {
          target: targetIp.trim(),
          port: targetPort,
          community: targetComm.trim() || 'public',
          oid: trapOid.trim(),
          varbinds: validVarbinds,
        },
        asInform
      );
      notify(
        res.message || `${asInform ? 'Inform' : 'Trap'} sent to ${targetIp}:${targetPort}.`,
        'success'
      );
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to send notification', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleReplay = async (trap: ReceivedTrapEvent, withOverride = false) => {
    setReplaying(true);
    try {
      await api.replayTrap(
        trap.id,
        withOverride
          ? {
              host: replayHost.trim() || null,
              port: replayPort.trim() ? Number(replayPort) : null,
            }
          : undefined
      );
      notify(`Replayed trap #${trap.id}.`, 'success');
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Replay failed', 'error');
    } finally {
      setReplaying(false);
    }
  };

  const handleDeleteTrap = async (id: number) => {
    try {
      await api.deleteReceivedTrap(id);
      setRecentTraps((prev) => prev.filter((t) => t.id !== id));
      if (inspectedTrap?.id === id) setInspectedTrap(null);
      notify('Trap event removed.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const handleClearAllTraps = async () => {
    const ok = await confirm({
      title: 'Clear all received traps?',
      message: 'This deletes all stored trap events from the receiver log.',
      confirmLabel: 'Clear Traps',
    });
    if (!ok) return;
    try {
      await api.clearReceivedTraps();
      setRecentTraps([]);
      setInspectedTrap(null);
      notify('Received traps cleared.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Clear failed', 'error');
    }
  };

  const handleDecodeBer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decodePayload.trim()) return;
    setDecoding(true);
    try {
      const res = await api.decodeTrapPayload({
        payload: decodePayload.trim(),
        encoding: decodeEncoding,
      });
      setDecodeResult(res);
      notify('BER payload decoded.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'BER decode failed', 'error');
    } finally {
      setDecoding(false);
    }
  };

  const filteredTraps = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recentTraps;
    return recentTraps.filter(
      (t) =>
        String(t.trap_type || t.trap_name || '').toLowerCase().includes(q) ||
        String(t.trap_oid || '').toLowerCase().includes(q) ||
        String(t.source || t.source_ip || '').toLowerCase().includes(q) ||
        JSON.stringify(t.varbinds || []).toLowerCase().includes(q)
    );
  }, [recentTraps, search]);

  const rxRunning = Boolean(trapStatus?.running);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top Inline Trap Receiver Control Bar */}
      <div className="px-4 py-2.5 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--tui-ink-primary)]">Trap Receiver</span>
            <StatusLabel
              tone={rxRunning ? 'success' : 'neutral'}
              label={rxRunning ? 'LISTENING' : 'STOPPED'}
              liveDot={rxRunning}
            />
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="next-rx-port" className="text-[var(--tui-ink-muted)]">
              Port
            </label>
            <input
              id="next-rx-port"
              type="number"
              disabled={rxRunning}
              value={rxPort}
              onChange={(e) => setRxPort(Number(e.target.value))}
              className="w-20 h-7 px-2 rounded font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] disabled:opacity-60 focus:outline-none focus:border-[var(--tui-brand)]"
            />
            <label htmlFor="next-rx-comm" className="text-[var(--tui-ink-muted)]">
              Community
            </label>
            <input
              id="next-rx-comm"
              type="text"
              disabled={rxRunning}
              value={rxComm}
              onChange={(e) => setRxComm(e.target.value)}
              className="w-24 h-7 px-2 rounded font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] disabled:opacity-60 focus:outline-none focus:border-[var(--tui-brand)]"
            />
            <label className="inline-flex items-center gap-1.5 ml-1 text-[var(--tui-ink-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={rxResolve}
                onChange={(e) => void handleToggleResolveMibs(e.target.checked)}
                className="accent-[var(--tui-brand)]"
              />
              <span>Resolve OIDs</span>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {rxRunning && (
            <div className="hidden xl:flex items-center gap-3 text-xs font-mono text-[var(--tui-ink-muted)] tabular-nums">
              <span>Total: {trapStatus?.traps_received ?? recentTraps.length}</span>
              <span>·</span>
              <span>Uptime: {formatUptime(trapStatus?.uptime_seconds)}</span>
            </div>
          )}
          <button
            type="button"
            disabled={rxRunning || rxBusy}
            onClick={() => void handleToggleReceiver('start')}
            className="h-7 px-2.5 rounded text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer"
          >
            <Play className="w-3 h-3" />
            <span>Start</span>
          </button>
          <button
            type="button"
            disabled={!rxRunning || rxBusy}
            onClick={() => void handleToggleReceiver('stop')}
            className="h-7 px-2.5 rounded text-xs font-semibold bg-[var(--tui-danger-btn-bg)] text-[var(--tui-danger-btn-ink)] hover:bg-[var(--tui-danger-btn-hover)] disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer"
          >
            <Square className="w-3 h-3" />
            <span>Stop</span>
          </button>
        </div>
      </div>

      {/* Main Split: Composer (Left) + Live Received Stream (Right) */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Left: Trap / Inform Composer */}
        <form
          onSubmit={(e) => void handleSendTrap(e)}
          className="w-full lg:w-[440px] shrink-0 flex flex-col border-b lg:border-b-0 lg:border-r border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] overflow-y-auto p-4 space-y-3.5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">Send Trap / Inform</h2>
            <button
              type="button"
              onClick={() => {
                setSelectedTrapKey('');
                setCatalogFilter('');
                setTrapOid('1.3.6.1.6.3.1.1.5.3');
                const fresh = DEFAULT_VARBINDS();
                autoSigRef.current = varbindSignature(fresh);
                setVarbinds(fresh);
              }}
              className="text-[11px] text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] inline-flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>

          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-5">
              <label htmlFor="next-trap-ip" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Target IP
              </label>
              <input
                id="next-trap-ip"
                type="text"
                value={targetIp}
                onChange={(e) => setTargetIp(e.target.value)}
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>
            <div className="col-span-3">
              <label htmlFor="next-trap-port" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Port
              </label>
              <input
                id="next-trap-port"
                type="number"
                value={targetPort}
                onChange={(e) => setTargetPort(Number(e.target.value))}
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>
            <div className="col-span-4">
              <label htmlFor="next-trap-comm" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Community
              </label>
              <input
                id="next-trap-comm"
                type="text"
                value={targetComm}
                onChange={(e) => setTargetComm(e.target.value)}
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>
          </div>

          {/* Searchable Trap Catalog Template */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="next-trap-catalog" className="block text-[11px] font-medium text-[var(--tui-ink-muted)]">
                Trap Catalog Template
              </label>
              <span className="text-[10px] font-mono text-[var(--tui-ink-soft)]">
                {filteredCatalog.length} / {trapCatalog.length}
              </span>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={catalogFilter}
                onChange={(e) => setCatalogFilter(e.target.value)}
                placeholder="Filter catalog traps by name, module, or OID..."
                aria-label="Filter trap catalog"
                className="w-full h-7 pl-8 pr-7 rounded-md text-[11px] bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
              {catalogFilter && (
                <button
                  type="button"
                  onClick={() => setCatalogFilter('')}
                  aria-label="Clear trap catalog filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--tui-ink-soft)] hover:text-[var(--tui-ink-primary)] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <select
              id="next-trap-catalog"
              value={selectedTrapKey}
              onChange={(e) => {
                const match = trapCatalog.find((t) => t.full_name === e.target.value);
                if (match) applyCatalogTrap(match);
                else setSelectedTrapKey('');
              }}
              className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
            >
              <option value="">Custom notification OID...</option>
              {filteredCatalog.map((t) => (
                <option key={t.full_name} value={t.full_name}>
                  {t.full_name} ({t.oid})
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="next-trap-oid" className="block text-[11px] font-medium text-[var(--tui-ink-muted)]">
                Notification OID
              </label>
              <span className="text-[10px] text-[var(--tui-ink-soft)]">
                Blur/Enter auto-loads MIB VarBinds
              </span>
            </div>
            <input
              id="next-trap-oid"
              type="text"
              value={trapOid}
              onChange={(e) => setTrapOid(e.target.value)}
              onBlur={handleAutoResolveTrapOid}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAutoResolveTrapOid();
                }
              }}
              placeholder="1.3.6.1.6.3.1.1.5.4 or IF-MIB::linkUp"
              className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
            />
          </div>

          {/* VarBinds Builder with MIB Object Picker & Auto-Fill */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-[var(--tui-ink-secondary)]">
                VarBinds ({varbinds.length})
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setVbPickerRowId(null);
                    setVbPickerInitialQuery('');
                    setVbPickerOpen(true);
                  }}
                  className="h-6 px-2 rounded border border-[var(--tui-brand-border)] bg-[var(--tui-brand-soft)] text-[var(--tui-brand-ink)] hover:brightness-95 dark:hover:brightness-110 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                >
                  <BookOpen className="w-3 h-3" />
                  <span>Pick from MIB</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setVarbinds((prev) => [
                      ...prev,
                      { id: `vb-${Date.now()}`, oid: '', type: 'String', value: '' },
                    ])
                  }
                  className="h-6 px-2 rounded border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Blank</span>
                </button>
              </div>
            </div>

            <div className="space-y-2 max-h-[290px] overflow-y-auto pr-0.5">
              {varbinds.map((vb) => {
                const hint = formatConstraintHint(vb.constraint, vb.type);
                const err = varbindErrors[vb.id];
                const hasEnums = vb.type === 'Integer' && vb.enumValues && vb.enumValues.length > 0;
                return (
                  <div
                    key={vb.id}
                    className={`p-2 rounded-md bg-[var(--tui-bg-subtle)] border space-y-1.5 ${
                      err ? 'border-[var(--tui-danger-border)]' : 'border-[var(--tui-border-default)]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={vb.oid}
                        onChange={(e) =>
                          setVarbinds((prev) =>
                            prev.map((row) =>
                              row.id === vb.id
                                ? { ...row, oid: e.target.value, enrichedFor: undefined }
                                : row
                            )
                          )
                        }
                        onBlur={(e) => void handleVarbindOidBlur(vb.id, e.target.value)}
                        placeholder="OID or Module::Object.0"
                        className="flex-1 min-w-0 h-7 px-2 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setVbPickerRowId(vb.id);
                          setVbPickerInitialQuery(vb.oid.replace(/.*\:\:/, '').replace(/\.\d+$/, ''));
                          setVbPickerOpen(true);
                        }}
                        aria-label="Lookup MIB object for this VarBind"
                        title="Lookup MIB object & auto-fill"
                        className="h-7 w-7 shrink-0 rounded border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-muted)] hover:text-[var(--tui-brand)] hover:border-[var(--tui-brand-border)] inline-flex items-center justify-center cursor-pointer"
                      >
                        <Search className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setVarbinds((prev) => prev.filter((row) => row.id !== vb.id))}
                        aria-label="Remove VarBind"
                        title="Remove VarBind"
                        className="h-7 w-7 shrink-0 rounded border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-muted)] hover:text-[var(--tui-danger-ink)] inline-flex items-center justify-center cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="grid grid-cols-12 gap-1.5">
                      <select
                        value={vb.type}
                        onChange={(e) =>
                          setVarbinds((prev) =>
                            prev.map((row) => (row.id === vb.id ? { ...row, type: e.target.value } : row))
                          )
                        }
                        aria-label="VarBind SNMP type"
                        className="col-span-5 h-7 px-1.5 rounded text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                      >
                        {SNMP_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      {hasEnums ? (
                        <select
                          value={vb.value}
                          onChange={(e) =>
                            setVarbinds((prev) =>
                              prev.map((row) => (row.id === vb.id ? { ...row, value: e.target.value } : row))
                            )
                          }
                          aria-label="VarBind enum value"
                          className="col-span-7 h-7 px-2 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                        >
                          <option value="">Select enum...</option>
                          {vb.enumValues!.map((ev) => (
                            <option key={ev.value} value={String(ev.value)}>
                              {ev.label} ({ev.value})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={vb.value}
                          onChange={(e) =>
                            setVarbinds((prev) =>
                              prev.map((row) => (row.id === vb.id ? { ...row, value: e.target.value } : row))
                            )
                          }
                          placeholder="Value"
                          className="col-span-7 h-7 px-2 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
                        />
                      )}
                    </div>
                    {(hint || err) && (
                      <div className="flex items-center justify-between gap-2 text-[10px] font-mono pt-0.5">
                        {err ? (
                          <span className="inline-flex items-center gap-1 text-[var(--tui-danger-ink)]">
                            <AlertCircle className="w-3 h-3 shrink-0" />
                            <span>{err}</span>
                          </span>
                        ) : (
                          <span className="text-[var(--tui-ink-muted)]">{hint}</span>
                        )}
                        {err && hint && <span className="text-[var(--tui-ink-soft)] shrink-0">{hint}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--tui-border-subtle)] flex items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-[var(--tui-ink-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={asInform}
                onChange={(e) => setAsInform(e.target.checked)}
                className="accent-[var(--tui-brand)]"
              />
              <span>Send as Inform</span>
            </label>
            <button
              type="submit"
              disabled={sending}
              className="h-8 px-4 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{sending ? 'Sending...' : asInform ? 'Send Inform' : 'Send Trap'}</span>
            </button>
          </div>
        </form>

        {/* Right: Live Received Traps Stream */}
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--tui-bg-canvas)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Received Traps{' '}
                <span className="font-mono font-normal text-[var(--tui-ink-muted)]">
                  ({filteredTraps.length})
                </span>
              </h2>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search received traps..."
                  aria-label="Search received traps"
                  className="h-8 pl-8 pr-3 w-48 rounded-md text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>

              <button
                type="button"
                onClick={() => setTrapsPaused((p) => !p)}
                className={`h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1 border cursor-pointer ${
                  trapsPaused
                    ? 'bg-[var(--tui-warning-soft)] border-[var(--tui-warning-border)] text-[var(--tui-warning-ink)]'
                    : 'bg-[var(--tui-bg-surface)] border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
                }`}
              >
                {trapsPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                <span>{trapsPaused ? 'Resume' : 'Pause'}</span>
              </button>

              <button
                type="button"
                onClick={() => setDecodeOpen(true)}
                className="h-8 px-2.5 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>Decode BER</span>
              </button>

              <button
                type="button"
                disabled={filteredTraps.length === 0}
                onClick={() => {
                  const csv = toCsv(
                    filteredTraps.map((t) => ({
                      timestamp: t.timestamp,
                      source: t.source || `${t.source_ip || ''}:${t.source_port || ''}`,
                      trap_name: t.trap_type || t.trap_name || t.trap_oid || '',
                      trap_oid: t.trap_oid || t.trap_type || '',
                      varbinds: (t.varbinds || [])
                        .map((v) => `${v.name || v.oid}=${v.display_value ?? v.value}`)
                        .join('; '),
                    })),
                    [
                      { key: 'timestamp', label: 'Timestamp' },
                      { key: 'source', label: 'Source' },
                      { key: 'trap_name', label: 'Trap Name' },
                      { key: 'trap_oid', label: 'OID' },
                      { key: 'varbinds', label: 'VarBinds' },
                    ]
                  );
                  downloadTextFile('received-traps.csv', csv, 'text/csv;charset=utf-8');
                }}
                className="h-8 px-2.5 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-secondary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>

              <button
                type="button"
                disabled={recentTraps.length === 0}
                onClick={() => void handleClearAllTraps()}
                aria-label="Clear all traps"
                title="Clear all traps"
                className="h-8 w-8 rounded-md border border-[var(--tui-danger-border)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] inline-flex items-center justify-center disabled:opacity-40 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {filteredTraps.length === 0 ? (
              <EmptyPane
                icon={<Send className="w-4 h-4" />}
                title="No received traps"
                description="Start the Trap Receiver in the top bar and send a trap or inform from the composer on the left."
              />
            ) : (
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[11px] font-semibold text-[var(--tui-ink-muted)]">
                  <tr>
                    <th className="py-2.5 px-3.5 whitespace-nowrap">Time</th>
                    <th className="py-2.5 px-3.5 whitespace-nowrap">Source</th>
                    <th className="py-2.5 px-3.5 whitespace-nowrap">Notification</th>
                    <th className="py-2.5 px-3.5">VarBinds</th>
                    <th className="py-2.5 px-3.5 text-right whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--tui-border-subtle)] bg-[var(--tui-bg-surface)] font-mono text-xs tabular-nums">
                  {filteredTraps.map((trap) => (
                    <tr key={trap.id} className="hover:bg-[var(--tui-bg-hover)] transition-colors">
                      <td className="py-2.5 px-3.5 text-[var(--tui-ink-muted)] whitespace-nowrap">
                        {formatRelativeTime(trap.timestamp)}
                      </td>
                      <td className="py-2.5 px-3.5 text-[var(--tui-ink-secondary)] whitespace-nowrap">
                        {trap.source || `${trap.source_ip || '127.0.0.1'}:${trap.source_port || ''}`}
                      </td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            setInspectedTrap(trap);
                            setReplayHost('');
                            setReplayPort('');
                          }}
                          className="font-semibold text-[var(--tui-brand)] hover:underline cursor-pointer"
                        >
                          {trap.trap_type || trap.trap_name || trap.trap_oid}
                        </button>
                      </td>
                      <td className="py-2.5 px-3.5 text-[var(--tui-ink-secondary)] max-w-md truncate">
                        {(trap.varbinds || [])
                          .slice(0, 2)
                          .map((vb) => `${vb.name || vb.oid}=${vb.display_value ?? vb.value}`)
                          .join(' · ') || '—'}
                      </td>
                      <td className="py-2.5 px-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setInspectedTrap(trap)}
                            aria-label={`Inspect trap ${trap.id}`}
                            title="Inspect VarBinds"
                            className="p-1.5 rounded border border-[var(--tui-border-default)] hover:bg-[var(--tui-bg-muted)] text-[var(--tui-ink-secondary)] cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleReplay(trap, false)}
                            aria-label={`Replay trap ${trap.id}`}
                            title="Quick replay"
                            className="p-1.5 rounded border border-[var(--tui-border-default)] hover:bg-[var(--tui-bg-muted)] text-[var(--tui-ink-secondary)] cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteTrap(trap.id)}
                            aria-label={`Delete trap ${trap.id}`}
                            title="Delete"
                            className="p-1.5 rounded border border-[var(--tui-danger-border)] hover:bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* VarBind MIB Object Picker Drawer */}
      <MibObjectPickerDrawer
        open={vbPickerOpen}
        onClose={() => {
          setVbPickerOpen(false);
          setVbPickerRowId(null);
        }}
        title={vbPickerRowId ? 'Lookup MIB Object for VarBind' : 'Pick VarBind from MIB Catalog'}
        subtitle="Selecting an object auto-fills its symbolic OID, SNMP type, enums, SMI constraints, and default value"
        actionLabel={vbPickerRowId ? 'Use' : 'Add'}
        initialQuery={vbPickerInitialQuery}
        onSelect={handlePickMibObject}
      />

      {/* Trap VarBind Inspector & Replay Drawer */}
      <SlideDrawer
        open={Boolean(inspectedTrap)}
        onClose={() => setInspectedTrap(null)}
        title={inspectedTrap?.trap_type || inspectedTrap?.trap_name || 'Trap Event'}
        subtitle={inspectedTrap?.trap_oid || inspectedTrap?.source}
        footer={
          inspectedTrap && (
            <>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(JSON.stringify(inspectedTrap, null, 2));
                  notify('Trap JSON copied.', 'success');
                }}
                className="h-8 px-3 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy JSON</span>
              </button>
              <button
                type="button"
                disabled={replaying}
                onClick={() => void handleReplay(inspectedTrap, true)}
                className="h-8 px-3 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{replaying ? 'Replaying...' : 'Replay'}</span>
              </button>
            </>
          )
        }
      >
        {inspectedTrap && (
          <div className="space-y-5 text-xs">
            <dl className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] font-mono">
              <div>
                <dt className="text-[10px] text-[var(--tui-ink-muted)] font-sans">Timestamp</dt>
                <dd className="mt-0.5 text-[var(--tui-ink-primary)]">{inspectedTrap.timestamp}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-[var(--tui-ink-muted)] font-sans">Source</dt>
                <dd className="mt-0.5 text-[var(--tui-ink-primary)]">
                  {inspectedTrap.source || `${inspectedTrap.source_ip}:${inspectedTrap.source_port}`}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-[var(--tui-ink-muted)] font-sans">PDU / Version</dt>
                <dd className="mt-0.5 text-[var(--tui-ink-primary)]">
                  {inspectedTrap.pdu_type || 'TRAP'} · {inspectedTrap.version || 'v2c'}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-[var(--tui-ink-muted)] font-sans">Community</dt>
                <dd className="mt-0.5 text-[var(--tui-ink-primary)]">{inspectedTrap.community || 'public'}</dd>
              </div>
            </dl>

            <div>
              <h3 className="text-xs font-semibold text-[var(--tui-ink-primary)] mb-2">
                VarBinds ({inspectedTrap.varbinds?.length ?? 0})
              </h3>
              <div className="divide-y divide-[var(--tui-border-subtle)] border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                {(inspectedTrap.varbinds || []).map((vb, idx) => (
                  <div key={idx} className="p-2.5 font-mono text-[11px] bg-[var(--tui-bg-surface)]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[var(--tui-ink-primary)] break-all">
                        {vb.name || vb.oid}
                      </span>
                      <span className="text-[var(--tui-ink-muted)] shrink-0">{vb.type}</span>
                    </div>
                    <div className="mt-1 text-[var(--tui-ink-secondary)] break-words">
                      {vb.value}
                      {vb.enum_label && (
                        <span className="ml-2 text-[var(--tui-info-ink)]">({vb.enum_label})</span>
                      )}
                      {vb.units && <span className="ml-1.5 text-[var(--tui-ink-muted)]">{vb.units}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] space-y-2">
              <div className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Replay Override (optional)
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={replayHost}
                  onChange={(e) => setReplayHost(e.target.value)}
                  placeholder="Host (default 127.0.0.1)"
                  className="h-8 px-2.5 rounded font-mono text-xs bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
                <input
                  type="number"
                  value={replayPort}
                  onChange={(e) => setReplayPort(e.target.value)}
                  placeholder="Port (default 1162)"
                  className="h-8 px-2.5 rounded font-mono text-xs bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>
            </div>
          </div>
        )}
      </SlideDrawer>

      {/* BER Payload Decoder Drawer */}
      <SlideDrawer
        open={decodeOpen}
        onClose={() => setDecodeOpen(false)}
        title="Decode BER SNMP Trap Payload"
        subtitle="Paste raw hexadecimal or Base64 SNMPv1/v2c BER packet bytes"
      >
        <form onSubmit={(e) => void handleDecodeBer(e)} className="space-y-3">
          <div className="flex items-center gap-2">
            {(['hex', 'base64'] as const).map((enc) => (
              <button
                key={enc}
                type="button"
                onClick={() => setDecodeEncoding(enc)}
                className={`px-3 py-1.5 text-xs font-mono rounded-md border uppercase cursor-pointer ${
                  decodeEncoding === enc
                    ? 'bg-[var(--tui-brand-soft)] border-[var(--tui-brand-border)] text-[var(--tui-brand-ink)] font-semibold'
                    : 'bg-[var(--tui-bg-surface)] border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
                }`}
              >
                {enc}
              </button>
            ))}
          </div>

          <textarea
            rows={5}
            value={decodePayload}
            onChange={(e) => setDecodePayload(e.target.value)}
            placeholder={
              decodeEncoding === 'hex'
                ? '30 4a 02 01 01 04 06 70 75 62 6c 69 63 ...'
                : 'MEoCAQEEBnB1YmxpYw=='
            }
            className="w-full p-3 rounded-lg font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
          />

          <button
            type="submit"
            disabled={decoding || !decodePayload.trim()}
            className="h-9 px-4 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-45 cursor-pointer"
          >
            {decoding ? 'Decoding...' : 'Decode Payload'}
          </button>

          {decodeResult && (
            <pre className="p-3 rounded-lg border border-[var(--tui-border-default)] bg-[var(--tui-bg-terminal)] text-slate-200 font-mono text-xs overflow-auto max-h-80">
              {JSON.stringify(decodeResult, null, 2)}
            </pre>
          )}
        </form>
      </SlideDrawer>
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpDown,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eye,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  COMMUNITY_MASK,
  defaultValueForVarbind,
  downloadTextFile,
  formatConstraintHint,
  formatRelativeTime,
  formatUptime,
  inferSnmpVarbindType,
  isInformAcknowledged,
  isNumericOid,
  normalizeEnums,
  stripLeadingOidDot,
  toCsv,
  validateVarbindInput,
} from '../lib/workbench';
import { useWorkbench } from '../context/WorkbenchContext';
import { EmptyPane, SecretInput, SlideDrawer, StatusLabel } from '../components/UiPrimitives';
import { MibObjectPickerDrawer } from '../components/MibObjectPickerDrawer';
import type {
  DecodeTrapResponse,
  EnumValue,
  MibConstraint,
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

const TRAPS_PAGE_LIMIT = 100;

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

  // Stream table pagination, sorting, filter & drawers
  const [search, setSearch] = useState('');
  const [trapOffset, setTrapOffset] = useState(0);
  const [trapTotal, setTrapTotal] = useState<number | null>(null);
  const [pagedTraps, setPagedTraps] = useState<ReceivedTrapEvent[]>([]);
  const [loadingTraps, setLoadingTraps] = useState(false);
  const [sortCol, setSortCol] = useState<'time' | 'source'>('time');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [inspectedTrap, setInspectedTrap] = useState<ReceivedTrapEvent | null>(null);
  const [replayHost, setReplayHost] = useState('');
  const [replayPort, setReplayPort] = useState('');
  const [replayCommunity, setReplayCommunity] = useState('');
  const [replayTimeout, setReplayTimeout] = useState('');
  const [replayRetries, setReplayRetries] = useState('');
  const [replaying, setReplaying] = useState(false);

  // BER Decoder drawer
  const [decodeOpen, setDecodeOpen] = useState(false);
  const [decodeEncoding, setDecodeEncoding] = useState<'hex' | 'base64'>('hex');
  const [decodePayload, setDecodePayload] = useState('');
  const [decodeSourceHost, setDecodeSourceHost] = useState('');
  const [decodeSourcePort, setDecodeSourcePort] = useState('');
  const [decodeResult, setDecodeResult] = useState<DecodeTrapResponse | null>(null);
  const [decoding, setDecoding] = useState(false);

  useEffect(() => {
    if (trapStatus) {
      setRxPort(trapStatus.port || 1162);
      setRxComm(trapStatus.community || 'public');
      setRxResolve(trapStatus.resolve_mibs);
    }
  }, [trapStatus]);

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

  const loadTrapsPage = useCallback(
    async (offset = trapOffset) => {
      setLoadingTraps(true);
      try {
        const res = await api.listReceivedTraps(TRAPS_PAGE_LIMIT, offset);
        const rows = res.data || res.traps || [];
        setTrapTotal(typeof res.total === 'number' ? res.total : rows.length);
        if (offset === 0) {
          setRecentTraps(rows);
        } else {
          setPagedTraps(rows);
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Failed to load received traps', 'error');
      } finally {
        setLoadingTraps(false);
      }
    },
    [notify, setRecentTraps, trapOffset]
  );

  useEffect(() => {
    void loadTrapsPage(trapOffset);
  }, [loadTrapsPage, trapOffset]);

  // Keep total estimate aligned when WebSocket pushes new live traps at offset 0
  useEffect(() => {
    if (trapOffset === 0 && trapTotal !== null && recentTraps.length > trapTotal) {
      setTrapTotal(recentTraps.length);
    }
  }, [recentTraps.length, trapOffset, trapTotal]);

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

  const applyCatalogTrap = useCallback((item: TrapCatalogItem) => {
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
  }, []);

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
  }, [handoff, trapCatalog, clearHandoff, applyCatalogTrap]);

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

  // Inline VarBind OID auto-enrich on blur (supports both numeric OIDs and symbolic names)
  const handleVarbindOidBlur = async (rowId: string, rawOid: string) => {
    const trimmed = rawOid.trim();
    if (!trimmed || trimmed.length < 3) return;
    const targetRow = varbinds.find((r) => r.id === rowId);
    if (!targetRow || targetRow.enrichedFor === trimmed) return;

    try {
      let match: MibObjectSearchItem | null = null;
      if (isNumericOid(trimmed)) {
        const cleanOid = stripLeadingOidDot(trimmed);
        const candidates = cleanOid.endsWith('.0') ? [cleanOid, cleanOid.slice(0, -2)] : [cleanOid];
        for (const candidate of candidates) {
          const res = await api.getBrowseNode(candidate).catch(() => null);
          if (res?.node) {
            const n = res.node;
            match = {
              name: n.name,
              full_name: n.full_name,
              module: n.module,
              oid: n.oid,
              syntax: n.syntax || undefined,
              type: n.type,
              constraint:
                n.constraints && typeof n.constraints === 'object' && !Array.isArray(n.constraints)
                  ? (n.constraints as MibConstraint)
                  : null,
              enum_values: normalizeEnums(n.enums),
            };
            break;
          }
        }
      } else {
        const cleanSym = trimmed.replace(/\.\d+$/, '');
        const res = await api.searchObjects(cleanSym, 8);
        const low = cleanSym.toLowerCase();
        match =
          (res.objects || []).find(
            (o) =>
              o.full_name.toLowerCase() === low ||
              o.name.toLowerCase() === low ||
              o.oid === cleanSym
          ) || null;
      }

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
                enrichedFor: trimmed,
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
      await loadTrapsPage(trapOffset);
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
      if (asInform) {
        const ack = isInformAcknowledged(res);
        if (!ack.ok) {
          notify(
            `Inform reached ${targetIp}:${targetPort} with SNMP error (${ack.detail})`,
            'warning'
          );
        } else {
          notify(
            res.message ||
              `Inform acknowledged by ${targetIp}:${targetPort}${
                ack.errorCode != null ? ` (errorStatus=${ack.errorCode})` : ''
              }.`,
            'success'
          );
        }
      } else {
        notify(res.message || `Trap sent to ${targetIp}:${targetPort}.`, 'success');
      }
      await refreshLiveState();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to send notification', 'error');
    } finally {
      setSending(false);
    }
  };

  const openInspector = (trap: ReceivedTrapEvent) => {
    setInspectedTrap(trap);
    setReplayHost('');
    setReplayPort('');
    setReplayCommunity(trap.community && trap.community !== COMMUNITY_MASK ? trap.community : '');
    setReplayTimeout('');
    setReplayRetries('');
  };

  const handleReplay = async (trap: ReceivedTrapEvent, withOverride = false) => {
    if (trap.id == null) {
      notify('Cannot replay an unpersisted trap without a server event ID.', 'warning');
      return;
    }
    setReplaying(true);
    try {
      const trimmedComm = replayCommunity.trim();
      const safeComm = trimmedComm && trimmedComm !== COMMUNITY_MASK ? trimmedComm : null;
      await api.replayTrap(
        trap.id,
        withOverride
          ? {
              host: replayHost.trim() || null,
              port: replayPort.trim() ? Number(replayPort) : null,
              community: safeComm,
              timeout: replayTimeout.trim() ? Number(replayTimeout) : null,
              retries: replayRetries.trim() ? Number(replayRetries) : null,
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

  const handleDeleteTrap = async (id: number | null) => {
    if (id == null) {
      notify('This trap event cannot be deleted (missing server ID).', 'warning');
      return;
    }
    try {
      await api.deleteReceivedTrap(id);
      setRecentTraps((prev) => prev.filter((t) => t.id !== id));
      setPagedTraps((prev) => prev.filter((t) => t.id !== id));
      setTrapTotal((prev) => (prev != null ? Math.max(0, prev - 1) : prev));
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
      setPagedTraps([]);
      setTrapTotal(0);
      setTrapOffset(0);
      setInspectedTrap(null);
      notify('Received traps cleared.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Clear failed', 'error');
    }
  };

  const handleDownloadAllJson = async () => {
    try {
      const fetchLimit = Math.max(trapTotal || 100, 1000);
      const res = await api.listReceivedTraps(fetchLimit, 0);
      const rows = res.data || res.traps || [];
      downloadTextFile(
        `received-traps-${Date.now()}.json`,
        JSON.stringify(rows, null, 2),
        'application/json'
      );
      notify(`Exported ${rows.length} received trap(s) to JSON.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to export traps JSON', 'error');
    }
  };

  const handleDecodeBer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decodePayload.trim()) return;
    setDecoding(true);
    try {
      const portNum = decodeSourcePort.trim() ? Number(decodeSourcePort.trim()) : null;
      if (portNum != null && (portNum < 1 || portNum > 65535 || !Number.isInteger(portNum))) {
        notify('Source port must be an integer between 1 and 65535.', 'warning');
        setDecoding(false);
        return;
      }
      const res = await api.decodeTrapPayload({
        payload: decodePayload.trim(),
        encoding: decodeEncoding,
        source_host: decodeSourceHost.trim() || null,
        source_port: portNum,
      });
      setDecodeResult(res);
      notify('BER payload decoded.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'BER decode failed', 'error');
    } finally {
      setDecoding(false);
    }
  };

  const activeTrapsSource = trapOffset === 0 ? recentTraps : pagedTraps;

  const filteredTraps = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = !q
      ? activeTrapsSource
      : activeTrapsSource.filter(
          (t) =>
            String(t.trap_type || t.trap_name || '').toLowerCase().includes(q) ||
            String(t.trap_oid || '').toLowerCase().includes(q) ||
            String(t.source || t.source_ip || '').toLowerCase().includes(q) ||
            JSON.stringify(t.varbinds || []).toLowerCase().includes(q)
        );
    return [...matched].sort((a, b) => {
      if (sortCol === 'source') {
        const sa = String(a.source || `${a.source_ip || ''}:${a.source_port || ''}`);
        const sb = String(b.source || `${b.source_ip || ''}:${b.source_port || ''}`);
        return sortDir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
      }
      const ta = Date.parse(a.timestamp || '') || 0;
      const tb = Date.parse(b.timestamp || '') || 0;
      return sortDir === 'asc' ? ta - tb : tb - ta;
    });
  }, [activeTrapsSource, search, sortCol, sortDir]);

  const receiverMetrics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of activeTrapsSource) {
      const src = t.source || (t.source_ip ? `${t.source_ip}:${t.source_port || ''}` : '');
      if (!src) continue;
      counts.set(src, (counts.get(src) || 0) + 1);
    }
    let topSource = '—';
    let topCount = 0;
    for (const [src, cnt] of counts.entries()) {
      if (cnt > topCount) {
        topSource = src;
        topCount = cnt;
      }
    }
    const latest = activeTrapsSource[0];
    return {
      total: trapTotal ?? activeTrapsSource.length,
      lastReceived: latest ? formatRelativeTime(latest.timestamp) : '—',
      topSource: topCount > 0 ? `${topSource} (${topCount})` : '—',
      uptime: formatUptime(trapStatus?.uptime_seconds),
    };
  }, [activeTrapsSource, trapTotal, trapStatus?.uptime_seconds]);

  const toggleSort = (col: 'time' | 'source') => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'time' ? 'desc' : 'asc');
    }
  };

  const stepPage = (dir: 'newer' | 'older') => {
    const total = trapTotal ?? 0;
    if (dir === 'newer') {
      setTrapOffset((prev) => Math.max(0, prev - TRAPS_PAGE_LIMIT));
    } else {
      const lastPageStart = Math.floor(Math.max(0, total - 1) / TRAPS_PAGE_LIMIT) * TRAPS_PAGE_LIMIT;
      setTrapOffset((prev) => Math.min(lastPageStart, prev + TRAPS_PAGE_LIMIT));
    }
  };

  const rxRunning = Boolean(trapStatus?.running);
  const effectiveTotal = trapTotal ?? activeTrapsSource.length;
  const currentPage = Math.floor(trapOffset / TRAPS_PAGE_LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(effectiveTotal / TRAPS_PAGE_LIMIT));

  return (
    <div className="min-h-full lg:h-full flex flex-col lg:overflow-hidden">
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

          <div className="flex items-center gap-2 text-xs flex-wrap">
            <label htmlFor="next-rx-port" className="text-[var(--tui-ink-muted)]">
              Port
            </label>
            <input
              id="next-rx-port"
              type="number"
              min={1}
              max={65535}
              disabled={rxRunning}
              value={rxPort}
              onChange={(e) => setRxPort(Number(e.target.value))}
              className="w-20 h-8 px-2 rounded font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] disabled:opacity-60 focus-visible:border-[var(--tui-brand)]"
            />
            <label htmlFor="next-rx-comm" className="text-[var(--tui-ink-muted)]">
              Community
            </label>
            <div className="w-28">
              <SecretInput
                id="next-rx-comm"
                value={rxComm}
                onChange={setRxComm}
                disabled={rxRunning}
                toggleLabel="receiver community"
                className="!bg-[var(--tui-bg-canvas)]"
              />
            </div>
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

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={rxRunning || rxBusy}
            onClick={() => void handleToggleReceiver('start')}
            className="tui-btn-primary h-8 px-2.5 rounded text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed"
          >
            <Play className="w-3 h-3" />
            <span>Start</span>
          </button>
          <button
            type="button"
            disabled={!rxRunning || rxBusy}
            onClick={() => void handleToggleReceiver('stop')}
            className="h-8 px-2.5 rounded text-xs font-semibold bg-[var(--tui-danger-btn-bg)] text-[var(--tui-danger-btn-ink)] hover:bg-[var(--tui-danger-btn-hover)] disabled:opacity-40 inline-flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed"
          >
            <Square className="w-3 h-3" />
            <span>Stop</span>
          </button>
        </div>
      </div>

      {/* 4-Metric Receiver Telemetry Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[var(--tui-border-default)] border-b border-[var(--tui-border-default)] text-xs">
        <div className="bg-[var(--tui-bg-subtle)] px-4 py-2 flex items-center justify-between gap-2">
          <span className="text-[var(--tui-ink-muted)]">Total Traps</span>
          <span className="font-mono font-semibold text-[var(--tui-ink-primary)] tabular-nums">
            {receiverMetrics.total}
          </span>
        </div>
        <div className="bg-[var(--tui-bg-subtle)] px-4 py-2 flex items-center justify-between gap-2">
          <span className="text-[var(--tui-ink-muted)]">Last Received</span>
          <span className="font-mono font-semibold text-[var(--tui-ink-primary)] tabular-nums truncate">
            {receiverMetrics.lastReceived}
          </span>
        </div>
        <div className="bg-[var(--tui-bg-subtle)] px-4 py-2 flex items-center justify-between gap-2">
          <span className="text-[var(--tui-ink-muted)]">Top Source</span>
          <span className="font-mono font-semibold text-[var(--tui-ink-primary)] truncate">
            {receiverMetrics.topSource}
          </span>
        </div>
        <div className="bg-[var(--tui-bg-subtle)] px-4 py-2 flex items-center justify-between gap-2">
          <span className="text-[var(--tui-ink-muted)]">Uptime</span>
          <span className="font-mono font-semibold text-[var(--tui-ink-primary)] tabular-nums">
            {receiverMetrics.uptime}
          </span>
        </div>
      </div>

      {/* Main Split: Composer (Left) + Live Received Stream (Right) */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:overflow-hidden">
        {/* Left: Trap / Inform Composer */}
        <form
          onSubmit={(e) => void handleSendTrap(e)}
          className="w-full lg:w-[440px] shrink-0 flex flex-col border-b lg:border-b-0 lg:border-r border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] lg:overflow-y-auto p-4 space-y-3.5"
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
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
              />
            </div>
            <div className="col-span-3">
              <label htmlFor="next-trap-port" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Port
              </label>
              <input
                id="next-trap-port"
                type="number"
                min={1}
                max={65535}
                value={targetPort}
                onChange={(e) => setTargetPort(Number(e.target.value))}
                className="w-full h-8 px-2 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
              />
            </div>
            <div className="col-span-4">
              <label htmlFor="next-trap-comm" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Community
              </label>
              <SecretInput
                id="next-trap-comm"
                value={targetComm}
                onChange={setTargetComm}
                toggleLabel="target community"
                className="!bg-[var(--tui-bg-canvas)]"
              />
            </div>
          </div>

          {/* Searchable Trap Catalog Template */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="next-trap-catalog" className="block text-[11px] font-medium text-[var(--tui-ink-muted)]">
                Trap Catalog Template
              </label>
              <span className="text-[10px] font-mono text-[var(--tui-ink-muted)]">
                {filteredCatalog.length} / {trapCatalog.length}
              </span>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--tui-ink-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={catalogFilter}
                onChange={(e) => setCatalogFilter(e.target.value)}
                placeholder="Filter catalog traps by name, module, or OID..."
                aria-label="Filter trap catalog"
                className="w-full h-7 pl-8 pr-7 rounded-md text-[11px] bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
              />
              {catalogFilter && (
                <button
                  type="button"
                  onClick={() => setCatalogFilter('')}
                  aria-label="Clear trap catalog filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] cursor-pointer"
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
              className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
            >
              <option value="">
                {catalogFilter.trim()
                  ? `Select from ${filteredCatalog.length} matching template(s)...`
                  : 'Custom notification OID...'}
              </option>
              {filteredCatalog.map((t) => (
                <option key={t.full_name} value={t.full_name}>
                  {t.full_name} ({t.oid})
                </option>
              ))}
            </select>
            {catalogFilter.trim().length > 0 && (
              <div className="rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] max-h-36 overflow-y-auto divide-y divide-[var(--tui-border-subtle)]">
                {filteredCatalog.length === 0 ? (
                  <div className="px-2.5 py-2 text-[11px] text-[var(--tui-ink-muted)]">
                    No templates match &ldquo;{catalogFilter.trim()}&rdquo;.
                  </div>
                ) : (
                  filteredCatalog.slice(0, 20).map((t) => (
                    <button
                      key={t.full_name}
                      type="button"
                      onClick={() => applyCatalogTrap(t)}
                      className={`w-full px-2.5 py-1.5 text-left flex items-center justify-between gap-2 hover:bg-[var(--tui-bg-hover)] cursor-pointer ${
                        selectedTrapKey === t.full_name ? 'bg-[var(--tui-brand-soft)]' : ''
                      }`}
                    >
                      <span className="font-mono text-[11px] font-medium text-[var(--tui-ink-primary)] truncate">
                        {t.full_name}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--tui-ink-muted)] shrink-0">
                        {t.oid}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="next-trap-oid" className="block text-[11px] font-medium text-[var(--tui-ink-muted)]">
                Notification OID
              </label>
              <span className="text-[10px] text-[var(--tui-ink-muted)]">
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
              className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
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
                      { id: `vb-${Date.now()}`, oid: '', type: 'String', value: 'test' },
                    ])
                  }
                  className="h-6 px-2 rounded border border-[var(--tui-border-control)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer"
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
                        aria-label="VarBind OID or symbol"
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
                        className="flex-1 min-w-0 h-7 px-2 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setVbPickerRowId(vb.id);
                          setVbPickerInitialQuery(vb.oid.replace(/.*::/, '').replace(/\.\d+$/, ''));
                          setVbPickerOpen(true);
                        }}
                        aria-label="Lookup MIB object for this VarBind"
                        title="Lookup MIB object & auto-fill"
                        className="h-7 w-7 shrink-0 rounded border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-muted)] hover:text-[var(--tui-brand-ink)] hover:border-[var(--tui-brand-border)] inline-flex items-center justify-center cursor-pointer"
                      >
                        <Search className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setVarbinds((prev) => prev.filter((row) => row.id !== vb.id))}
                        aria-label="Remove VarBind"
                        title="Remove VarBind"
                        className="h-7 w-7 shrink-0 rounded border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-muted)] hover:text-[var(--tui-danger-ink)] inline-flex items-center justify-center cursor-pointer"
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
                        className="col-span-5 h-7 px-1.5 rounded text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
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
                          className="col-span-7 h-7 px-2 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
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
                          aria-label="VarBind value"
                          onChange={(e) =>
                            setVarbinds((prev) =>
                              prev.map((row) => (row.id === vb.id ? { ...row, value: e.target.value } : row))
                            )
                          }
                          placeholder="Value"
                          className="col-span-7 h-7 px-2 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
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
                        {err && hint && <span className="text-[var(--tui-ink-muted)] shrink-0">{hint}</span>}
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
              className="tui-btn-primary h-8 px-4 rounded-md text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{sending ? 'Sending...' : asInform ? 'Send Inform' : 'Send Trap'}</span>
            </button>
          </div>
        </form>

        {/* Right: Live Received Traps Stream */}
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--tui-bg-canvas)] lg:overflow-hidden min-h-[380px]">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Received Traps{' '}
                <span className="font-mono font-normal text-[var(--tui-ink-muted)]">
                  ({filteredTraps.length}
                  {trapTotal != null && trapTotal > filteredTraps.length ? ` of ${trapTotal}` : ''})
                </span>
              </h2>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[var(--tui-ink-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search received traps..."
                  aria-label="Search received traps"
                  className="h-8 pl-8 pr-7 w-48 rounded-md text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Clear received trap search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <button
                type="button"
                disabled={loadingTraps}
                onClick={() => void loadTrapsPage(trapOffset)}
                title="Refresh received traps"
                aria-label="Refresh received traps"
                className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingTraps ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Refresh</span>
              </button>

              <button
                type="button"
                aria-pressed={trapsPaused}
                onClick={() => setTrapsPaused((p) => !p)}
                className={`h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1 border cursor-pointer ${
                  trapsPaused
                    ? 'bg-[var(--tui-warning-soft)] border-[var(--tui-warning-border)] text-[var(--tui-warning-ink)]'
                    : 'bg-[var(--tui-bg-surface)] border-[var(--tui-border-control)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
                }`}
              >
                {trapsPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                <span>{trapsPaused ? 'Resume' : 'Pause'}</span>
              </button>

              <button
                type="button"
                onClick={() => setDecodeOpen(true)}
                className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] inline-flex items-center gap-1 cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>Decode BER</span>
              </button>

              <button
                type="button"
                disabled={filteredTraps.length === 0}
                onClick={() => {
                  const csv = toCsv(
                    filteredTraps.map((t) => {
                      const trapOidVb = (t.varbinds || []).find((v) =>
                        String(v.name || v.oid || '').includes('snmpTrapOID')
                      );
                      return {
                        timestamp: t.timestamp,
                        source: t.source || `${t.source_ip || ''}:${t.source_port || ''}`,
                        trap_name: t.trap_type || t.trap_name || t.trap_oid || '',
                        trap_oid: t.trap_oid || (trapOidVb ? String(trapOidVb.value ?? '') : '') || t.trap_type || '',
                        varbinds: (t.varbinds || [])
                          .map((v) => `${v.name || v.oid}=${v.display_value ?? v.value}`)
                          .join('; '),
                      };
                    }),
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
                className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-secondary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>

              <button
                type="button"
                disabled={(trapTotal ?? activeTrapsSource.length) === 0}
                onClick={() => void handleDownloadAllJson()}
                title="Download all received traps as JSON"
                className="h-8 px-2.5 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-secondary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>JSON</span>
              </button>

              <button
                type="button"
                disabled={activeTrapsSource.length === 0 && (trapTotal ?? 0) === 0}
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
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[11px] font-semibold text-[var(--tui-ink-muted)]">
                    <tr>
                      <th
                        scope="col"
                        aria-sort={sortCol === 'time' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                        className="py-2.5 px-3.5 whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort('time')}
                          className="inline-flex items-center gap-1 hover:text-[var(--tui-ink-primary)] cursor-pointer"
                        >
                          <span>Time</span>
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th
                        scope="col"
                        aria-sort={sortCol === 'source' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                        className="py-2.5 px-3.5 whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort('source')}
                          className="inline-flex items-center gap-1 hover:text-[var(--tui-ink-primary)] cursor-pointer"
                        >
                          <span>Source</span>
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th scope="col" className="py-2.5 px-3.5 whitespace-nowrap">
                        Notification
                      </th>
                      <th scope="col" className="py-2.5 px-3.5">
                        VarBinds
                      </th>
                      <th scope="col" className="py-2.5 px-3.5 text-right whitespace-nowrap">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--tui-border-subtle)] bg-[var(--tui-bg-surface)] font-mono text-xs tabular-nums">
                    {filteredTraps.map((trap, idx) => (
                      <tr
                        key={trap.id ?? `trap-${idx}-${trap.timestamp}`}
                        className="hover:bg-[var(--tui-bg-hover)] transition-colors"
                      >
                        <td className="py-2.5 px-3.5 text-[var(--tui-ink-muted)] whitespace-nowrap">
                          {formatRelativeTime(trap.timestamp)}
                        </td>
                        <td className="py-2.5 px-3.5 text-[var(--tui-ink-secondary)] whitespace-nowrap">
                          {trap.source || `${trap.source_ip || '127.0.0.1'}:${trap.source_port || ''}`}
                        </td>
                        <td className="py-2.5 px-3.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openInspector(trap)}
                            className="font-semibold text-[var(--tui-brand-ink)] hover:underline cursor-pointer"
                          >
                            {trap.trap_type || trap.trap_name || trap.trap_oid || 'SNMP Trap'}
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
                              onClick={() => openInspector(trap)}
                              aria-label={`Inspect trap ${trap.id ?? idx + 1}`}
                              title="Inspect VarBinds"
                              className="p-1.5 rounded border border-[var(--tui-border-control)] hover:bg-[var(--tui-bg-muted)] text-[var(--tui-ink-secondary)] cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={trap.id == null}
                              onClick={() => void handleReplay(trap, false)}
                              aria-label={`Replay trap ${trap.id ?? idx + 1}`}
                              title="Quick replay"
                              className="p-1.5 rounded border border-[var(--tui-border-control)] hover:bg-[var(--tui-bg-muted)] text-[var(--tui-ink-secondary)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={trap.id == null}
                              onClick={() => void handleDeleteTrap(trap.id)}
                              aria-label={`Delete trap ${trap.id ?? idx + 1}`}
                              title="Delete"
                              className="p-1.5 rounded border border-[var(--tui-danger-border)] hover:bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Server-Side Pagination Footer */}
          {(effectiveTotal > TRAPS_PAGE_LIMIT || trapOffset > 0) && (
            <div className="px-4 py-2 border-t border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] flex items-center justify-between gap-3 text-xs">
              <span className="font-mono text-[var(--tui-ink-muted)] tabular-nums">
                Showing {Math.min(effectiveTotal, trapOffset + 1)}–
                {Math.min(effectiveTotal, trapOffset + activeTrapsSource.length)} of {effectiveTotal} ·
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={trapOffset <= 0 || loadingTraps}
                  onClick={() => stepPage('newer')}
                  className="h-7 px-2.5 rounded border border-[var(--tui-border-control)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Newer</span>
                </button>
                <button
                  type="button"
                  disabled={trapOffset + TRAPS_PAGE_LIMIT >= effectiveTotal || loadingTraps}
                  onClick={() => stepPage('older')}
                  className="h-7 px-2.5 rounded border border-[var(--tui-border-control)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  <span>Older</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
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
                className="h-8 px-3 rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy JSON</span>
              </button>
              <button
                type="button"
                disabled={replaying || inspectedTrap.id == null}
                onClick={() => void handleReplay(inspectedTrap, true)}
                className="tui-btn-primary h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
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
                  {inspectedTrap.source || `${inspectedTrap.source_ip || '—'}:${inspectedTrap.source_port || '—'}`}
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
                <dd className="mt-0.5 text-[var(--tui-ink-primary)]">
                  {inspectedTrap.community || COMMUNITY_MASK}
                </dd>
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
                      {vb.type && <span className="text-[var(--tui-ink-muted)] shrink-0">{vb.type}</span>}
                    </div>
                    <div className="mt-1 text-[var(--tui-ink-secondary)] break-words">
                      {String(vb.display_value ?? vb.value ?? '')}
                      {vb.enum_label && (
                        <span className="ml-2 text-[var(--tui-info-ink)]">({vb.enum_label})</span>
                      )}
                      {vb.units && <span className="ml-1.5 text-[var(--tui-ink-muted)]">{vb.units}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <details className="border border-[var(--tui-border-default)] rounded-lg bg-[var(--tui-bg-subtle)]">
              <summary className="px-3 py-2 cursor-pointer text-xs font-semibold text-[var(--tui-ink-primary)] hover:text-[var(--tui-brand-ink)] select-none">
                Raw Trap JSON
              </summary>
              <pre className="p-3 border-t border-[var(--tui-border-default)] bg-[var(--tui-bg-terminal)] text-[var(--tui-terminal-text)] font-mono text-[11px] overflow-auto max-h-64 rounded-b-lg">
                {JSON.stringify(inspectedTrap, null, 2)}
              </pre>
            </details>

            <div className="p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] space-y-2.5">
              <div className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Replay Overrides (optional)
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="next-replay-host" className="block text-[10px] text-[var(--tui-ink-muted)] mb-1">
                    Host
                  </label>
                  <input
                    id="next-replay-host"
                    type="text"
                    value={replayHost}
                    onChange={(e) => setReplayHost(e.target.value)}
                    placeholder="Default 127.0.0.1"
                    className="w-full h-8 px-2.5 rounded font-mono text-xs bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
                  />
                </div>
                <div>
                  <label htmlFor="next-replay-port" className="block text-[10px] text-[var(--tui-ink-muted)] mb-1">
                    Port
                  </label>
                  <input
                    id="next-replay-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={replayPort}
                    onChange={(e) => setReplayPort(e.target.value)}
                    placeholder="Default 162"
                    className="w-full h-8 px-2.5 rounded font-mono text-xs bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
                  />
                </div>
                <div className="col-span-2">
                  <label htmlFor="next-replay-comm" className="block text-[10px] text-[var(--tui-ink-muted)] mb-1">
                    Community (leave blank to reuse stored community)
                  </label>
                  <SecretInput
                    id="next-replay-comm"
                    value={replayCommunity}
                    onChange={setReplayCommunity}
                    placeholder="Leave blank to reuse stored"
                    toggleLabel="replay community"
                  />
                </div>
                <div>
                  <label htmlFor="next-replay-timeout" className="block text-[10px] text-[var(--tui-ink-muted)] mb-1">
                    Timeout (s)
                  </label>
                  <input
                    id="next-replay-timeout"
                    type="number"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={replayTimeout}
                    onChange={(e) => setReplayTimeout(e.target.value)}
                    placeholder="Default 2"
                    className="w-full h-8 px-2.5 rounded font-mono text-xs bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
                  />
                </div>
                <div>
                  <label htmlFor="next-replay-retries" className="block text-[10px] text-[var(--tui-ink-muted)] mb-1">
                    Retries
                  </label>
                  <input
                    id="next-replay-retries"
                    type="number"
                    min={0}
                    max={5}
                    value={replayRetries}
                    onChange={(e) => setReplayRetries(e.target.value)}
                    placeholder="Default 1"
                    className="w-full h-8 px-2.5 rounded font-mono text-xs bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
                  />
                </div>
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
                    : 'bg-[var(--tui-bg-surface)] border-[var(--tui-border-control)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
                }`}
              >
                {enc}
              </button>
            ))}
          </div>

          <textarea
            rows={5}
            aria-label="BER trap payload"
            value={decodePayload}
            onChange={(e) => setDecodePayload(e.target.value)}
            placeholder={
              decodeEncoding === 'hex'
                ? '30 4a 02 01 01 04 06 70 75 62 6c 69 63 ...'
                : 'MEoCAQEEBnB1YmxpYw=='
            }
            className="w-full p-3 rounded-lg font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus-visible:border-[var(--tui-brand)]"
          />

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="next-decode-host" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Source Host (optional)
              </label>
              <input
                id="next-decode-host"
                type="text"
                value={decodeSourceHost}
                onChange={(e) => setDecodeSourceHost(e.target.value)}
                placeholder="127.0.0.1"
                className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)]"
              />
            </div>
            <div>
              <label htmlFor="next-decode-port" className="block text-[11px] font-medium text-[var(--tui-ink-muted)] mb-1">
                Source Port (optional)
              </label>
              <input
                id="next-decode-port"
                type="number"
                min={1}
                max={65535}
                value={decodeSourcePort}
                onChange={(e) => setDecodeSourcePort(e.target.value)}
                placeholder="1162"
                className="w-full h-8 px-2.5 rounded-md font-mono text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={decoding || !decodePayload.trim()}
            className="tui-btn-primary h-9 px-4 rounded-md text-xs font-semibold disabled:opacity-45 cursor-pointer"
          >
            {decoding ? 'Decoding...' : 'Decode Payload'}
          </button>

          {decodeResult && (
            <div className="space-y-3 pt-2 border-t border-[var(--tui-border-subtle)]">
              {decodeResult.event && (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusLabel
                      tone="info"
                      label={
                        decodeResult.event.notification_name ||
                        decodeResult.event.notification_oid ||
                        'Decoded PDU'
                      }
                    />
                    {decodeResult.event.pdu_type && (
                      <span className="font-mono text-[var(--tui-ink-muted)]">
                        {decodeResult.event.pdu_type}
                      </span>
                    )}
                    {decodeResult.event.community && (
                      <span className="font-mono text-[var(--tui-ink-muted)]">
                        community: <code className="text-[var(--tui-ink-primary)]">{decodeResult.event.community}</code>
                      </span>
                    )}
                    {decodeResult.event.source_address && (
                      <span className="font-mono text-[var(--tui-ink-muted)]">
                        from{' '}
                        <code className="text-[var(--tui-ink-primary)]">
                          {decodeResult.event.source_address.host || '—'}:
                          {decodeResult.event.source_address.port || '—'}
                        </code>
                      </span>
                    )}
                    {decodeResult.event.uptime != null && (
                      <span className="font-mono text-[var(--tui-ink-muted)]">
                        uptime: <code className="text-[var(--tui-ink-primary)]">{String(decodeResult.event.uptime)}</code>
                      </span>
                    )}
                  </div>

                  <div className="border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                    <table className="w-full text-xs font-mono">
                      <thead className="bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[10px] uppercase text-[var(--tui-ink-muted)]">
                        <tr>
                          <th scope="col" className="text-left px-3 py-1.5">
                            Name / OID
                          </th>
                          <th scope="col" className="text-left px-3 py-1.5">
                            Value
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--tui-border-subtle)] bg-[var(--tui-bg-surface)]">
                        {(decodeResult.event.varbinds || []).length === 0 ? (
                          <tr>
                            <td colSpan={2} className="px-3 py-2 text-[var(--tui-ink-muted)]">
                              No VarBinds decoded.
                            </td>
                          </tr>
                        ) : (
                          (decodeResult.event.varbinds || []).map((vb, i) => {
                            const rawVal = vb.value as { display?: unknown } | unknown;
                            const valText =
                              rawVal && typeof rawVal === 'object' && 'display' in rawVal && rawVal.display != null
                                ? String(rawVal.display)
                                : vb.display_value != null
                                  ? vb.display_value
                                  : rawVal != null
                                    ? String(rawVal)
                                    : '';
                            return (
                              <tr key={i}>
                                <td className="px-3 py-1.5 text-[var(--tui-ink-primary)] break-all">
                                  {vb.symbolic || vb.oid || '—'}
                                </td>
                                <td className="px-3 py-1.5 text-[var(--tui-ink-secondary)] break-words">
                                  {valText}
                                  {vb.enum_label && (
                                    <span className="ml-1.5 text-[var(--tui-info-ink)]">({vb.enum_label})</span>
                                  )}
                                  {vb.units && (
                                    <span className="ml-1 text-[var(--tui-ink-muted)]">{vb.units}</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <details className="text-xs">
                <summary className="cursor-pointer font-mono text-[11px] text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]">
                  Raw decoded JSON
                </summary>
                <pre className="mt-2 p-3 rounded-lg border border-[var(--tui-terminal-border)] bg-[var(--tui-bg-terminal)] text-[var(--tui-terminal-text)] font-mono text-xs overflow-auto max-h-72">
                  {JSON.stringify(decodeResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </form>
      </SlideDrawer>
    </div>
  );
};

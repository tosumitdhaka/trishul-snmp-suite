import type { EnumValue, SimulatorLogEntry } from '../types/api';

const SIMULATOR_LOG_BATCH_WINDOW_MS = 1200;
const SIMULATOR_LOG_RETENTION = 500;

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) {
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (whole < 86400) {
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(whole / 86400);
  const h = Math.floor((whole % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function formatRelativeTime(isoOrDate: string | null | undefined, nowMs = Date.now()): string {
  if (!isoOrDate) return '—';
  const parsed = Date.parse(isoOrDate);
  if (!Number.isFinite(parsed)) return isoOrDate;
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(parsed).toLocaleDateString();
}

export function formatClockTime(isoOrFallback: string | null | undefined): string {
  if (!isoOrFallback) return new Date().toLocaleTimeString();
  const parsed = Date.parse(isoOrFallback);
  if (!Number.isFinite(parsed)) return isoOrFallback;
  return new Date(parsed).toLocaleTimeString();
}

export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: Array<{ key: keyof T & string; label: string }>
): string {
  const esc = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = columns.map((c) => esc(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => esc(row[c.key])).join(','));
  return [header, ...lines].join('\n');
}

export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function normalizeEnums(source: unknown): EnumValue[] {
  if (!source) return [];
  const results: EnumValue[] = [];
  const seen = new Set<string>();

  const push = (label: string, rawVal: unknown) => {
    const num = Number(rawVal);
    if (!Number.isInteger(num)) return;
    const cleanLabel = label.trim() || String(num);
    const key = `${cleanLabel}|${num}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ label: cleanLabel, value: num });
  };

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (Array.isArray(entry) && entry.length >= 2) {
        push(String(entry[0] ?? ''), entry[1]);
      } else if (entry && typeof entry === 'object') {
        const rec = entry as Record<string, unknown>;
        push(String(rec.label ?? rec.name ?? rec.symbol ?? ''), rec.value);
      }
    }
  } else if (typeof source === 'object') {
    const rec = source as Record<string, unknown>;
    if (String(rec.kind ?? '').toLowerCase() === 'enum' && Array.isArray(rec.data)) {
      return normalizeEnums(rec.data);
    }
    for (const [k, v] of Object.entries(rec)) {
      push(k, v);
    }
  }

  return results.sort((a, b) => a.value - b.value);
}

export function formatEnrichedValue(
  value: unknown,
  opts?: { enumLabel?: string | null; units?: string | null }
): string {
  const raw = value == null ? '' : String(value);
  const parts: string[] = [raw];
  const enumLabel = String(opts?.enumLabel ?? '').trim();
  const units = String(opts?.units ?? '').trim();
  if (enumLabel) parts.push(`${enumLabel}(${raw})`);
  if (units) parts.push(units);
  return parts.filter(Boolean).join(' ');
}

export function normalizeSimulatorLog(entry: Partial<SimulatorLogEntry>): SimulatorLogEntry {
  const fallbackTime = String(entry.time ?? '');
  const timestamp = entry.last_event_timestamp || entry.timestamp || undefined;
  return {
    time: formatClockTime(timestamp || fallbackTime),
    timestamp: entry.timestamp,
    last_event_timestamp: entry.last_event_timestamp,
    level: String(entry.level || 'info').toLowerCase(),
    message: String(entry.message || ''),
    request_type: entry.request_type ? String(entry.request_type).toUpperCase() : undefined,
    request_count: entry.request_count,
    oid_count: entry.oid_count,
    first_requested_oid: entry.first_requested_oid,
    first_returned_oid: entry.first_returned_oid,
  };
}

export function appendBatchedSimulatorLog(
  existing: SimulatorLogEntry[],
  incoming: Partial<SimulatorLogEntry>
): SimulatorLogEntry[] {
  const next = normalizeSimulatorLog(incoming);
  const copy = [...existing];
  const prev = copy[copy.length - 1];

  const batchable = new Set(['GETNEXT', 'GETBULK']);
  if (
    prev &&
    prev.level === 'info' &&
    next.level === 'info' &&
    prev.request_type &&
    prev.request_type === next.request_type &&
    batchable.has(prev.request_type)
  ) {
    const prevTs = Date.parse(prev.last_event_timestamp || prev.timestamp || '');
    const nextTs = Date.parse(next.last_event_timestamp || next.timestamp || '');
    if (
      Number.isFinite(prevTs) &&
      Number.isFinite(nextTs) &&
      nextTs >= prevTs &&
      nextTs - prevTs <= SIMULATOR_LOG_BATCH_WINDOW_MS
    ) {
      const reqCount = (prev.request_count || 1) + (next.request_count || 1);
      const oidCount = (prev.oid_count || 0) + (next.oid_count || 0);
      const firstRequested = prev.first_requested_oid || next.first_requested_oid;
      const lastReturned = next.first_returned_oid || next.first_requested_oid || prev.first_returned_oid;
      const range =
        firstRequested && lastReturned && firstRequested !== lastReturned
          ? ` from ${firstRequested} -> ${lastReturned}`
          : firstRequested
            ? ` from ${firstRequested}`
            : '';

      copy[copy.length - 1] = {
        ...prev,
        ...next,
        request_count: reqCount,
        oid_count: oidCount,
        first_requested_oid: firstRequested,
        first_returned_oid: lastReturned,
        last_event_timestamp: next.last_event_timestamp || next.timestamp || prev.last_event_timestamp,
        message: `Walk activity: ${reqCount} ${prev.request_type} ${reqCount === 1 ? 'request' : 'requests'}, ${oidCount} ${oidCount === 1 ? 'OID' : 'OIDs'}${range}`,
      };
      return copy;
    }
  }

  copy.push(next);
  if (copy.length > SIMULATOR_LOG_RETENTION) {
    copy.splice(0, copy.length - SIMULATOR_LOG_RETENTION);
  }
  return copy;
}

export function countLogsByLevel(logs: SimulatorLogEntry[]): Record<'all' | 'info' | 'success' | 'warning' | 'error', number> {
  const counts = { all: logs.length, info: 0, success: 0, warning: 0, error: 0 };
  for (const item of logs) {
    const lvl = item.level.toLowerCase();
    if (lvl === 'info') counts.info += 1;
    else if (lvl === 'success') counts.success += 1;
    else if (lvl === 'warning' || lvl === 'warn') counts.warning += 1;
    else if (lvl === 'error' || lvl === 'danger') counts.error += 1;
  }
  return counts;
}

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
  group: string;
}

export function filterPaletteItems<T extends PaletteItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .map((item) => {
      const label = item.label.toLowerCase();
      const hint = (item.hint || '').toLowerCase();
      const kw = (item.keywords || []).join(' ').toLowerCase();
      let score = -1;
      if (label === q) score = 100;
      else if (label.startsWith(q)) score = 80;
      else if (label.includes(q)) score = 60;
      else if (kw.includes(q)) score = 40;
      else if (hint.includes(q)) score = 20;
      return { item, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

export function toTsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: Array<{ key: keyof T & string; label: string }>
): string {
  const clean = (v: unknown) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const header = columns.map((c) => clean(c.label)).join('\t');
  const lines = rows.map((row) => columns.map((c) => clean(row[c.key])).join('\t'));
  return [header, ...lines].join('\n');
}

export interface NormalizedConstraint {
  kind: 'range' | 'size';
  ranges: Array<[number, number]>;
}

export function normalizeConstraint(raw: unknown): NormalizedConstraint | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawKind = String(obj.type || obj.kind || '').trim().toLowerCase();
  if (rawKind !== 'range' && rawKind !== 'size') return null;
  const list = Array.isArray(obj.ranges) ? obj.ranges : Array.isArray(obj.data) ? obj.data : [];
  const ranges: Array<[number, number]> = [];
  for (const pair of list) {
    if (Array.isArray(pair) && pair.length >= 2) {
      const lo = Number(pair[0]);
      const hi = Number(pair[1]);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        ranges.push([lo, hi]);
      }
    }
  }
  if (ranges.length === 0) return null;
  return { kind: rawKind, ranges };
}

const NUMERIC_SNMP_TYPES = new Set(['Integer', 'Gauge32', 'Counter32', 'Counter64', 'TimeTicks']);
const SIZED_SNMP_TYPES = new Set(['String', 'OID']);

export function formatConstraintHint(rawConstraint: unknown, snmpType: string): string {
  const c = normalizeConstraint(rawConstraint);
  if (!c) return '';
  if (c.kind === 'range' && !NUMERIC_SNMP_TYPES.has(snmpType)) return '';
  if (c.kind === 'size' && !SIZED_SNMP_TYPES.has(snmpType)) return '';
  const parts = c.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}..${b}`));
  if (parts.length === 0) return '';
  return c.kind === 'range' ? `Range: ${parts.join(', ')}` : `Length: ${parts.join(', ')} bytes`;
}

export function inferSnmpVarbindType(obj: {
  input_type?: string | null;
  syntax?: string | null;
  name?: string | null;
}): string {
  const mapToken = (raw: string): string | null => {
    const s = raw.trim().toLowerCase();
    if (!s) return null;
    if (s.includes('counter64')) return 'Counter64';
    if (s.includes('counter')) return 'Counter32';
    if (s.includes('gauge') || s.includes('unsigned')) return 'Gauge32';
    if (s.includes('timetick') || s.includes('timestamp') || s.includes('timeinterval')) return 'TimeTicks';
    if (s.includes('ipaddress') || s === 'ip') return 'IpAddress';
    if (s === 'oid' || s.includes('object identifier') || s.includes('objectidentifier')) return 'OID';
    if (s.includes('integer') || s === 'int' || s.includes('truthvalue') || s.includes('rowstatus')) {
      return 'Integer';
    }
    if (s.includes('string') || s.includes('octet') || s.includes('display') || s.includes('physaddress')) {
      return 'String';
    }
    return null;
  };

  if (obj.input_type) {
    const mapped = mapToken(obj.input_type);
    if (mapped) return mapped;
  }
  if (obj.syntax) {
    const mapped = mapToken(obj.syntax);
    if (mapped) return mapped;
  }
  const lowName = String(obj.name || '').toLowerCase();
  if (lowName.includes('addr')) return 'IpAddress';
  if (lowName.includes('time') || lowName.includes('tick')) return 'TimeTicks';
  if (lowName.includes('speed') || lowName.includes('gauge')) return 'Gauge32';
  if (lowName.includes('index') || lowName.includes('status') || lowName.includes('state') || lowName.includes('count')) {
    return 'Integer';
  }
  if (lowName.includes('oid')) return 'OID';
  return 'String';
}

export function defaultValueForVarbind(
  snmpType: string,
  enumValues?: EnumValue[],
  rawConstraint?: unknown
): string {
  if (snmpType === 'Integer' && enumValues && enumValues.length > 0) {
    return String(enumValues[0].value);
  }
  const c = normalizeConstraint(rawConstraint);
  if (NUMERIC_SNMP_TYPES.has(snmpType)) {
    if (c && c.kind === 'range' && c.ranges.length > 0) {
      const [lo, hi] = c.ranges[0];
      if (lo <= 1 && hi >= 1) return '1';
      return String(lo);
    }
    return snmpType === 'TimeTicks' ? '12345' : '1';
  }
  if (snmpType === 'IpAddress') return '127.0.0.1';
  if (snmpType === 'OID') return '1.3.6.1.2.1.1';
  return '';
}

export function validateVarbindInput(params: {
  oid: string;
  type: string;
  value: string;
  enumValues?: EnumValue[];
  constraint?: unknown;
}): string | null {
  const oid = params.oid.trim();
  const val = params.value.trim();
  if (!oid && !val) return null;
  if (!oid) return 'OID or MIB symbol is required.';
  if (!val) return 'Value is required.';

  const t = params.type;
  const c = normalizeConstraint(params.constraint);

  if (NUMERIC_SNMP_TYPES.has(t)) {
    if (!/^-?\d+$/.test(val)) return `Expected integer value for ${t}.`;
    const num = Number(val);
    if (t !== 'Integer' && num < 0) return `${t} cannot be negative.`;
    if (t === 'Integer' && params.enumValues && params.enumValues.length > 0) {
      const allowed = params.enumValues.some((e) => e.value === num);
      if (!allowed) return 'Select one of the declared MIB enum values.';
    }
    if (c && c.kind === 'range') {
      const inRange = c.ranges.some(([lo, hi]) => num >= lo && num <= hi);
      if (!inRange) return `Value outside ${formatConstraintHint(c, t)}.`;
    }
    return null;
  }

  if (t === 'IpAddress') {
    const parts = val.split('.');
    const validIp =
      parts.length === 4 &&
      parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
    if (!validIp) return 'Enter a valid IPv4 address (e.g. 127.0.0.1).';
    return null;
  }

  if (t === 'OID') {
    const isNumeric = /^\.?\d+(\.\d+)+$/.test(val);
    const isSymbolic = /^[A-Za-z0-9_-]+::[A-Za-z0-9_.-]+$/.test(val);
    if (!isNumeric && !isSymbolic) return 'Enter a numeric OID (1.3.6...) or MODULE::symbol.';
    return null;
  }

  if (SIZED_SNMP_TYPES.has(t) && c && c.kind === 'size') {
    const byteLen = new TextEncoder().encode(val).length;
    const within = c.ranges.some(([lo, hi]) => byteLen >= lo && byteLen <= hi);
    if (!within) return `Byte length (${byteLen}) outside ${formatConstraintHint(c, t)}.`;
  }

  return null;
}


import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square, RefreshCw, Save, Trash2, Download, Pause, Search } from 'lucide-react';
import { apiRequest } from '../../lib/api/client';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { Banner, Card, ConfirmDialog, Field, JsonView, StatusText, displayValue, jsonPost, positivePort, saveLocalFile, useOperatorApi } from '../shared/operator-ui';

interface SimulatorStatus { running?: boolean; port?: number; community?: string; uptime_seconds?: number; requests?: number; last_activity?: string | null }
interface LogEntry { timestamp?: string; level?: string; message?: string; msg?: string; [key: string]: unknown }
interface SimulatorLogs { items?: LogEntry[]; total?: number }
const statusKey = ['simulator', 'status'];
const logsKey = ['simulator', 'logs'];

export function SimulatorPage() {
  const { token, pending, notice, setNotice, invoke } = useOperatorApi();
  const cache = useQueryClient();
  const live = useRealtime() === 'live';
  const status = useQuery({ queryKey: statusKey, queryFn: ({ signal }) => apiRequest<SimulatorStatus>('/api/simulator/status', token, { signal }), enabled: !!token, refetchInterval: live ? 20_000 : 5_000 });
  const [follow, setFollow] = useState(true);
  const logs = useQuery({ queryKey: logsKey, queryFn: ({ signal }) => apiRequest<SimulatorLogs>('/api/simulator/logs?limit=200', token, { signal }), enabled: !!token, refetchInterval: follow ? 5_000 : false });
  const data = useQuery({ queryKey: ['simulator', 'data'], queryFn: ({ signal }) => apiRequest<Record<string, unknown>>('/api/simulator/data', token, { signal }), enabled: !!token });
  const [port, setPort] = useState('1061');
  const [community, setCommunity] = useState('public');
  const [editor, setEditor] = useState('');
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (status.data && !status.isError) {
      setPort(String(status.data.port ?? 1061));
      setCommunity(status.data.community || 'public');
    }
  }, [status.data]);
  useEffect(() => {
    if (data.data && !dirty) setEditor(JSON.stringify(data.data, null, 2));
  }, [data.data, dirty]);
  const listed = useMemo(() => {
    const rows = Array.isArray(logs.data?.items) ? logs.data.items : [];
    return rows.filter((row) => {
      const category = String(row.level || '').toLowerCase();
      return (level === 'all' || category === level) &&
        JSON.stringify(row).toLowerCase().includes(filter.trim().toLowerCase());
    });
  }, [logs.data, filter, level]);
  async function run(action: 'start' | 'stop' | 'restart') {
    if (action === 'start' && (!positivePort(port) || !community.trim())) {
      setNotice({ tone: 'error', text: 'Enter a valid UDP port and community.' }); return;
    }
    const body = action === 'start' ? jsonPost({ port: positivePort(port), community }) : { method: 'POST' };
    await invoke('/api/simulator/' + action, body, [statusKey, ['stats']]);
  }
  async function saveData() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Expected a JSON object.');
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Invalid JSON.' }); return;
    }
    const saved = await invoke('/api/simulator/data', jsonPost(parsed), [['simulator', 'data'], statusKey]);
    if (saved) { setDirty(false); await cache.invalidateQueries({ queryKey: ['simulator', 'data'] }); }
  }
  return <div className="space-y-6">
    <header><p className="eyebrow">Operations / Simulator</p><h1 className="mt-1 text-2xl font-semibold">SNMP responder</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">Manage the UDP responder, custom values and recent activity.</p></header>
    <Banner notice={notice} />
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Card title="Runtime" description="Start, stop and restart the existing responder."
        trailing={<span role="status" className={status.data?.running ? 'text-sm font-semibold text-[var(--success)]' : 'text-sm text-[var(--muted)]'}>{status.isError ? 'Unavailable' : status.isPending ? 'Checking…' : status.data?.running ? 'Running' : 'Stopped'}</span>}>
        <StatusText busy={status.isPending} error={status.error} />
        <div className="grid gap-3 sm:grid-cols-2"><Field label="UDP port"><input className="field-input" type="number" min={1} max={65535} value={port} disabled={pending || status.data?.running || status.isPending || status.isError} onChange={e => setPort(e.target.value)} /></Field>
          <Field label="Community" hint="Not displayed in exported logs."><input className="field-input" type="password" autoComplete="off" value={community} disabled={pending || status.data?.running || status.isPending || status.isError} onChange={e => setCommunity(e.target.value)} /></Field></div>
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-[var(--surface-muted)] p-4 text-sm">
          <div>Requests served<strong className="block text-xl">{status.data?.requests ?? '—'}</strong></div>
          <div>Uptime<strong className="block text-xl">{status.data?.uptime_seconds == null ? '—' : status.data.uptime_seconds + 's'}</strong></div>
          <div className="col-span-2">Last activity <strong className="block break-words">{displayValue(status.data?.last_activity)}</strong></div></div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={pending || !!status.data?.running || status.isError || status.isPending} onClick={() => void run('start')}><Play size={16} /> Start</button>
          <button className="btn-secondary" disabled={pending || !status.data?.running || status.isError} onClick={() => void run('stop')}><Square size={16} /> Stop</button>
          <button className="btn-secondary" disabled={pending || !status.data?.running || status.isError} onClick={() => void run('restart')}><RefreshCw size={16} /> Restart</button>
          <button className="btn-secondary" onClick={() => void status.refetch()}><RefreshCw size={16} /> Refresh</button>
        </div>
      </Card>
      <Card title="Custom SNMP data" description="Server-backed JSON OID overrides. Changes require a save.">
        <StatusText busy={data.isPending} error={data.error} />
        <Field label="Override JSON" hint="Must be a JSON object. The backend validates supported types and OIDs.">
          <textarea className="field-input h-72 font-mono text-xs" spellCheck={false} value={editor} disabled={data.isPending || data.isError || pending}
            onChange={(e) => { setEditor(e.target.value); setDirty(true); }} /></Field>
        {dirty && <p role="status" className="text-xs text-[var(--warning)]">Unsaved custom-data edits</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={pending || !dirty || data.isPending || data.isError} onClick={() => void saveData()}><Save size={16} /> Save custom data</button>
          <button className="btn-secondary" disabled={!dirty} onClick={() => { setEditor(JSON.stringify(data.data ?? {}, null, 2)); setDirty(false); }}>Discard</button>
          {data.data && <button className="btn-secondary" onClick={() => saveLocalFile(JSON.stringify(data.data, null, 2), 'trishul-simulator-data.json')}><Download size={16} /> Export JSON</button>}
        </div>
      </Card>
    </div>
    <Card title="Activity logs" description="Bounded server history; search, severity filter and export.">
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-[13rem] flex-1 items-center gap-2"><Search size={16} /><span className="sr-only">Search logs</span><input className="field-input" placeholder="Search logs" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <label><span className="sr-only">Log level</span><select className="field-input" value={level} onChange={e => setLevel(e.target.value)}>
          <option value="all">All levels</option>{['info','warning','error','debug'].map(item => <option key={item} value={item}>{item}</option>)}
        </select></label>
        <button className="btn-secondary" onClick={() => setFollow(v => !v)}><Pause size={16} /> {follow ? 'Pause auto-refresh' : 'Resume auto-refresh'}</button>
        <button className="btn-secondary" onClick={() => { void logs.refetch(); }}><RefreshCw size={16} /> Refresh</button>
        <button className="btn-secondary" onClick={() => saveLocalFile(JSON.stringify(listed, null, 2), 'trishul-simulator-logs.json')} disabled={!listed.length}><Download size={16} /> Export</button>
        <button className="btn-secondary text-[var(--danger)]" onClick={() => setConfirmClear(true)}><Trash2 size={16} /> Clear server logs</button>
      </div>
      <StatusText busy={logs.isPending} error={logs.error} empty={!listed.length && !logs.isPending && !logs.isError} />
      <div className="max-h-[24rem] space-y-1 overflow-auto" role="log" aria-label="Simulator activity" aria-live="off">
        {listed.slice(-200).map((item,i) => <div key={i} className="rounded-lg border-b border-[var(--border)] p-2 text-xs">
          <span className="mr-2 font-mono text-[var(--muted)]">{item.timestamp || ''}</span>
          <span className="mr-2 font-semibold">{item.level || 'EVENT'}</span>
          <span className="break-all">{displayValue(item.message || item.msg || item)}</span>
        </div>)}
      </div>
      {logs.data && !Array.isArray(logs.data.items) && <JsonView data={logs.data} />}
    </Card>
    <ConfirmDialog open={confirmClear} title="Clear simulator activity logs?" danger
      message="This deletes server-side simulator activity history. Export first if needed."
      busy={pending} onCancel={() => setConfirmClear(false)}
      onConfirm={() => { void invoke('/api/simulator/logs', { method: 'DELETE' }, [logsKey]).then(() => setConfirmClear(false)); }} />
  </div>;
}

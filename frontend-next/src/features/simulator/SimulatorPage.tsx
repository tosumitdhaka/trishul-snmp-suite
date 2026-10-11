import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, BookOpen } from 'lucide-react';
import { sendToBrowser, sendToWalker } from '../../lib/navigation/handoff';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Save, Trash2, Download, Search, WandSparkles } from 'lucide-react';
import { apiRequest } from '../../lib/api/client';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { Card, ConfirmDialog, Field, IconAction, JsonView, ServiceToggle, StatusText, displayValue, jsonPost, positivePort, saveLocalFile, useOperatorApi } from '../shared/operator-ui';
import { syncUntouched } from '../shared/draft-sync';

interface SimulatorStatus { running?: boolean; port?: number; community?: string; uptime_seconds?: number; requests?: number; last_activity?: string | null }
interface LogEntry { timestamp?: string; level?: string; message?: string; msg?: string; [key: string]: unknown }
interface SimulatorLogs { items?: LogEntry[]; total?: number }
const statusKey = ['simulator', 'status'];
const logsKey = ['simulator', 'logs'];

export function SimulatorPage() {
  const { token, pending, setNotice, invoke } = useOperatorApi();
  const cache = useQueryClient();
  const live = useRealtime() === 'live';
  const status = useQuery({ queryKey: statusKey, queryFn: ({ signal }) => apiRequest<SimulatorStatus>('/api/simulator/status', token, { signal }), enabled: !!token, refetchInterval: live ? 20_000 : 5_000 });
  const [follow, setFollow] = useState(true);
  const logs = useQuery({ queryKey: logsKey, queryFn: ({ signal }) => apiRequest<SimulatorLogs>('/api/simulator/logs?limit=200', token, { signal }), enabled: !!token, refetchInterval: follow ? 5_000 : false });
  const data = useQuery({ queryKey: ['simulator', 'data'], queryFn: ({ signal }) => apiRequest<Record<string, unknown>>('/api/simulator/data', token, { signal }), enabled: !!token });
  const [port, setPort] = useState('1061');
  const [community, setCommunity] = useState('public');
  const [portTouched, setPortTouched] = useState(false);
  const [communityTouched, setCommunityTouched] = useState(false);
  const [editor, setEditor] = useState('');
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (status.data && !status.isError) {
      setPort(current => syncUntouched(current, String(status.data.port ?? 1061), portTouched));
      setCommunity(current => syncUntouched(current, status.data.community || 'public', communityTouched));
    }
  }, [status.data, status.isError, portTouched, communityTouched]);
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
    const response = await invoke('/api/simulator/' + action, body, [statusKey, ['stats']]);
    if (response && action === 'start') { setPortTouched(false); setCommunityTouched(false); }
  }
  function formatJson() {
    try {
      const value: unknown = JSON.parse(editor);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a JSON object.');
      const formatted = JSON.stringify(value, null, 2);
      if (formatted !== editor) { setEditor(formatted); setDirty(true); }
      setNotice({tone:'success',text:'JSON formatted locally. Save to apply changes on the server.'});
    } catch (error) {
      setNotice({tone:'error',text:error instanceof Error ? error.message : 'Invalid JSON.'});
    }
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
  return <div className="workspace-page">
    <header><p className="eyebrow">Operations / Simulator</p><h1 className="mt-1 text-2xl font-semibold">SNMP responder</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">Manage the UDP responder, custom values and recent activity.</p></header>
    <div className="workspace-grid workspace-grid--two">
      <Card title="Runtime" compact description="Run the SNMP responder and inspect its activity."
        trailing={<span role="status" className={'service-status ' + (status.data?.running ? 'service-status-simulator' : 'service-status-off')}>{status.isError ? 'Unavailable' : status.isPending ? 'Checking…' : status.data?.running ? 'Running' : 'Stopped'}</span>}>
        <StatusText busy={status.isPending} error={status.error} />
        <div className="grid gap-3 sm:grid-cols-2"><Field label="UDP port"><input className="field-input" type="number" min={1} max={65535} value={port} disabled={pending || status.data?.running || status.isPending || status.isError} onChange={e => { setPort(e.target.value); setPortTouched(true); }} /></Field>
          <Field label="Community" hint="Not displayed in exported logs."><input className="field-input" type="password" autoComplete="off" value={community} disabled={pending || status.data?.running || status.isPending || status.isError} onChange={e => { setCommunity(e.target.value); setCommunityTouched(true); }} /></Field></div>
        {(portTouched || communityTouched) && <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-[var(--warning)]">
          <span>Unsaved runtime configuration; polling will not overwrite it. Restart uses server settings.</span>
          <button type="button" className="btn-secondary" onClick={() => {
            setPort(String(status.data?.port ?? 1061)); setCommunity(status.data?.community || 'public');
            setPortTouched(false); setCommunityTouched(false);
          }}>Reset to server</button>
        </div>}
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-muted)] p-3 text-xs">
          <div>Requests served<strong className="block text-xl">{status.data?.requests ?? '—'}</strong></div>
          <div>Uptime<strong className="block text-xl">{status.data?.uptime_seconds == null ? '—' : status.data.uptime_seconds + 's'}</strong></div>
          <div className="col-span-2">Last activity <strong className="block truncate text-sm" title={displayValue(status.data?.last_activity)}>{displayValue(status.data?.last_activity)}</strong></div></div>
        <div className="flex flex-wrap gap-2">
          <ServiceToggle noun="simulator" running={!!status.data?.running} busy={pending}
            disabled={status.isError || status.isPending || !status.data}
            onToggle={() => void run(status.data?.running ? 'stop' : 'start')} />
          <button className="btn-secondary" disabled={pending || !status.data?.running || status.isError} onClick={() => void run('restart')}><RotateCcw size={16} /> Restart</button>
          <IconAction label="Refresh simulator status" onClick={() => { void status.refetch(); }}><RefreshCw size={16}/></IconAction>
          <Link className="btn-secondary" to="/walker" onClick={() => sendToWalker({ target: '127.0.0.1', port: status.data?.port || positivePort(port) || 1061 })}>
            Walk simulator <ArrowRight size={15} />
          </Link>
          <Link className="btn-secondary" to="/browser" onClick={() => sendToBrowser({ query: '1.3.6.1.2.1' })}>
            <BookOpen size={15} /> Browse OIDs
          </Link>
        </div>
      </Card>
      <Card title="Custom SNMP data" compact description="Edit server-backed OID overrides in JSON.">
        <StatusText busy={data.isPending} error={data.error} />
        <Field label="Override JSON" hint="JSON object; validated by backend. Drag to expand the editor.">
          <textarea rows={5} className="field-input simulator-data-editor font-mono text-xs" spellCheck={false} value={editor} disabled={data.isPending || data.isError || pending}
            onChange={(e) => { setEditor(e.target.value); setDirty(true); }} /></Field>
        {dirty && <p role="status" className="text-xs text-[var(--warning)]">Unsaved custom-data edits</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" type="button" onClick={formatJson} disabled={data.isPending || data.isError || pending}>
            <WandSparkles size={16}/> Beautify JSON
          </button>
          <button className="btn-primary" disabled={pending || !dirty || data.isPending || data.isError} onClick={() => void saveData()}><Save size={16} /> Save custom data</button>
          <button className="btn-secondary" disabled={!dirty} onClick={() => { setEditor(JSON.stringify(data.data ?? {}, null, 2)); setDirty(false); }}>Discard</button>
          {data.data && <button className="btn-secondary" onClick={() => saveLocalFile(JSON.stringify(data.data, null, 2), 'trishul-simulator-data.json')}><Download size={16}/> JSON</button>}
        </div>
      </Card>
    </div>
    <Card title="Activity logs" description="Bounded server history; search, severity filter and export.">
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-[13rem] flex-1 items-center gap-2"><Search size={16} /><span className="sr-only">Search logs</span><input className="field-input" placeholder="Search logs" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <label><span className="sr-only">Log level</span><select className="field-input" value={level} onChange={e => setLevel(e.target.value)}>
          <option value="all">All levels</option>{['info','warning','error','debug'].map(item => <option key={item} value={item}>{item}</option>)}
        </select></label>
        <label className="flex items-center gap-2 rounded-lg px-2 text-xs font-medium">
          <input type="checkbox" checked={!follow} onChange={e=>setFollow(!e.target.checked)}/> Pause auto refresh
        </label>
        <IconAction label="Refresh simulator logs" onClick={()=>{ void logs.refetch(); }}><RefreshCw size={16}/></IconAction>
        <IconAction label="Download simulator logs JSON" disabled={!listed.length}
          onClick={() => saveLocalFile(JSON.stringify(listed, null, 2), 'trishul-simulator-logs.json')}>
          <Download size={16}/>
        </IconAction>
        <IconAction danger label="Clear simulator logs" onClick={()=>setConfirmClear(true)}><Trash2 size={16}/></IconAction>
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

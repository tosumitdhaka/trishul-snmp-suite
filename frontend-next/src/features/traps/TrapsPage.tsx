import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, Download, Plus, RefreshCw, Search, Send, Trash2, X } from 'lucide-react';
import { Link } from 'react-router';
import { sendToBrowser, takeTrapHandoff } from '../../lib/navigation/handoff';
import { apiRequest } from '../../lib/api/client';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { Card, ConfirmDialog, Field, JsonView, ServiceToggle, StatusText, displayValue, jsonPost, positivePort, saveLocalFile, useOperatorApi } from '../shared/operator-ui';

type TrapOption = { name: string; full_name: string; oid: string; module?: string; objects?: { name: string; oid: string; input_type?: string }[] };
type Varbind = { oid: string; type: string; value: string };
type EventRow = { id?: number; trap_type?: string; source?: string; timestamp?: string; time?: string; varbinds?: unknown[]; community?: string; [key: string]: unknown };
type TrapHistory = { data: EventRow[]; total: number; count: number };
type TrapStatus = { running?: boolean; port?: number; community?: string; resolve_mibs?: boolean; uptime_seconds?: number };
const varTypes = ['String','Integer','Integer32','Counter32','Counter64','Gauge32','TimeTicks','ObjectIdentifier','IpAddress','OctetString'];
const historyKey = ['traps', 'history'];
export function TrapsPage() {
  const { token, pending, setNotice, invoke } = useOperatorApi();
  const ws = useRealtime();
  const [receiverPort, setReceiverPort] = useState('1162');
  const [receiverCommunity, setReceiverCommunity] = useState('public');
  const [resolveMibs, setResolveMibs] = useState(true);
  const [sendHost, setSendHost] = useState('127.0.0.1');
  const [sendPort, setSendPort] = useState('1162');
  const [sendCommunity, setSendCommunity] = useState('public');
  const [trapOid, setTrapOid] = useState('');
  const [varbinds, setVarbinds] = useState<Varbind[]>([]);
  const [selectedMode, setSelectedMode] = useState<'trap'|'inform'>('trap');
  const [search, setSearch] = useState('');
  const [picker, setPicker] = useState('');
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pausedRows, setPausedRows] = useState<EventRow[] | null>(null);
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | 'replay' | null>(null);
  const [decodeInput, setDecodeInput] = useState('');
  const [encoding, setEncoding] = useState<'hex'|'base64'>('hex');
  const [decoded, setDecoded] = useState<unknown>(null);
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const [pendingDefinition, setPendingDefinition] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['traps', 'status'], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<TrapStatus>('/api/traps/status', token, { signal }),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    queryKey: [...historyKey, offset], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<TrapHistory>('/api/traps/?limit=50&offset=' + offset, token, { signal }),
    refetchInterval: !paused && ws !== 'live' ? 7_000 : !paused ? 15_000 : false,
  });
  const options = useQuery({
    queryKey: ['traps', 'catalog'], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<{ traps: TrapOption[] }>('/api/mibs/traps', token, { signal }),
    staleTime: 60_000,
  });
  const pickerOptions = useQuery({
    queryKey: ['traps', 'picker', picker], enabled: !!token && picker.trim().length >= 2,
    queryFn: ({ signal }) => apiRequest<{ objects: { name: string; full_name?: string; oid: string; input_type?: string }[] }>(
      '/api/mibs/objects?' + new URLSearchParams({ search: picker, limit: '40' }), token, { signal }),
    staleTime: 10_000,
  });
  useEffect(() => {
    if (status.data) {
      setReceiverPort(String(status.data.port ?? 1162));
      setReceiverCommunity(status.data.community || 'public');
      setResolveMibs(!!status.data.resolve_mibs);
    }
  }, [status.data]);
  useEffect(() => {
    const handoff = takeTrapHandoff();
    if (handoff) {
      setTrapOid(handoff.oid);
      if (handoff.objects?.length) {
        setVarbinds(handoff.objects.map(object => ({ oid: object.oid,
          type: object.input_type || 'String', value: '' })));
      } else setPendingDefinition(handoff.oid);
      return;
    }
    // Older UI navigation keys remain readable during the incremental migration.
    try {
      const definition = sessionStorage.getItem('selectedTrap');
      const oid = sessionStorage.getItem('trapOid');
      sessionStorage.removeItem('selectedTrap');
      sessionStorage.removeItem('trapOid');
      if (definition) {
        const trap = JSON.parse(definition) as TrapOption;
        if (trap?.oid) {
          setTrapOid(trap.oid);
          if (trap.objects?.length) setVarbinds(trap.objects.map(object => ({
            oid: object.oid, type: object.input_type || 'String', value: '',
          })));
          else setPendingDefinition(trap.oid);
        }
      } else if (oid) { setTrapOid(oid); setPendingDefinition(oid); }
    } catch { /* Navigation must work even if storage is disabled. */ }
  }, []);
  useEffect(() => {
    if (!pendingDefinition || !options.data?.traps) return;
    const match = options.data.traps.find(trap => trap.oid === pendingDefinition ||
      trap.full_name === pendingDefinition);
    if (match?.objects?.length) setVarbinds(match.objects.map(object => ({
      oid: object.oid, type: object.input_type || 'String', value: '',
    })));
    setPendingDefinition(null);
  }, [options.data, pendingDefinition]);
  const filtered = useMemo(() => (paused && pausedRows ? pausedRows :
    Array.isArray(history.data?.data) ? history.data.data : []).filter(row =>
    JSON.stringify({ ...row, community: undefined }).toLowerCase().includes(search.toLowerCase())), [history.data, search, paused, pausedRows]);
  function toggleHistoryPause() {
    if (!paused) setPausedRows(Array.isArray(history.data?.data) ? [...history.data.data] : []);
    else { setPausedRows(null); void history.refetch(); }
    setPaused(!paused);
  }
  function selectTrap(option: TrapOption) {
    setTrapOid(option.oid); setPendingDefinition(null);
    setVarbinds((option.objects || []).filter(x => x.oid).map(x => ({ oid: x.oid, type: x.input_type || 'String', value: '' })));
  }
  function changeVarbind(index: number, patch: Partial<Varbind>) {
    setVarbinds(old => old.map((row,i) => i === index ? { ...row, ...patch } : row));
  }
  async function listener(action: 'start'|'stop') {
    const port = positivePort(receiverPort);
    if (action === 'start' && (!port || !receiverCommunity.trim())) { setNotice({ tone: 'error', text: 'Enter a valid listener port and community.' }); return; }
    await invoke('/api/traps/' + action, action === 'start' ? jsonPost({ port, community: receiverCommunity, resolve_mibs: resolveMibs }) : { method: 'POST' }, [['traps','status'], ['stats']]);
  }
  async function send() {
    const port = positivePort(sendPort);
    if (!sendHost.trim() || !port || !sendCommunity.trim() || !trapOid.trim() || varbinds.some(v => !v.oid.trim() || !v.type.trim())) {
      setNotice({ tone: 'error', text: 'Provide a target, port, community, notification OID and valid varbind entries.' }); return;
    }
    const response = await invoke('/api/traps/' + (selectedMode === 'inform' ? 'send-inform' : 'send'),
      jsonPost({ target: sendHost.trim(), port, community: sendCommunity, oid: trapOid.trim(),
        varbinds: varbinds.map(row => ({ oid: row.oid, type: row.type, value: row.value })) }), [['stats'], historyKey]);
    if (response) {
      setOperationResult(response);
      const detail = response as { response?: { error_status_code?: number; error_status?: string } };
      if (selectedMode === 'inform' && detail.response?.error_status_code &&
          detail.response.error_status_code !== 0) {
        setNotice({ tone: 'error', text: 'Inform response reported ' +
          (detail.response.error_status || 'error status ' + detail.response.error_status_code) });
      }
    }
  }
  async function confirmOperation() {
    if (confirm === 'clear') await invoke('/api/traps/', { method: 'DELETE' }, [historyKey, ['stats']]);
    if (confirm === 'delete' && typeof selected?.id === 'number') await invoke('/api/traps/' + selected.id, { method: 'DELETE' }, [historyKey, ['stats']]);
    if (confirm === 'replay' && typeof selected?.id === 'number') {
      if (!sendHost.trim() || !positivePort(sendPort) || !sendCommunity.trim()) {
        setNotice({ tone: 'error', text: 'Enter a valid replay destination and community in the sender panel.' }); setConfirm(null); return;
      }
      const result = await invoke('/api/traps/replay/' + selected.id,
        jsonPost({ host: sendHost.trim(), port: positivePort(sendPort), community: sendCommunity }), [['stats'], historyKey]);
      if (result) setOperationResult(result);
    }
    setConfirm(null);
  }
  function downloadCsv() {
    const entries = filtered;
    const cols = ['id','timestamp','source','trap_type','varbinds'];
    const cell = (value: unknown) => '"' + displayValue(value).replace(/"/g, '""') + '"';
    const csv = [cols.join(','), ...entries.map(row => cols.map(key => cell(row[key])).join(','))].join('\r\n');
    saveLocalFile(csv, 'trishul-received-traps.csv', 'text/csv');
  }
  return <div className="workspace-page">
    <header><p className="eyebrow">Operations / Notifications</p><h1 className="mt-1 text-2xl font-semibold">Traps &amp; informs</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Send notifications, control the receiver and inspect server-backed received events.</p></header>
    <div className="workspace-grid workspace-grid--two">
      <Card title="Notification sender" description="Send a trap or acknowledged inform to a reachable destination.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Target host"><input className="field-input" value={sendHost} onChange={e => setSendHost(e.target.value)} /></Field>
          <Field label="UDP port"><input className="field-input" type="number" min={1} max={65535} value={sendPort} onChange={e => setSendPort(e.target.value)} /></Field>
          <Field label="Community"><input className="field-input" type="password" autoComplete="off" value={sendCommunity} onChange={e => setSendCommunity(e.target.value)} /></Field>
          <Field label="Notification type"><select className="field-input" value={selectedMode} onChange={e => setSelectedMode(e.target.value as 'trap'|'inform')}>
            <option value="trap">SNMP Trap</option><option value="inform">SNMP Inform (wait for acknowledgment)</option></select></Field>
          <Field label="Notification OID"><input className="field-input font-mono text-xs" value={trapOid} onChange={e => setTrapOid(e.target.value)} /></Field>
          <Field label="Catalog definition"><select className="field-input" value="" onChange={e => { const item=options.data?.traps.find(t=>t.oid === e.target.value); if(item)selectTrap(item); }}>
            <option value="">Choose predefined notification…</option>
            {options.data?.traps.map(o => <option key={o.full_name + o.oid} value={o.oid}>{o.full_name}</option>)}</select></Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusText busy={options.isPending} error={options.error} />
          <Link className="btn-secondary" to="/browser" onClick={() => sendToBrowser({
            query: trapOid || 'linkDown', type: 'NotificationType',
          })}>
            <Bell size={16}/> Browse notification in MIBs
          </Link>
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Varbinds ({varbinds.length})</h3>
            <button className="btn-secondary" onClick={() => setVarbinds(old => [...old, { oid: '', type: 'String', value: '' }])}><Plus size={15} /> Add</button></div>
          {varbinds.map((row,i) => <div key={i} className="grid gap-2 rounded-lg bg-[var(--surface-muted)] p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
            <label className="text-xs">OID<input aria-label={'Varbind ' + (i+1) + ' OID'} className="field-input font-mono text-xs" value={row.oid} onChange={e => changeVarbind(i,{oid:e.target.value})} /></label>
            <label className="text-xs">Type<select aria-label={'Varbind '+(i+1)+' type'} className="field-input" value={row.type} onChange={e => changeVarbind(i,{type:e.target.value})}>
              {!varTypes.includes(row.type) && <option value={row.type}>{row.type}</option>}
              {varTypes.map(t=><option key={t}>{t}</option>)}</select></label>
            <label className="text-xs">Value<input aria-label={'Varbind '+(i+1)+' value'} className="field-input" value={row.value} onChange={e => changeVarbind(i,{value:e.target.value})}/></label>
            <button className="btn-secondary mt-4 px-2" aria-label={'Remove varbind '+(i+1)} onClick={() => setVarbinds(old => old.filter((_,j)=>i!==j))}><X size={16} /></button>
          </div>)}
          <label className="block text-xs"><span>Find varbind OID (server-ranked, max 40)</span>
            <input className="field-input mt-1" value={picker} placeholder="Search objects" onChange={e => setPicker(e.target.value)} /></label>
          {picker.trim().length >= 2 && <div className="max-h-36 overflow-auto rounded-lg border border-[var(--border)]">
            {pickerOptions.data?.objects.map(o=><button key={o.oid} className="block w-full break-all border-b border-[var(--border)] p-2 text-left text-xs hover:bg-[var(--surface-muted)]"
              onClick={() => { setVarbinds(old => [...old,{oid:o.oid,type:o.input_type || 'String',value:''}]); setPicker(''); }}>{o.full_name || o.name} · {o.oid}</button>)}
            <StatusText busy={pickerOptions.isPending} error={pickerOptions.error} empty={!pickerOptions.isPending && !pickerOptions.data?.objects.length} /></div>}
        </div>
        <button disabled={pending} className="btn-primary" onClick={() => void send()}><Send size={16} /> Send {selectedMode}</button>
        {operationResult != null && <details><summary className="cursor-pointer text-sm">Last transmission / replay response</summary><JsonView data={operationResult} /></details>}
      </Card>
      <Card title="Trap receiver" description="Receiver and source community settings are applied to the running backend."
        trailing={<span role="status" className={'service-status ' + (status.data?.running ? 'service-status-receiver' : 'service-status-off')}>{status.isPending ? 'Checking…' : status.isError ? 'Unavailable' : status.data?.running ? 'Running' : 'Stopped'}</span>}>
        <StatusText busy={status.isPending} error={status.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Listener UDP port"><input className="field-input" type="number" min={1} max={65535} value={receiverPort}
            disabled={!!status.data?.running || pending} onChange={e=>setReceiverPort(e.target.value)} /></Field>
          <Field label="Listener community"><input className="field-input" type="password" autoComplete="off" value={receiverCommunity}
            disabled={!!status.data?.running || pending} onChange={e=>setReceiverCommunity(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={resolveMibs} onChange={e=>setResolveMibs(e.target.checked)} /> Resolve MIB names in received events</label>
        <p className="text-xs text-[var(--muted)]">Uptime: {status.data?.uptime_seconds == null ? '—' : status.data.uptime_seconds + 's'} · Live feed: {ws}</p>
        <div className="flex flex-wrap gap-2">
          <ServiceToggle noun="receiver" running={!!status.data?.running} busy={pending}
            disabled={status.isError || status.isPending || !status.data}
            onToggle={() => void listener(status.data?.running ? 'stop' : 'start')} />
          <button className="btn-secondary" disabled={pending || status.isPending || status.isError}
            onClick={() => void invoke('/api/traps/resolve-mibs', jsonPost({resolve_mibs:resolveMibs}), [['traps','status']])}>Apply MIB resolution</button>
          <button className="btn-secondary" onClick={() => void status.refetch()}><RefreshCw size={16}/> Refresh</button>
        </div>
        <div className="border-t border-[var(--border)] pt-4">
          <h3 className="mb-2 font-semibold">Offline PDU decode</h3>
          <Field label="Payload (hex or base64)"><textarea className="field-input h-24 font-mono text-xs" value={decodeInput} onChange={e=>setDecodeInput(e.target.value)} /></Field>
          <div className="mt-3 flex flex-wrap gap-2"><label><span className="sr-only">Payload encoding</span><select className="field-input" value={encoding} onChange={e=>setEncoding(e.target.value as 'hex'|'base64')}><option value="hex">Hex</option><option value="base64">Base64</option></select></label>
            <button className="btn-secondary" disabled={pending || !decodeInput.trim()} onClick={() => void invoke('/api/traps/decode', jsonPost({payload:decodeInput.trim(),encoding})).then(x=>{if(x)setDecoded(x);})}>Decode</button></div>
          {decoded != null && <JsonView data={decoded} />}
        </div>
      </Card>
    </div>
    <Card title="Received trap history" description="Server-paginated; local search filters the current page only. The community is masked.">
      <div className="flex flex-wrap gap-2">
        <label className="min-w-44 flex-1"><span className="sr-only">Filter current page</span><span className="flex items-center gap-2"><Search size={16}/>
          <input className="field-input" placeholder="Filter current page" value={search} onChange={e=>setSearch(e.target.value)}/></span></label>
        <button className="btn-secondary" onClick={toggleHistoryPause}>{paused?'Resume':'Pause'} live updates</button>
        <button className="btn-secondary" onClick={() => void history.refetch()}><RefreshCw size={16}/> Refresh</button>
        <button className="btn-secondary" onClick={downloadCsv} disabled={!filtered.length}><Download size={16}/> Export current page CSV</button>
        <button className="btn-secondary text-[var(--danger)]" disabled={pending || !history.data?.total} onClick={()=>setConfirm('clear')}><Trash2 size={16}/> Clear all</button>
      </div>
      <StatusText busy={history.isPending} error={history.error} empty={!history.isPending && !filtered.length} />
      <div className="max-h-[30rem] overflow-auto"><table className="min-w-full text-left text-xs"><thead><tr className="border-b border-[var(--border)]">
        {['Time','Source','Notification','Actions'].map(x=><th className="p-3" key={x}>{x}</th>)}</tr></thead><tbody>
        {filtered.map((row,i)=><tr key={row.id ?? i} className="border-b border-[var(--border)]">
          <td className="whitespace-nowrap p-3">{displayValue(row.timestamp || row.time)}</td>
          <td className="p-3">{displayValue(row.source)}</td><td className="max-w-64 break-all p-3">{displayValue(row.trap_type)}</td>
          <td className="whitespace-nowrap p-2"><button className="btn-secondary" onClick={()=>setSelected(row)}>Inspect</button></td>
        </tr>)}</tbody></table></div>
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]"><span>{history.data ? offset+1 + '–' + (offset+filtered.length) + ' of ' + history.data.total : 'No history loaded'}</span>
        <div className="flex gap-2"><button className="btn-secondary" disabled={offset===0} onClick={()=>setOffset(x=>Math.max(0,x-50))}>Previous</button>
          <button className="btn-secondary" disabled={!history.data || offset+50>=history.data.total} onClick={()=>setOffset(x=>x+50)}>Next</button></div></div>
      {selected && <div className="space-y-3 rounded-xl border border-[var(--border)] p-4"><div className="flex justify-between gap-3">
        <h3 className="text-sm font-semibold">Selected event #{selected.id ?? '—'}</h3><button className="btn-secondary p-2" aria-label="Close selected event" onClick={()=>setSelected(null)}><X size={16}/></button></div>
        <JsonView data={{...selected,community: selected.community ? '********' : undefined}} />
        <div className="flex flex-wrap gap-2"><button className="btn-secondary" disabled={!selected.id} onClick={()=>setConfirm('replay')}><Send size={16}/> Replay to sender target</button>
          <button className="btn-secondary text-[var(--danger)]" disabled={!selected.id} onClick={()=>setConfirm('delete')}><Trash2 size={16}/> Delete event</button>
          <Link className="btn-secondary" to="/browser" onClick={() => sendToBrowser({
            query: String(selected.trap_type || ''), type: 'NotificationType',
          })}><Bell size={16}/> Inspect MIB</Link></div></div>}
    </Card>
    <ConfirmDialog danger open={confirm!==null} busy={pending} onCancel={()=>setConfirm(null)} onConfirm={()=>void confirmOperation()}
      title={confirm==='clear'?'Delete all received traps?':confirm==='delete'?'Delete this received trap?':'Replay the stored trap?'}
      message={confirm==='clear'?'This permanently clears received trap history. Export first if needed.':
        confirm==='delete'?'This event will be permanently deleted.':
        'This sends a real notification using the sender destination, port and community above. Verify the target before continuing.'}/>
  </div>;
}

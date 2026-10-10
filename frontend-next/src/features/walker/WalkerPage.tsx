import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Download, Play, Search, Square, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { apiRequest } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthProvider';
import { Banner, Card, Field, JsonView, SaveDataButton, displayValue, positivePort, saveLocalFile, type Notice } from '../shared/operator-ui';

interface WalkResponse { mode: string; count: number; data: unknown; rawLines?: string[]; json_format?: string }
interface WalkRecord { target: string; oid: string; port: number; count: number; at: string; result: WalkResponse }
const HISTORY_KEY = 'trishul_next_walk_history';
function readHistory(): WalkRecord[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(value) ? value.slice(0, 12) as WalkRecord[] : []; }
  catch { return []; }
}
function walkRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.slice(0, 2000).map((row) => row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : { value: row });
  if (data && typeof data === 'object') return Object.entries(data).slice(0, 2000).map(([oid, value]) => value && typeof value === 'object' && !Array.isArray(value) ? { oid, ...value as Record<string, unknown> } : { oid, value });
  return [];
}
export function WalkerPage() {
  const { auth } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const [target, setTarget] = useState('127.0.0.1');
  const [port, setPort] = useState('1061');
  const [community, setCommunity] = useState('public');
  const [oid, setOid] = useState('1.3.6.1.2.1');
  const [timeout, setTimeoutValue] = useState('2000');
  const [retries, setRetries] = useState('1');
  const [parse, setParse] = useState(true);
  const [useMibs, setUseMibs] = useState(true);
  const [layout, setLayout] = useState('flat');
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [result, setResult] = useState<WalkResponse | null>(null);
  const [history, setHistory] = useState(readHistory);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'table' | 'raw' | 'parsed'>('table');
  const [sort, setSort] = useState<{ field: string; reverse: boolean } | null>(null);
  useEffect(() => {
    try {
      const selected = sessionStorage.getItem('walkerOid');
      if (selected) { setOid(selected); sessionStorage.removeItem('walkerOid'); }
    } catch { /* Cross-workspace handoff is optional. */ }
    return () => controller.current?.abort();
  }, []);
  const rows = useMemo(() => walkRows(result?.data), [result]);
  const filtered = useMemo(() => {
    const subset = rows.filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
    if (sort) subset.sort((a,b) => displayValue(a[sort.field]).localeCompare(displayValue(b[sort.field]), undefined, { numeric: true }) * (sort.reverse ? -1 : 1));
    return subset;
  }, [rows, search, sort]);
  const columns = useMemo(() => [...new Set(rows.slice(0, 100).flatMap(row => Object.keys(row)))].slice(0, 12), [rows]);
  function persist(next: WalkRecord[]) {
    setHistory(next);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next.map(item => ({ ...item, result: item.result })))); }
    catch { setNotice({ tone: 'error', text: 'Walk succeeded but local history could not be saved.' }); }
  }
  async function run(event: FormEvent) {
    event.preventDefault();
    const portNumber = positivePort(port), ms = Number(timeout), retryCount = Number(retries);
    if (!target.trim() || !oid.trim() || !community.trim() || !portNumber ||
      !Number.isInteger(ms) || ms < 500 || ms > 10000 || !Number.isInteger(retryCount) || retryCount < 0 || retryCount > 5) {
      setNotice({ tone: 'error', text: 'Check target, OID, community, UDP port, timeout (500–10000 ms), and retries (0–5).' }); return;
    }
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setNotice(null); setResult(null);
    try {
      const next = await apiRequest<WalkResponse>('/api/walk/execute', token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ target: target.trim(), port: portNumber, community, oid: oid.trim(), parse, use_mibs: useMibs, json_format: layout, timeout_ms: ms, retries: retryCount }),
      });
      if (abort.signal.aborted) return;
      setResult(next); setSearch(''); setSort(null); setView('table');
      const record: WalkRecord = { target: target.trim(), oid: oid.trim(), port: portNumber, count: next.count, at: new Date().toISOString(), result: next };
      persist([record, ...history.filter(item => item.target !== record.target || item.oid !== record.oid)].slice(0, 12));
      setNotice({ tone: 'success', text: 'Walk completed: ' + next.count + ' OIDs returned.' });
    } catch (err) {
      if (abort.signal.aborted) setNotice({ tone: 'success', text: 'Walk cancelled locally. The backend may still finish processing the request.' });
      else setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Walk request failed.' });
    } finally { if (controller.current === abort) { controller.current = null; setLoading(false); } }
  }
  function exportTable() {
    if (!filtered.length) return;
    const keys = columns;
    const tsv = [keys.join('\t'), ...filtered.map(row => keys.map(key => displayValue(row[key]).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'))].join('\n');
    saveLocalFile(tsv, 'trishul-walk.tsv', 'text/tab-separated-values');
  }
  return <div className="workspace-page">
    <header><p className="eyebrow">Operations / Walk &amp; Parse</p><h1 className="mt-1 text-2xl font-semibold">SNMP walk explorer</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Execute a walk against a reachable SNMP target, then inspect or export its values.</p></header>
    <Banner notice={notice} />
    <Card title="Walk configuration" description="Requests are sent through the existing FastAPI /api/walk/execute endpoint.">
      <form onSubmit={(e) => { void run(e); }} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Target address"><input className="field-input" required value={target} onChange={e => setTarget(e.target.value)} /></Field>
          <Field label="UDP port"><input className="field-input" type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} /></Field>
          <Field label="Community"><input className="field-input" type="password" autoComplete="off" required value={community} onChange={e => setCommunity(e.target.value)} /></Field>
          <Field label="Root OID"><input className="field-input font-mono text-xs" required value={oid} onChange={e => setOid(e.target.value)} /></Field>
          <Field label="Timeout (ms)"><input className="field-input" type="number" min="500" max="10000" value={timeout} onChange={e => setTimeoutValue(e.target.value)} /></Field>
          <Field label="Retries"><input className="field-input" type="number" min="0" max="5" value={retries} onChange={e => setRetries(e.target.value)} /></Field>
          <Field label="JSON layout"><select className="field-input" value={layout} onChange={e => setLayout(e.target.value)}><option value="flat">Flat</option><option value="nested">Nested</option></select></Field>
          <div className="flex flex-col justify-center gap-3 pt-3 text-sm">
            <label><input type="checkbox" className="mr-2 accent-[var(--accent)]" checked={parse} onChange={e => setParse(e.target.checked)} /> Parse results</label>
            <label><input type="checkbox" className="mr-2 accent-[var(--accent)]" checked={useMibs} onChange={e => setUseMibs(e.target.checked)} /> Resolve using MIBs</label>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={loading}><Play size={16} /> {loading ? 'Walking…' : 'Execute walk'}</button>
          {loading && <button type="button" className="btn-secondary" onClick={() => controller.current?.abort()}><Square size={16} /> Cancel</button>}
          <Link className="btn-secondary" to="/browser">Browse MIBs <ArrowRight size={16} /></Link>
        </div>
        {loading && <p role="status" className="text-sm text-[var(--muted)]">Walk in progress; no intermediate progress is reported by the backend.</p>}
      </form>
    </Card>
    <div className="workspace-grid workspace-grid--split">
      <Card title="Walk results" description={result ? result.count + ' OIDs · ' + result.mode : 'No walk executed'}>
        {result ? <>
          <div className="flex flex-wrap gap-2">
            <label className="min-w-44 flex-1"><span className="sr-only">Filter results</span><span className="flex items-center gap-2"><Search size={16} /><input className="field-input" placeholder="Filter OIDs and values" value={search} onChange={e => setSearch(e.target.value)} /></span></label>
            {(['table','parsed','raw'] as const).map(mode => <button type="button" key={mode} className={view === mode ? 'btn-primary' : 'btn-secondary'} onClick={() => setView(mode)}>{mode}</button>)}
            <SaveDataButton value={result.data} filename="trishul-walk.json" />
            <button className="btn-secondary" type="button" disabled={!filtered.length} onClick={exportTable}><Download size={16} /> TSV</button>
          </div>
          {view !== 'table' ? <JsonView data={view === 'raw' ? result.rawLines ?? result.data : result.data} /> :
            filtered.length ? <div className="max-h-[38rem] overflow-auto"><table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 bg-[var(--surface-muted)]"><tr>{columns.map(key => <th key={key} className="p-3">
                <button className="font-semibold" onClick={() => setSort(old => ({ field: key, reverse: old?.field === key ? !old.reverse : false }))}>{key} ↕</button></th>)}</tr></thead>
              <tbody>{filtered.map((row,i) => <tr className="border-t border-[var(--border)]" key={i}>
                {columns.map(key => <td key={key} className="max-w-96 break-all p-3 font-mono">{displayValue(row[key])}</td>)}</tr>)}</tbody>
            </table></div> : <p className="text-sm text-[var(--muted)]">No result rows match the filter, or the returned result cannot be tabulated. Use the Parsed/Raw view.</p>}
        </> : <p className="text-sm text-[var(--muted)]">Execute a walk or open an earlier result from history.</p>}
      </Card>
      <Card title="Recent walks" description="Saved in this browser only; never stores SNMP communities.">
        {history.length === 0 && <p className="text-sm text-[var(--muted)]">No recent walks.</p>}
        <div className="space-y-2">{history.map((record,i) => <button type="button" key={i}
          className="block w-full rounded-lg border border-[var(--border)] p-3 text-left text-sm hover:bg-[var(--surface-muted)]"
          onClick={() => { setTarget(record.target); setOid(record.oid); setPort(String(record.port)); setResult(record.result); }}>
          <strong className="block">{record.target}</strong><span className="block break-all font-mono text-xs">{record.oid}</span>
          <span className="block text-xs text-[var(--muted)]">{record.count} OIDs · {new Date(record.at).toLocaleString()}</span>
        </button>)}</div>
        {history.length > 0 && <button className="btn-secondary" onClick={() => persist([])}><Trash2 size={16} /> Clear local history</button>}
      </Card>
    </div>
  </div>;
}

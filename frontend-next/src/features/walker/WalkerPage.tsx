import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Download, Play, Search, Square, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { sendToBrowser, takeWalkerHandoff } from '../../lib/navigation/handoff';
import { apiRequest } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useNotifications } from '../../lib/notifications/NotificationProvider';
import { Card, Field, JsonView, SaveDataButton, displayValue, positivePort, saveLocalFile, type Notice } from '../shared/operator-ui';
import { purgeLegacyWalkHistory, walkColumns, walkRows, walkTsv } from './walk-table';

interface WalkResponse { mode: string; count: number; data: unknown; rawLines?: string[]; json_format?: string }
interface WalkRecord { target: string; oid: string; port: number; count: number; at: string }
const PAGE_SIZE = 100;
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
  const [layout, setLayout] = useState('grouped');
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const { notify } = useNotifications();
  function setNotice(next: Notice) {
    if (!next) return;
    notify({ tone: next.tone, title: next.tone === 'error' ? 'Walk action failed' : 'Walk action completed', message: next.text });
  }
  const [result, setResult] = useState<WalkResponse | null>(null);
  const [history, setHistory] = useState<WalkRecord[]>(() => { purgeLegacyWalkHistory(); return []; });
  const [page, setPage] = useState(0);
  useEffect(() => {
    // Auth expiry, logout, and account replacement must drop every in-memory result.
    setHistory([]);
    setResult(null);
  }, [token]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'table' | 'raw' | 'parsed'>('raw');
  const [sort, setSort] = useState<{ field: string; reverse: boolean } | null>(null);
  useEffect(() => {
    try {
      const handoff = takeWalkerHandoff();
      if (handoff?.oid) setOid(handoff.oid);
      if (handoff?.target) setTarget(handoff.target);
      if (handoff?.port) setPort(String(handoff.port));
      // Accept legacy same-tab navigation hints during migration.
      const selected = sessionStorage.getItem('walkerOid');
      if (selected && !handoff?.oid) setOid(selected);
      sessionStorage.removeItem('walkerOid');
    } catch { /* Cross-workspace handoff is optional. */ }
    return () => controller.current?.abort();
  }, []);
  const rows = useMemo(() => walkRows(result?.data), [result]);
  const filtered = useMemo(() => {
    const subset = rows.filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
    if (sort) subset.sort((a,b) => displayValue(a[sort.field]).localeCompare(displayValue(b[sort.field]), undefined, { numeric: true }) * (sort.reverse ? -1 : 1));
    return subset;
  }, [rows, search, sort]);
  const preview = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page]);
  const groups = useMemo(() => {
    const byCategory = new Map<string, Record<string, unknown>[]>();
    for (const item of preview) {
      const category = String(item.metric_category || item.mib_module || item.module || 'Other objects');
      const items = byCategory.get(category) || [];
      items.push(item);
      byCategory.set(category, items);
    }
    return [...byCategory.entries()];
  }, [preview]);
  const columns = useMemo(() => walkColumns(rows), [rows]);
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
        body: JSON.stringify({ target: target.trim(), port: portNumber, community, oid: oid.trim(), parse, use_mibs: layout === 'grouped' && parse ? true : useMibs, json_format: layout, timeout_ms: ms, retries: retryCount }),
      });
      if (abort.signal.aborted) return;
      setResult(next); setSearch(''); setSort(null); setView('raw');
      const record: WalkRecord = { target: target.trim(), oid: oid.trim(), port: portNumber, count: next.count, at: new Date().toISOString() };
      setPage(0);
      // Only configuration metadata is kept, and only until this workspace/auth session ends.
      setHistory(previous => [record, ...previous.filter(item => item.target !== record.target || item.oid !== record.oid)].slice(0, 12));
      setNotice({ tone: 'success', text: 'Walk completed: ' + next.count + ' OIDs returned.' });
    } catch (err) {
      if (abort.signal.aborted) setNotice({ tone: 'info', text: 'Client request stopped; the backend SNMP walk may still be running.' });
      else setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Walk request failed.' });
    } finally { if (controller.current === abort) { controller.current = null; setLoading(false); } }
  }
  function exportTable() {
    if (!filtered.length) return;
    const tsv = walkTsv(filtered, columns);
    saveLocalFile(tsv, 'trishul-walk-filtered.tsv', 'text/tab-separated-values');
  }
  return <div className="workspace-page">
    <header><p className="eyebrow">Operations / Walk &amp; Parse</p><h1 className="mt-1 text-2xl font-semibold">SNMP walk explorer</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Execute a walk against a reachable SNMP target, then inspect or export its values.</p></header>
    <Card title="Walk configuration" description="Requests are sent through the existing FastAPI /api/walk/execute endpoint.">
      <form onSubmit={(e) => { void run(e); }} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Target address"><input className="field-input" required value={target} onChange={e => setTarget(e.target.value)} /></Field>
          <Field label="UDP port"><input className="field-input" type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} /></Field>
          <Field label="Community"><input className="field-input" type="password" autoComplete="off" required value={community} onChange={e => setCommunity(e.target.value)} /></Field>
          <Field label="Root OID"><input className="field-input font-mono text-xs" required value={oid} onChange={e => setOid(e.target.value)} /></Field>
          <Field label="Timeout (ms)"><input className="field-input" type="number" min="500" max="10000" value={timeout} onChange={e => setTimeoutValue(e.target.value)} /></Field>
          <Field label="Retries"><input className="field-input" type="number" min="0" max="5" value={retries} onChange={e => setRetries(e.target.value)} /></Field>
          <Field label="JSON layout"><select className="field-input" disabled={!parse} value={layout} onChange={e => setLayout(e.target.value)}><option value="flat">Flat</option><option value="grouped">Grouped metrics (category / labels)</option></select></Field>
          <div className="flex flex-col justify-center gap-3 pt-3 text-sm">
            <label><input type="checkbox" className="mr-2 accent-[var(--accent)]" checked={parse} onChange={e => setParse(e.target.checked)} /> Parse results</label>
            <label><input type="checkbox" className="mr-2 accent-[var(--accent)]" checked={layout === 'grouped' && parse ? true : useMibs}
              disabled={layout === 'grouped' && parse} onChange={e=>setUseMibs(e.target.checked)}/> Resolve using MIBs</label>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={loading}><Play size={16} /> {loading ? 'Walking…' : 'Execute walk'}</button>
          {loading && <button type="button" className="btn-secondary" onClick={() => controller.current?.abort()}><Square size={16} /> Cancel</button>}
          <Link className="btn-secondary" to="/browser" onClick={() => sendToBrowser({ query: oid })}>
            Browse this OID <ArrowRight size={16} />
          </Link>
        </div>
        {loading && <p role="status" className="text-sm text-[var(--muted)]">Walk in progress; no intermediate progress is reported by the backend.</p>}
      </form>
    </Card>
    <div className="workspace-grid workspace-grid--split">
      <Card title="Walk results" description={result ? result.count + ' OIDs · ' + result.mode : 'No walk executed'}>
        {result ? <>
          <div className="flex flex-wrap gap-2">
            <label className="min-w-44 flex-1"><span className="sr-only">Filter results</span><span className="flex items-center gap-2"><Search size={16} /><input className="field-input" placeholder="Filter OIDs and values" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></span></label>
            {(['raw','table','parsed'] as const).map(mode => <button type="button" key={mode}
              aria-pressed={view===mode} className={view===mode?'btn-primary':'btn-secondary'} onClick={()=>setView(mode)}>
              {mode==='table'?'Grouped table':mode==='parsed'?'Parsed JSON':'Raw'}
            </button>)}
            <SaveDataButton value={result.data} filename="trishul-walk.json" />
            <button className="btn-secondary" type="button" disabled={!filtered.length} onClick={exportTable}><Download size={16} /> Export all {filtered.length} filtered rows (TSV)</button>
          </div>
          {view === 'raw' ? <pre aria-label="Raw SNMP walk result" className="max-h-[38rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface-muted)] p-4 font-mono text-xs leading-relaxed">
              {result.rawLines?.length ? result.rawLines.join('\n') : Array.isArray(result.data) && result.mode === 'raw'
                ? result.data.join('\n') : JSON.stringify(result.data, null, 2)}
            </pre> : view === 'parsed' ? <JsonView data={result.data}/> :
            filtered.length ? <div className="max-h-[38rem] overflow-auto"><p className="p-2 text-xs text-[var(--muted)]">
              Showing {preview.length ? page * PAGE_SIZE + 1 : 0}–{page * PAGE_SIZE + preview.length} of {filtered.length} filtered rows ({rows.length} returned) · {columns.length} columns · grouped by MIB category/module
            </p>{groups.map(([category, items]) => <section key={category} aria-label={'Category: '+category}>
              <h3 className="sticky top-0 z-10 border-y border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-semibold">
                {category} <span className="ml-2 text-xs font-normal text-[var(--muted)]">{items.length} entries</span>
              </h3>
              <table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 bg-[var(--surface-muted)]"><tr>{columns.map(key => <th key={key} className="p-3">
                <button className="font-semibold" onClick={() => { setSort(old => ({ field: key, reverse: old?.field === key ? !old.reverse : false })); setPage(0); }}>{key} ↕</button></th>)}</tr></thead>
              <tbody>{items.map((row,i) => <tr className="border-t border-[var(--border)]" key={i}>
                {columns.map(key => <td key={key} className="max-w-96 break-all p-3 font-mono">
                  {key.toLowerCase() === 'oid' && typeof row[key] === 'string' && row[key] ?
                    <Link to="/browser" className="link" title={'Browse ' + row[key]}
                      onClick={() => sendToBrowser({ query: row[key] as string })}>{row[key] as string}</Link>
                    : displayValue(row[key])}
                </td>)}</tr>)}</tbody>
              </table></section>)}<nav aria-label="Walk result pages" className="flex items-center justify-between gap-3 p-3 text-sm">
              <span>Page {page + 1} of {Math.ceil(filtered.length / PAGE_SIZE)}</span>
              <span className="flex gap-2"><button type="button" className="btn-secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
              <button type="button" className="btn-secondary" disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(p => p + 1)}>Next</button></span>
            </nav></div> : <p className="text-sm text-[var(--muted)]">No result rows match the filter, or the returned result cannot be tabulated. Use the Parsed/Raw view.</p>}
        </> : <p className="text-sm text-[var(--muted)]">Execute a walk to view results. Recent configurations can refill the form, not restore past values.</p>}
      </Card>
      <Card title="Recent configurations" description="Memory-only for this login. No result values, communities or history survive reload or logout. Previous stored history is cleared.">
        {history.length === 0 && <p className="text-sm text-[var(--muted)]">No recent walks.</p>}
        <div className="space-y-2">{history.map((record,i) => <button type="button" key={i}
          className="block w-full rounded-lg border border-[var(--border)] p-3 text-left text-sm hover:bg-[var(--surface-muted)]"
          onClick={() => { setTarget(record.target); setOid(record.oid); setPort(String(record.port)); setResult(null); }}>
          <strong className="block">{record.target}</strong><span className="block break-all font-mono text-xs">{record.oid}</span>
          <span className="block text-xs text-[var(--muted)]">{record.count} OIDs · {new Date(record.at).toLocaleString()}</span>
        </button>)}</div>
        {history.length > 0 && <button className="btn-danger" onClick={() => setHistory([])}><Trash2 size={16}/> Clear recent configurations</button>}
      </Card>
    </div>
  </div>;
}

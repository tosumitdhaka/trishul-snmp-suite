import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ClipboardCopy, Search, ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { apiRequest } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthProvider';
import { Card, JsonView, StatusText, displayValue } from '../shared/operator-ui';

interface MibNode {
  oid: string; name?: string; full_name?: string; module?: string; type?: string;
  syntax?: string; access?: string; description?: string; status?: string;
  has_children?: boolean; units?: string; enums?: unknown; constraints?: unknown;
}
interface ModulesResponse { modules: { name: string; objects?: number; notifications?: number }[]; active_bundle_id?: number }
interface SearchResponse { results: MibNode[]; count: number }
interface TreeModule extends MibNode { children: MibNode[]; object_count?: number }
interface TreeResponse { modules: TreeModule[]; count: number }
interface ChildrenResponse { children: MibNode[]; total_descendants: number }
interface DetailResponse { node: MibNode | null; breadcrumb?: MibNode[]; trap_objects?: unknown[] }
function TreeItem({ node, module, onSelect, level = 0 }: { node: MibNode; module: string; onSelect: (item: MibNode) => void; level?: number }) {
  const { auth } = useAuth(); const token = auth.state === 'authenticated' ? auth.token : null;
  const [open, setOpen] = useState(false);
  const child = useQuery({
    queryKey: ['browser', 'children', module, node.oid],
    queryFn: ({ signal }) => apiRequest<ChildrenResponse>('/api/mibs/browse/tree/oid?' +
      new URLSearchParams({ root_oid: node.oid, depth: '1', module }).toString(), token, { signal }),
    enabled: !!token && open && !!node.oid,
  });
  return <li className="min-w-0">
    <div className="flex min-w-0 items-center gap-1 rounded-lg hover:bg-[var(--surface-muted)]" style={{ paddingLeft: Math.min(8 + level * 12, 120) }}>
      {node.has_children && level < 8 ? <button type="button" className="p-1.5" aria-label={(open ? 'Collapse ' : 'Expand ') + (node.name || node.oid)}
        aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> :
        <span aria-hidden="true" className="w-7" />}
      <button className="min-w-0 flex-1 truncate p-2 text-left text-xs" title={node.full_name || node.oid} onClick={() => onSelect(node)}>
        <span className="font-semibold">{node.name || node.oid}</span>
        <span className="ml-2 text-[var(--muted)]">{node.type || ''}</span>
      </button>
    </div>
    {open && <div className="pl-3">
      <StatusText busy={child.isPending} error={child.error} empty={!child.isPending && !child.data?.children.length} />
      <ul aria-label={'Children of ' + (node.name || node.oid)}>{child.data?.children.map((item, index) =>
        <TreeItem key={item.oid + ':' + index} node={item} module={module} level={level + 1} onSelect={onSelect} />)}</ul>
    </div>}
  </li>;
}
export function BrowserPage() {
  const { auth } = useAuth(); const token = auth.state === 'authenticated' ? auth.token : null;
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<MibNode | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQuery(filter.trim()), 250); return () => clearTimeout(t); }, [filter]);
  useEffect(() => {
    try {
      const previous = sessionStorage.getItem('browserSearchOid');
      if (previous) { setFilter(previous); sessionStorage.removeItem('browserSearchOid'); }
    } catch { /* optional handoff */ }
  }, []);
  const modules = useQuery({ queryKey: ['browser', 'modules'], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<ModulesResponse>('/api/mibs/browse/modules', token, { signal }), staleTime: 60_000 });
  const search = useQuery({
    queryKey: ['browser', 'search', query, moduleName, type],
    enabled: !!token && query.length > 0,
    queryFn: ({ signal }) => apiRequest<SearchResponse>('/api/mibs/browse/search?' +
      new URLSearchParams({ query, ...(moduleName ? { module: moduleName } : {}), ...(type ? { type_filter: type } : {}), limit: '100' }), token, { signal }),
    staleTime: 15_000,
  });
  const tree = useQuery({
    queryKey: ['browser', 'tree', moduleName, type],
    enabled: !!token && !query && !!moduleName,
    queryFn: ({ signal }) => apiRequest<TreeResponse>('/api/mibs/browse/tree?' +
      new URLSearchParams({ module: moduleName, ...(type ? { type_filter: type } : {}) }), token, { signal }),
  });
  const detail = useQuery({
    queryKey: ['browser', 'detail', selected?.oid, selected?.module],
    enabled: !!token && !!selected?.oid,
    queryFn: ({ signal }) => apiRequest<DetailResponse>('/api/mibs/browse/node/' +
      encodeURIComponent(selected!.oid) + '?' + new URLSearchParams({ module: selected!.module || moduleName }), token, { signal }),
  });
  const node = detail.data?.node || selected;
  function handoff(key: 'walkerOid' | 'trapOid') {
    if (!node?.oid) return;
    try { sessionStorage.setItem(key, node.oid); } catch { /* handoff not essential */ }
  }
  async function copyOid() {
    if (!node?.oid) return;
    try { await navigator.clipboard.writeText(node.oid); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <div className="workspace-page">
    <header><p className="eyebrow">MIB Workbench / Browser</p><h1 className="mt-1 text-2xl font-semibold">MIB explorer</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Ranked server-side search and lazily expanded OID hierarchy. No full catalog download.</p></header>
    <div className="workspace-grid workspace-grid--split">
      <Card title="Catalog search & tree" description="Search symbols, OIDs and descriptions; select a module to explore its hierarchy.">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2"><span className="field-label">Search</span><span className="flex items-center gap-2"><Search size={16} />
            <input className="field-input" value={filter} placeholder="IF-MIB::ifDescr or linkDown" onChange={e => setFilter(e.target.value)} /></span></label>
          <label><span className="field-label">Module</span><select className="field-input" value={moduleName} onChange={e => { setModuleName(e.target.value); setSelected(null); }}>
            <option value="">All modules (search only)</option>{modules.data?.modules.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}</select></label>
          <label><span className="field-label">Object type</span><select className="field-input" value={type} onChange={e => setType(e.target.value)}>
            <option value="">All types</option>{['Scalar','Table','TableRow','TableColumn','NotificationType','ObjectIdentifier','ModuleIdentity','ObjectGroup'].map(t => <option key={t}>{t}</option>)}</select></label>
        </div>
        <StatusText busy={modules.isPending} error={modules.error} />
        {query ? <>
          <p className="text-xs text-[var(--muted)]">Ranked search · max 100 results {search.data ? '· ' + search.data.count + ' matches' : ''}</p>
          <StatusText busy={search.isPending} error={search.error} empty={!search.isPending && !search.data?.results.length} />
          <ul className="max-h-[37rem] overflow-auto divide-y divide-[var(--border)]" aria-label="Search results">
            {search.data?.results.map((item, i) => <li key={item.oid + i}><button className="w-full rounded-lg p-3 text-left hover:bg-[var(--surface-muted)]" onClick={() => setSelected(item)}>
              <strong className="block break-all text-sm">{item.full_name || item.name}</strong>
              <span className="block break-all font-mono text-xs text-[var(--muted)]">{item.oid}</span></button></li>)}</ul>
        </> : moduleName ? <>
          <StatusText busy={tree.isPending} error={tree.error} empty={!tree.isPending && !tree.data?.modules.length} />
          <p className="text-xs text-[var(--muted)]">{tree.data?.count ?? '…'} nodes in selected view</p>
          <ul className="max-h-[38rem] space-y-1 overflow-auto" aria-label="OID hierarchy">
            {tree.data?.modules.flatMap(mod => mod.children.map((item,i) =>
              <TreeItem key={mod.name + item.oid + i} node={item} module={mod.name || mod.module || ''} onSelect={setSelected} />))}</ul>
        </> : <p className="text-sm text-[var(--muted)]">Select a module for a lazy tree or enter a search term to query all modules.</p>}
      </Card>
      <Card title="Object details" description="Selected OID, metadata, constraints and cross-workspace actions.">
        {!selected ? <p className="text-sm text-[var(--muted)]">Select an object or notification to inspect.</p> :
          <>
            <StatusText busy={detail.isPending} error={detail.error} />
            <h3 className="break-all text-base font-semibold">{node?.full_name || node?.name || 'Unknown'}</h3>
            <p className="break-all font-mono text-xs text-[var(--muted)]">{node?.oid}</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" disabled={!node?.oid} onClick={() => void copyOid()}><ClipboardCopy size={16} /> {copied ? 'Copied' : 'Copy OID'}</button>
              <Link className="btn-secondary" to="/walker" onClick={() => handoff('walkerOid')}>Walk <ArrowRight size={15} /></Link>
              <Link className="btn-secondary" to="/traps" onClick={() => handoff('trapOid')}>Use in trap <ArrowRight size={15} /></Link>
            </div>
            <dl className="space-y-2 text-xs">{([['Module',node?.module],['Type',node?.type],['Syntax',node?.syntax],['Access',node?.access],['Status',node?.status],['Units',node?.units],['Description',node?.description]] as const).map(([name,value]) => <div className="border-b border-[var(--border)] pb-2" key={name}>
              <dt className="font-semibold text-[var(--muted)]">{name}</dt><dd className="mt-1 break-words">{displayValue(value)}</dd></div>)}</dl>
            {node?.constraints != null && <><h4 className="text-sm font-semibold">Constraints</h4><JsonView data={node.constraints} /></>}
            {node?.enums != null && <><h4 className="text-sm font-semibold">Enums</h4><JsonView data={node.enums} /></>}
            {detail.data?.trap_objects && detail.data.trap_objects.length > 0 && <><h4 className="text-sm font-semibold">Notification objects</h4><JsonView data={detail.data.trap_objects} /></>}
            {detail.data?.breadcrumb && detail.data.breadcrumb.length > 0 && <p className="break-words text-xs text-[var(--muted)]">
              Path: {detail.data.breadcrumb.map(p => p.name || p.oid).join(' › ')}</p>}
          </>}
      </Card>
    </div>
  </div>;
}

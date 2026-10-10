import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen, ChevronDown, ChevronRight, ClipboardCopy, Download, FolderTree, ListTree,
  RefreshCw, Search, X, ArrowRight, AlertTriangle,
} from 'lucide-react';
import { Link } from 'react-router';
import { apiRequest } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useNotifications } from '../../lib/notifications/NotificationProvider';
import { Card, StatusText, displayValue, saveLocalFile } from '../shared/operator-ui';
import {
  BROWSER_STATE_KEY, BROWSER_ROOT_OID, BROWSER_TYPES, browserNodeKey, flatVisibleNodes,
  readBrowserState, type BrowserMode, type BrowserNode, type BrowserModule, type BrowserState,
} from './browser-model';

interface ModulesResponse { modules: { name: string; objects?: number; notifications?: number }[]; active_bundle_id?: number | null }
interface TreeResponse { modules: BrowserModule[]; count: number }
interface ChildrenResponse { root?: BrowserNode; children: BrowserNode[]; total_descendants: number }
interface SearchResponse { results: BrowserNode[]; count: number }
interface DetailResponse { node: BrowserNode | null; breadcrumb: BrowserNode[]; trap_objects: unknown[] }
interface BundleSummary { active_bundle_id?: number | null; recompile_recommended?: boolean; missing_capabilities?: string[]; producer_version?: string }

type SelectFn = (node: BrowserNode) => void;
type NodeViewProps = {
  node: BrowserNode;
  module: string;
  token: string | null;
  bundleId: number | null;
  selectedKey: string | null;
  expanded: Set<string>;
  toggle: (key: string) => void;
  onSelect: SelectFn;
  level: number;
  autoDepth: number;
  typeFilter: string;
  oidMode?: boolean;
};

function TreeNode({ node, module, token, bundleId, selectedKey, expanded, toggle, onSelect, level, autoDepth, typeFilter, oidMode = false }: NodeViewProps) {
  const moduleName = oidMode ? '' : node.module || module;
  const key = browserNodeKey(node.oid, moduleName);
  const opened = expanded.has(key) || (autoDepth > level && !!node.has_children);
  const children = useQuery({
    queryKey: ['browser', 'children', bundleId, node.oid, moduleName, typeFilter],
    enabled: !!token && opened && !!node.has_children,
    queryFn: ({ signal }) => apiRequest<ChildrenResponse>('/api/mibs/browse/tree/oid?' +
      new URLSearchParams({ root_oid: node.oid, depth: '1', ...(moduleName ? { module: moduleName } : {}),
        ...(typeFilter ? { type_filter: typeFilter } : {}) }), token, { signal }),
    staleTime: 60_000,
  });

  return <li className="min-w-0" role="treeitem" aria-level={level + 1} aria-selected={selectedKey === key}
    aria-expanded={node.has_children ? opened : undefined}>
    <div className={'browser-tree-row ' + (selectedKey === key ? 'browser-tree-row-selected' : '')}
      style={{ paddingLeft: Math.min(level * 15 + 4, 112) }}>
      {node.has_children
        ? <button type="button" className="browser-tree-toggle" aria-label={(opened ? 'Collapse ' : 'Expand ') + (node.name || node.oid)}
            aria-expanded={opened} onClick={() => toggle(key)}>
            {opened ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        : <span className="browser-tree-spacer" aria-hidden="true" />}
      <button type="button" className="min-w-0 flex-1 truncate py-2 text-left text-sm"
        title={node.full_name || node.oid} onClick={() => onSelect({ ...node, module: moduleName })}>
        <span className="font-medium">{node.name || node.oid}</span>
        {node.type && <span className="ml-2 text-xs text-[var(--muted)]">{node.type}</span>}
      </button>
      <code className="hidden max-w-28 shrink-0 truncate text-[0.67rem] text-[var(--muted)] sm:inline" title={node.oid}>
        {node.oid.split('.').slice(-2).join('.')}
      </code>
    </div>
    {opened && node.has_children && <div className="pl-1" role="group">
      <StatusText busy={children.isPending} error={children.error} empty={!children.isPending && !children.isError && !children.data?.children.length} />
      {children.data?.children && <ul role="group">
        {children.data.children.map((child, i) => <TreeNode key={browserNodeKey(child.oid, child.module || moduleName) + i}
          node={child} module={moduleName} token={token} bundleId={bundleId}
          selectedKey={selectedKey} expanded={expanded} toggle={toggle} onSelect={onSelect}
          level={level + 1} autoDepth={autoDepth} typeFilter={typeFilter} oidMode={oidMode}/>)}
      </ul>}
    </div>}
  </li>;
}

export function BrowserPage() {
  const { auth } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const { notify } = useNotifications();
  const cache = useQueryClient();
  const [initial] = useState(readBrowserState);
  const [mode, setMode] = useState<BrowserMode>(initial.mode);
  const [moduleName, setModuleName] = useState(initial.module);
  const [typeFilter, setTypeFilter] = useState(initial.typeFilter);
  const [filter, setFilter] = useState(initial.search);
  const [query, setQuery] = useState(initial.search.length >= 2 ? initial.search : '');
  const [rootOid, setRootOid] = useState(initial.rootOid);
  const [rootInput, setRootInput] = useState(initial.rootOid);
  const [selected, setSelected] = useState<BrowserNode | null>(initial.selected);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial.expanded.slice(0, 120)));
  const [autoDepth, setAutoDepth] = useState(0);
  const [depth, setDepth] = useState('3');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    try {
      const handoff = sessionStorage.getItem('browserSearchOid');
      const handoffType = sessionStorage.getItem('browserFilterType');
      if (handoff) {
        setMode('module'); setFilter(handoff); setQuery(handoff);
        if (handoffType && BROWSER_TYPES.some(item => item.value === handoffType)) setTypeFilter(handoffType);
        sessionStorage.removeItem('browserSearchOid');
        sessionStorage.removeItem('browserFilterType');
      }
    } catch { /* Storage restrictions must not block the browser. */ }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filter.trim().length >= 2 ? filter.trim() : ''), 300);
    return () => clearTimeout(timer);
  }, [filter]);
  useEffect(() => {
    const snapshot: BrowserState = { mode, module: moduleName, typeFilter, search: filter, rootOid,
      selected, expanded: [...expanded].slice(0, 120) };
    try { sessionStorage.setItem(BROWSER_STATE_KEY, JSON.stringify(snapshot)); }
    catch { /* Browsing works without persistence. */ }
  }, [mode, moduleName, typeFilter, filter, rootOid, selected, expanded]);

  const modules = useQuery({
    queryKey: ['browser', 'modules'], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<ModulesResponse>('/api/mibs/browse/modules', token, { signal }),
    refetchInterval: 30_000, staleTime: 30_000,
  });
  const bundleId = modules.data?.active_bundle_id ?? null;
  const [lastBundle, setLastBundle] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (bundleId == null) return;
    if (lastBundle !== undefined && lastBundle !== bundleId) {
      setExpanded(new Set()); setSelected(null); setAutoDepth(0);
      void cache.invalidateQueries({ queryKey: ['browser'] });
      notify({ tone: 'info', title: 'MIB catalog updated', message: 'Active bundle changed; refreshing the browser.' });
    }
    setLastBundle(bundleId);
  }, [bundleId, lastBundle, cache, notify]);

  const moduleTree = useQuery({
    queryKey: ['browser', 'tree', 'module', bundleId, moduleName, typeFilter], enabled: !!token && mode === 'module' && !query,
    queryFn: ({ signal }) => apiRequest<TreeResponse>('/api/mibs/browse/tree/module' +
      (moduleName || typeFilter ? '?' + new URLSearchParams({
        ...(moduleName ? { module: moduleName } : {}), ...(typeFilter ? { type_filter: typeFilter } : {}),
      }) : ''), token, { signal }),
    staleTime: 60_000,
  });
  const oidTree = useQuery({
    queryKey: ['browser', 'tree', 'oid', bundleId, rootOid], enabled: !!token && mode === 'oid',
    queryFn: ({ signal }) => apiRequest<ChildrenResponse>('/api/mibs/browse/tree/oid?' +
      new URLSearchParams({ root_oid: rootOid, depth: '1' }), token, { signal }),
    staleTime: 60_000,
  });
  const search = useQuery({
    queryKey: ['browser', 'search', bundleId, query, moduleName, typeFilter],
    enabled: !!token && mode === 'module' && query.length >= 2,
    queryFn: ({ signal }) => apiRequest<SearchResponse>('/api/mibs/browse/search?' +
      new URLSearchParams({ query, limit: '100', ...(moduleName ? { module: moduleName } : {}),
        ...(typeFilter ? { type_filter: typeFilter } : {}) }), token, { signal }),
    staleTime: 30_000,
  });
  const detail = useQuery({
    queryKey: ['browser', 'detail', bundleId, selected?.oid, selected?.module],
    enabled: !!token && !!selected?.oid,
    queryFn: ({ signal }) => apiRequest<DetailResponse>('/api/mibs/browse/node/' +
      encodeURIComponent(selected!.oid) + (selected!.module ? '?' + new URLSearchParams({ module: selected!.module }) : ''), token, { signal }),
    staleTime: 30_000,
  });
  const bundle = useQuery({
    queryKey: ['browser', 'bundle-summary', bundleId], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<BundleSummary>('/api/mibs/bundle-summary', token, { signal }),
    staleTime: 60_000,
  });

  const displayed = detail.data?.node ?? selected;
  const selectedKey = selected ? browserNodeKey(selected.oid, selected.module || '') : null;
  const isSearching = mode === 'module' && query.length >= 2;
  const count = mode === 'oid' ? oidTree.data?.total_descendants : isSearching ? search.data?.count : moduleTree.data?.count;
  const countLabel = mode === 'oid' ? 'Objects under OID root' : isSearching ? 'Search results' : 'Objects in view';

  function switchMode(next: BrowserMode) {
    setMode(next); setAutoDepth(0); setExpanded(new Set());
  }
  function applyOidRoot() {
    if (!/^\d+(?:\.\d+)*$/.test(rootInput.trim())) {
      notify({ tone: 'error', title: 'Invalid numeric OID', message: 'Use numeric arcs separated by periods.' }); return;
    }
    setRootOid(rootInput.trim()); setExpanded(new Set()); setSelected(null); setAutoDepth(0);
  }
  function clearFilters() {
    setFilter(''); setQuery(''); setModuleName(''); setTypeFilter(''); setAutoDepth(0); setExpanded(new Set());
  }
  function toggle(key: string) {
    setExpanded(old => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function expandDepth() {
    if (mode === 'module' && !moduleName) {
      notify({ tone: 'info', title: 'Choose a module', message: 'Select a module before expanding several levels; this avoids loading every MIB at once.' });
      return;
    }
    setAutoDepth(Number(depth));
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await cache.invalidateQueries({ queryKey: ['browser'] });
      notify({ tone: 'success', title: 'MIB browser refreshed' });
    } finally { setRefreshing(false); }
  }
  async function copyValue(value: string, title: string) {
    try { await navigator.clipboard.writeText(value); notify({ tone: 'success', title: title + ' copied' }); }
    catch { notify({ tone: 'error', title: 'Copy failed', message: 'Clipboard access is unavailable.' }); }
  }
  function handoff(key: 'walkerOid' | 'trapOid') {
    if (!displayed?.oid) return;
    try {
      sessionStorage.setItem(key, displayed.oid);
      if (key === 'trapOid' && displayed.type === 'NotificationType') {
        sessionStorage.setItem('selectedTrap', JSON.stringify({
          name: displayed.name, full_name: displayed.full_name, oid: displayed.oid,
          objects: detail.data?.trap_objects ?? [],
        }));
      }
    } catch { /* Handoff is optional, navigation remains possible. */ }
  }
  const exportRows = useMemo(() => {
    if (isSearching) return search.data?.results || [];
    if (mode === 'module') return flatVisibleNodes(moduleTree.data?.modules || [], expanded, cache, bundleId, typeFilter);
    const root = oidTree.data?.root;
    return flatVisibleNodes(root ? [{...root, name:root.name || rootOid, module:'', oid:root.oid, object_count:oidTree.data?.total_descendants||0, children:oidTree.data?.children || []}] : [], expanded, cache, bundleId, '');
  }, [isSearching, search.data, mode, moduleTree.data, oidTree.data, rootOid, expanded, cache, bundleId, typeFilter]);
  function exportCurrent(format: 'json' | 'csv') {
    if (!exportRows.length) return;
    if (format === 'json') saveLocalFile(JSON.stringify(exportRows, null, 2), 'trishul-browser-view.json');
    else {
      const columns = ['module','name','oid','type','syntax','access','description'];
      const escape = (value: unknown) => '"' + String(value ?? '').replace(/"/g,'""') + '"';
      const csv = [columns.join(','), ...exportRows.map(row => columns.map(k => escape(row[k as keyof BrowserNode])).join(','))].join('\r\n');
      saveLocalFile(csv, 'trishul-browser-view.csv', 'text/csv');
    }
    notify({tone:'success',title:'Current browser view exported',message:format.toUpperCase() + ' · ' + exportRows.length + ' loaded items'});
  }

  return <div className="workspace-page">
    <header><p className="eyebrow">MIB workbench / Browser</p><h1 className="mt-1 text-2xl font-semibold">MIB Browser</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Explore loaded modules or the numeric OID hierarchy, search objects and inspect their definitions.</p></header>
    <div className="workspace-grid workspace-grid--split">
      <div className="workspace-stack">
        <Card title="Browse" description="Select a view, filter the active MIB catalog, or search symbols.">
          <div role="group" aria-label="Browse mode" className="flex flex-wrap gap-2">
            <button className={mode === 'module' ? 'btn-primary':'btn-secondary'} onClick={() => switchMode('module')} aria-pressed={mode === 'module'}><BookOpen size={16}/> By module</button>
            <button className={mode === 'oid' ? 'btn-primary':'btn-secondary'} onClick={() => switchMode('oid')} aria-pressed={mode === 'oid'}><FolderTree size={16}/> By OID</button>
          </div>
          {mode === 'module' ? <>
            <label className="block text-sm font-medium">Search names, OIDs or descriptions
              <span className="mt-1 flex items-center gap-2"><Search size={17} className="shrink-0 text-[var(--muted)]"/>
                <input className="field-input" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="ifDescr, IF-MIB::linkDown, 1.3.6.1" />
                {filter && <button className="btn-secondary shrink-0 p-2" aria-label="Clear search" onClick={()=>{setFilter('');setQuery('');}}><X size={16}/></button>}
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="block text-sm font-medium">Module<select className="field-input mt-1" aria-label="Module" value={moduleName}
                onChange={e=>{setModuleName(e.target.value);setExpanded(new Set());setAutoDepth(0);}}>
                <option value="">All modules</option>{modules.data?.modules.map(item=><option key={item.name} value={item.name}>{item.name} ({item.objects ?? 0})</option>)}
              </select></label>
              <label className="block text-sm font-medium">Object type<select className="field-input mt-1" aria-label="Object type" value={typeFilter}
                onChange={e=>{setTypeFilter(e.target.value);setExpanded(new Set());setAutoDepth(0);}}>
                {BROWSER_TYPES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
              </select></label>
              <button className="btn-secondary self-end" onClick={clearFilters}>Clear filters</button>
            </div>
            <StatusText busy={modules.isPending} error={modules.error}/>
          </> : <label className="block text-sm font-medium">Numeric OID root
            <span className="mt-1 flex gap-2"><input aria-label="Numeric OID root" className="field-input font-mono text-sm" value={rootInput}
              onChange={e=>setRootInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();applyOidRoot();}}}
              placeholder="1.3.6.1" />
              <button type="button" className="btn-primary" onClick={applyOidRoot}>Browse</button>
              <button type="button" className="btn-secondary" onClick={()=>{setRootInput(BROWSER_ROOT_OID);setRootOid(BROWSER_ROOT_OID);setExpanded(new Set());}}>Reset</button></span>
            <span className="mt-1 block text-xs font-normal text-[var(--muted)]">Explore from this subtree. The standard root is 1.3.6.1.</span>
          </label>}
        </Card>
        <Card title={mode === 'module' ? 'MIB tree by module' : 'Numeric OID hierarchy'}
          description={count == null ? 'Loading active tree…' : count + ' ' + countLabel.toLowerCase()}>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={()=>void refresh()} disabled={refreshing}><RefreshCw size={16}/> Refresh</button>
            {!isSearching && <>
              <label className="text-xs font-medium">Depth<select className="field-input ml-2 inline-block w-17" aria-label="Expansion depth" value={depth}
                onChange={e=>setDepth(e.target.value)}>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
              <button className="btn-secondary" onClick={expandDepth}><ListTree size={16}/> Expand</button>
              <button className="btn-secondary" onClick={()=>{setExpanded(new Set());setAutoDepth(0);}}>Collapse</button>
            </>}
            <button className="btn-secondary" onClick={()=>exportCurrent('json')} disabled={!exportRows.length}><Download size={16}/> JSON</button>
            <button className="btn-secondary" onClick={()=>exportCurrent('csv')} disabled={!exportRows.length}><Download size={16}/> CSV</button>
          </div>
          <div className="browser-tree-viewport overflow-auto rounded-lg border border-[var(--border)]" role="tree" aria-label={isSearching?'MIB search results':mode==='module'?'MIB module tree':'Numeric OID tree'}>
            {isSearching ? <>
              <StatusText busy={search.isPending} error={search.error} empty={!search.isPending && !search.isError && !search.data?.results.length}/>
              <ul role="group">{search.data?.results.map((node,i) => <li key={browserNodeKey(node.oid,node.module || '')+i} role="treeitem"
                aria-selected={selectedKey===browserNodeKey(node.oid,node.module || '')}>
                <button className={'browser-tree-row block w-full text-left ' + (selectedKey===browserNodeKey(node.oid,node.module||'')?'browser-tree-row-selected':'')}
                  onClick={()=>setSelected(node)}>
                  <span className="block text-sm font-semibold">{node.full_name||node.name}</span>
                  <span className="block break-all font-mono text-xs text-[var(--muted)]">{node.oid} · {node.type}</span>
                  {node.description && <span className="block truncate text-xs text-[var(--muted)]">{node.description}</span>}
                </button></li>)}</ul>
            </> : mode === 'module' ? <>
              <StatusText busy={moduleTree.isPending} error={moduleTree.error} empty={!moduleTree.isPending && !moduleTree.isError && !moduleTree.data?.modules.length}/>
              <ul role="group">
                {moduleTree.data?.modules.map(mod => {
                  const key='module:'+mod.name;
                  const opened=expanded.has(key) || !!moduleName || !!typeFilter;
                  return <li role="treeitem" key={mod.name} aria-expanded={opened}>
                    <div className="browser-tree-row browser-module-row">
                      <button className="browser-tree-toggle" aria-label={(opened?'Collapse ':'Expand ')+mod.name} aria-expanded={opened}
                        onClick={()=>toggle(key)}>{opened?<ChevronDown size={17}/>:<ChevronRight size={17}/>}</button>
                      <button className="min-w-0 flex-1 py-2 text-left text-sm font-semibold" onClick={()=>toggle(key)}>
                        <BookOpen size={15} className="mr-2 inline text-[var(--accent)]"/> {mod.name}</button>
                      <span className="text-xs text-[var(--muted)]">{mod.object_count} objects</span>
                    </div>
                    {opened && <ul role="group" className="pl-2">
                      {mod.children.map((node,i) => <TreeNode key={browserNodeKey(node.oid,node.module||mod.name)+i} node={node}
                        module={mod.name} token={token} bundleId={bundleId} typeFilter={typeFilter}
                        selectedKey={selectedKey} expanded={expanded} toggle={toggle} onSelect={setSelected}
                        level={1} autoDepth={autoDepth}/>)}
                    </ul>}
                  </li>;
                })}
              </ul>
              {!moduleTree.isPending && !moduleTree.data?.modules.length && !moduleName && !typeFilter && <p className="p-3 text-xs text-[var(--muted)]">Load a MIB bundle in <Link className="link" to="/mibs">MIB Manager</Link> to populate this tree.</p>}
            </> : <>
              <StatusText busy={oidTree.isPending} error={oidTree.error}/>
              {oidTree.data?.root && <ul role="group"><li role="treeitem" aria-expanded>
                <div className="browser-tree-row browser-module-row">
                  <FolderTree size={17} className="mx-1 shrink-0 text-[var(--accent)]"/>
                  <button className="min-w-0 flex-1 py-2 text-left font-semibold" onClick={()=>setSelected(oidTree.data!.root!)}>{oidTree.data.root.name||rootOid}</button>
                  <code className="text-xs text-[var(--muted)]">{rootOid}</code>
                </div>
                <ul role="group" className="pl-2">{oidTree.data.children.map((node,i)=><TreeNode
                  key={browserNodeKey(node.oid,node.module||'')+i} node={node} module="" token={token} bundleId={bundleId} typeFilter=""
                  selectedKey={selectedKey} expanded={expanded} toggle={toggle} onSelect={setSelected}
                  level={1} autoDepth={autoDepth} oidMode/>)}</ul>
              </li></ul>}
            </>}
          </div>
          {isSearching && <p className="text-xs text-[var(--muted)]">Search returns up to 100 ranked results. Clear the search to return to the module hierarchy.</p>}
        </Card>
      </div>
      <Card title="Object details" description="Symbolic identity, data definition, table indexes and notification members.">
        {!selected ? <div className="flex min-h-56 flex-col items-center justify-center text-center text-[var(--muted)]">
          <FolderTree size={28} strokeWidth={1.5} /><p className="mt-3 text-sm font-semibold">Select a node in the tree</p>
          <p className="mt-1 max-w-xs text-xs">Click a symbol to inspect metadata, or expand its chevron to see child objects.</p>
        </div> : <>
          <StatusText busy={detail.isPending} error={detail.error}/>
          {bundle.data?.recompile_recommended && <p className="flex gap-2 rounded-lg bg-[var(--surface-muted)] p-3 text-xs text-[var(--warning)]">
            <AlertTriangle size={17} className="shrink-0"/> Older MIB bundle lacks {bundle.data.missing_capabilities?.join('/') || 'enum/units'} metadata.
            <Link to="/mibs" className="underline">Recompile in MIB Manager</Link>
          </p>}
          {detail.data?.breadcrumb?.length ? <nav aria-label="Object ancestry" className="flex flex-wrap items-center gap-1 text-xs">
            {detail.data.breadcrumb.map((crumb,i)=><span key={browserNodeKey(crumb.oid,crumb.module||'')+i}>
              {i>0&&<ChevronRight size={12} className="inline"/>}
              <button className="rounded px-1 py-0.5 text-[var(--accent)] hover:underline" onClick={()=>setSelected(crumb)}>{crumb.name||crumb.oid}</button>
            </span>)}
          </nav>:null}
          <div><h3 className="break-words text-lg font-semibold">{displayed?.name}</h3>
            <p className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{displayed?.full_name||'—'}</p></div>
          <div className="space-y-2 rounded-xl bg-[var(--surface-muted)] p-3">
            <p className="text-xs font-semibold text-[var(--muted)]">Numeric OID</p>
            <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{displayed?.oid}</code>
              <button className="btn-secondary p-2" aria-label="Copy OID" onClick={()=>void copyValue(displayed?.oid||'','OID')}><ClipboardCopy size={16}/></button></div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-secondary" onClick={()=>void copyValue(displayed?.full_name||'','Symbolic name')} disabled={!displayed?.full_name}><ClipboardCopy size={16}/> Copy name</button>
              <Link to="/walker" className="btn-secondary" onClick={()=>handoff('walkerOid')}>Use in Walker <ArrowRight size={15}/></Link>
              <Link to="/traps" className="btn-secondary" onClick={()=>handoff('trapOid')}>Use in Traps <ArrowRight size={15}/></Link>
            </div>
          </div>
          <dl className="space-y-2 text-xs">
            {([['Module', displayed?.module],['Type',displayed?.type],['Syntax',displayed?.syntax],
              ['Access',displayed?.access],['Status',displayed?.status],['Units',displayed?.units],
              ['Description',displayed?.description]] as const).map(([label,value])=>
              <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 border-b border-[var(--border)] pb-2">
                <dt className="font-semibold text-[var(--muted)]">{label}</dt><dd className="break-words">{displayValue(value)}</dd>
              </div>)}
          </dl>
          {displayed?.indexes?.length ? <div><h4 className="text-sm font-semibold">Table indexes</h4><p className="mt-1 break-words text-xs">{displayed.indexes.join(', ')}</p></div>:null}
          {displayed?.constraints && <div><h4 className="text-sm font-semibold">Constraints</h4>
            <p className="mt-1 text-xs">{displayed.constraints.kind}: {JSON.stringify(displayed.constraints.data)}</p></div>}
          {displayed?.enums && Object.keys(displayed.enums).length > 0 && <div>
            <h4 className="text-sm font-semibold">Enumeration values</h4>
            <div className="mt-2 max-h-44 overflow-auto rounded-lg border border-[var(--border)]">
              {Object.entries(displayed.enums).sort((a,b)=>Number(a[1])-Number(b[1])).map(([key,value])=>
                <div key={key} className="flex justify-between gap-3 border-b border-[var(--border)] px-3 py-2 text-xs"><span>{key}</span><code>{String(value)}</code></div>)}
            </div></div>}
          {detail.data?.trap_objects?.length ? <div><h4 className="text-sm font-semibold">Notification objects</h4>
            <ul className="mt-2 space-y-1">{detail.data.trap_objects.map((object,i)=> <li key={i} className="break-all rounded-lg bg-[var(--surface-muted)] p-2 font-mono text-xs">{JSON.stringify(object)}</li>)}</ul>
          </div> : null}
        </>}
      </Card>
    </div>
  </div>;
}

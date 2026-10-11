import { useMemo, useState, type ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { buildCatalogEntries, filterSortCatalog, nextCatalogSort, scopedSelection, type CatalogSort, type CatalogSortKey } from './catalog-model';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router';
import { BookOpen, Send, ChevronDown, ChevronRight, Plus, CloudDownload, Wrench, X } from 'lucide-react';
import { sendToBrowser, sendToTraps } from '../../lib/navigation/handoff';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useNotifications } from '../../lib/notifications/NotificationProvider';
import { Download, FileUp, RefreshCw, Search, Trash2, GitCompareArrows, RotateCcw } from 'lucide-react';
import { apiRequest } from '../../lib/api/client';
import { Card, ConfirmDialog, Field, IconAction, JsonView, StatusText, displayValue, jsonPost, useOperatorApi } from '../shared/operator-ui';

interface MibSource {
  name: string; file?: string; relative_path?: string; status?: string; source_kind?: string;
  source_group?: string; objects?: number; traps?: number; imports?: string[]; missing_deps?: string[];
  builtin?: boolean; deletable?: boolean; error?: string; active_relative_path?: string;
}
interface MibStatus {
  loaded: number; failed?: number; mibs: MibSource[]; source_inventory?: MibSource[];
  source_groups?: { name: string; file_count: number; active_module_count?: number }[];
  active_bundle_label?: string; producer_version?: string; recompile_recommended?: boolean;
  active_bundle_id?: number;
}
interface BundleSummary {
  id: number; label?: string; bundle_key?: string; status?: string; created_at?: string;
  module_count?: number; producer_version?: string;
}
interface BundlesResponse { bundles: BundleSummary[]; active_bundle_id: number | null; previous_active_bundle_id?: number | null }
interface TrapCatalog { traps: { name: string; full_name: string; oid: string; module?: string; objects?: {name: string; oid: string; input_type?: string}[] }[] }
function safeFilename(value: string | null, fallback: string): string {
  const found = value?.match(/filename="?([^";]+)"?/i)?.[1];
  return found && /^[A-Za-z0-9_.-]+$/.test(found) ? found : fallback;
}
function asList(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean) : [];
}
export function MibsPage() {
  const { expire } = useAuth();
  const { token, pending, setNotice, invoke } = useOperatorApi();
  // A stale session is cleared by apiRequest on authenticated 401 responses.
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [catalogSort, setCatalogSort] = useState<CatalogSort>({field:'name',descending:false});
  const [notificationDescending,setNotificationDescending]=useState(false);
  const [page, setPage] = useState(0);
  const [inspectSource, setInspectSource] = useState<string|null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sourceGroup, setSourceGroup] = useState('');
  const [compileMode, setCompileMode] = useState('full');
  const [selectedCatalog, setSelectedCatalog] = useState<string[]>([]);
  const [selectedNotifications, setSelectedNotifications] = useState<string[]>([]);
  const [modal, setModal] = useState<'add'|'maintenance'|null>(null);
  const [addMode, setAddMode] = useState<'online'|'files'>('online');
  const [onlineNames, setOnlineNames] = useState('');
  const [onlineReload, setOnlineReload] = useState(true);
  const [onlineResult, setOnlineResult] = useState<{cached?:string[];resolved?:string[];downloaded?:string[];failed?:string[];enabled?:boolean;auto_enabled?:boolean;using_default_sources?:boolean;sources?:string[]}|null>(null);
  const [validation, setValidation] = useState<unknown>(null);
  const [compileTargets, setCompileTargets] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<'reload'|'delete'|'activate'|'fetch'|null>(null);
  const [dependencies, setDependencies] = useState('');
  const [reloadAfterFetch, setReloadAfterFetch] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const { notify } = useNotifications();
  const cache = useQueryClient();
  const [fetchingOnline,setFetchingOnline]=useState(false);
  const [exportFormat, setExportFormat] = useState('json');
  const [exportType, setExportType] = useState('catalog');
  const [diffAgainst, setDiffAgainst] = useState<number | null>(null);
  const [targetBundle, setTargetBundle] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<'modules'|'traps'>('modules');
  const status = useQuery({
    queryKey: ['mibs', 'manager-status'], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<MibStatus>('/api/mibs/status', token, { signal }),
    refetchInterval: 30_000,
  });
  const bundles = useQuery({
    queryKey: ['bundles'], enabled: !!token,
    queryFn: ({ signal }) => apiRequest<BundlesResponse>('/api/bundles', token, { signal }), staleTime: 30_000,
  });
  const traps = useQuery({
    queryKey: ['mibs', 'trap-catalog'], enabled: !!token && activeTab === 'traps',
    queryFn: ({ signal }) => apiRequest<TrapCatalog>('/api/mibs/traps', token, { signal }), staleTime: 60_000,
  });
  const catalog=useMemo(()=>buildCatalogEntries(status.data?.mibs||[],status.data?.source_inventory||[]),
    [status.data?.mibs,status.data?.source_inventory]);
  const shown=useMemo(()=>filterSortCatalog(catalog,query,groupFilter,statusFilter,catalogSort),
    [catalog,query,groupFilter,statusFilter,catalogSort]);
  const notificationModules=useMemo(() => [...new Set((traps.data?.traps||[]).map(t=>t.module).filter((name):name is string=>!!name))].sort(),[traps.data]);
  const filteredNotifications=useMemo(()=>(traps.data?.traps||[]).filter(t=>
    (!groupFilter || t.module===groupFilter) &&
    (!query || [t.name,t.full_name,t.module,t.oid].some(value=>value?.toLowerCase().includes(query.toLowerCase()))))
    .sort((a,b)=>notificationDescending?b.full_name.localeCompare(a.full_name):a.full_name.localeCompare(b.full_name)),
    [traps.data,query,groupFilter,notificationDescending]);
  const pageSize=75;
  const visible=shown.slice(page*pageSize,(page+1)*pageSize);
  const visibleNotifications=filteredNotifications.slice(page*pageSize,(page+1)*pageSize);
  const visibleSelectable=activeTab==='modules'?visible.map(item=>item.key):visibleNotifications.map(item=>item.full_name);
  const currentSelection=activeTab==='modules'?selectedCatalog:selectedNotifications;
  const totalVisible=activeTab==='traps'?filteredNotifications.length:shown.length;
  const {modules:selectedModules,paths:selectedPaths}=useMemo(()=>scopedSelection(catalog,selectedCatalog),
    [catalog,selectedCatalog]);
  const deletable=selectedPaths;
  function updateSelection(id:string,checked:boolean) {
    const setter=activeTab==='modules'?setSelectedCatalog:setSelectedNotifications;
    setter(old=>checked?[...new Set([...old,id])]:old.filter(value=>value!==id));
  }
  function toggleVisibleSelection() {
    const setter=activeTab==='modules'?setSelectedCatalog:setSelectedNotifications;
    setter(old=>visibleSelectable.every(id=>old.includes(id))?old.filter(id=>!visibleSelectable.includes(id))
      :[...new Set([...old,...visibleSelectable])]);
  }
  function clearViewSelection() {
    if(activeTab==='modules')setSelectedCatalog([]);
    else setSelectedNotifications([]);
  }
  function sortCatalog(field:CatalogSortKey){
    setCatalogSort(previous=>nextCatalogSort(previous,field));setPage(0);
  }
  function sortHeader(field:CatalogSortKey,label:string){
    const active=catalogSort.field===field;
    const Icon=active?(catalogSort.descending?ArrowDown:ArrowUp):ArrowUpDown;
    return <button type="button" className="manager-sort-button"
      title={'Sort by '+label} aria-label={'Sort by '+label} onClick={()=>sortCatalog(field)}>
      {label}<Icon size={14} aria-hidden="true"/></button>;
  }
  function makeUploadForm() {
    const form = new FormData();
    files.forEach(file => form.append('files', file, file.name));
    if (sourceGroup.trim()) form.append('source_group', sourceGroup.trim());
    return form;
  }
  async function validate() {
    if (!files.length) { setNotice({ tone: 'error', text: 'Select MIB source files first.' }); return; }
    const result = await invoke('/api/mibs/validate-batch', { method: 'POST', body: makeUploadForm() });
    if (result) {
      setValidation(result);
      const report = result as { partial_compile?: { ready_mibs?: string[] } };
      setCompileTargets(report.partial_compile?.ready_mibs || []);
    }
  }
  async function upload() {
    if (!files.length) { setNotice({ tone: 'error', text: 'Select MIB source files first.' }); return; }
    const form = makeUploadForm(); form.append('compile_mode', compileMode);
    if (compileMode === 'partial' && validation) {
      if (!compileTargets.length) { setNotice({ tone: 'error', text: 'No validated ready modules selected for partial compile.' }); return; }
      form.append('compile_targets', JSON.stringify(compileTargets));
    }
    const result = await invoke('/api/mibs/upload', { method: 'POST', body: form }, [['mibs'], ['bundles'], ['stats']]);
    if (result) {
      setLastResult(result); setFiles([]); setValidation(null);
      const report = result as { results?: { status?: string; error?: string }[]; compile_error?: string };
      const problems = (report.results || []).filter(item => ['failed','error','skipped'].includes(item.status || ''));
      if (report.compile_error || problems.length) {
        setNotice({ tone: 'error', text: 'Upload finished with compile issues. Review Last operation details below before using the bundle.' });
      }
      const input = document.getElementById('mib-files') as HTMLInputElement | null;
      if (input) input.value = '';
    }
  }
  async function runConfirm() {
    if (confirm === 'reload') {
      const result = await invoke('/api/mibs/reload', { method: 'POST' }, [['mibs'], ['bundles'], ['stats']]);
      if (result) setLastResult(result);
    } else if (confirm === 'delete') {
      if (!deletable.length) { setConfirm(null); return; }
      const result = await invoke('/api/mibs/delete-batch', jsonPost({ paths: deletable }), [['mibs'], ['bundles'], ['stats']]);
      if (result) { setSelectedCatalog([]); setLastResult(result); }
    } else if (confirm === 'activate' && targetBundle !== null) {
      const result = await invoke('/api/bundles/' + targetBundle + '/activate', { method: 'POST' }, [['mibs'], ['bundles'], ['stats']]);
      if (result) setLastResult(result);
    } else if (confirm === 'fetch') {
      const deps = asList(dependencies);
      if (deps.length) {
        const result = await invoke('/api/mibs/fetch-dependencies', jsonPost({ dependencies: deps, reload_after_fetch: reloadAfterFetch }), [['mibs'], ['bundles'], ['stats']]);
        if (result) setLastResult(result);
      }
    }
    setConfirm(null);
  }
  async function fetchByName() {
    const requested=[...new Set(asList(onlineNames))];
    if (!requested.length || requested.length>30 ||
        requested.some(name=>!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name))) {
      notify({tone:'warning',title:'Check module names',
        message:'Enter 1–30 module names (letters, numbers, hyphen, underscore), one per line or comma-separated.'});
      return;
    }
    if(!token || fetchingOnline || pending)return;
    setOnlineResult(null);setFetchingOnline(true);
    try {
      const result=await apiRequest<NonNullable<typeof onlineResult>>('/api/mibs/fetch-dependencies',token,
        jsonPost({dependencies:requested,reload_after_fetch:onlineReload}));
      setOnlineResult(result);setLastResult(result);
      await Promise.all([['mibs'],['bundles'],['stats']].map(key=>cache.invalidateQueries({queryKey:key})));
      const failures=result.failed||[];
      const fetched=result.resolved||result.downloaded||[];
      if (failures.length){
        notify({tone:'warning',title:'MIB names unresolved',message:
          failures.join(', ')+(result.auto_enabled===false
            ? ': online fetching is disabled in Settings.'
            : result.using_default_sources?': default remote sources could not provide these modules.'
              : ': configured remote sources could not provide these modules.')});
      }else{
        notify({tone:'success',title:'MIB source request complete',
          message:fetched.length?fetched.length+' module(s) fetched.':'Already present or cached.'});
      }
    }catch(error){
      notify({tone:'error',title:'MIB online fetch request failed',
        message:error instanceof Error?error.message:'Could not contact MIB source service.'});
    }finally{setFetchingOnline(false);}
  }
  async function getDiff(id: number) {
    if (!token) return;
    setDiffResult(null);
    try {
      const path = '/api/bundles/' + id + '/diff' + (diffAgainst ? '?against=' + diffAgainst : '');
      const result = await apiRequest<unknown>(path, token);
      setDiffResult(result);
    } catch (e) { setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'Could not compare bundles.' }); }
  }
  async function download(path: '/api/mibs/download'|'/api/mibs/export', body: unknown, fallback: string) {
    if (!token || downloading) return;
    setDownloading(true);
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin',
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 401) expire(token);
      if (!response.ok) {
        const error: unknown = await response.json().catch(() => ({}));
        throw Error(error && typeof error === 'object' && 'detail' in error ? String((error as { detail: unknown }).detail) : 'Download failed (' + response.status + ')');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = safeFilename(response.headers.get('content-disposition'), fallback);
        document.body.appendChild(anchor);
        try { anchor.click(); } finally { anchor.remove(); }
      } finally { URL.revokeObjectURL(url); }
      notify({tone:'success',title:'Export completed',message:'File exported.'});
    } catch (error) { notify({tone:'error',title:'Export failed',message:error instanceof Error ? error.message : 'Download failed.'}); }
    finally { setDownloading(false); }
  }
  return <div className="workspace-page">
    <header><p className="eyebrow">MIB Workbench / Manager</p><h1 className="mt-1 text-2xl font-semibold">MIB source &amp; bundle manager</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Review active modules, validate sources, manage bundles and export catalogs.</p></header>
    <div className="manager-stat-strip">
      {([['Modules',status.data?.loaded],['Failed sources',status.data?.failed],
        ['Bundle',status.data?.active_bundle_label],['Compiler',status.data?.producer_version]] as [string,unknown][]).map(([label,value])=>
        <div className="manager-stat" key={label}><span className="text-xs text-[var(--muted)]">{label}</span>
          <strong className="block truncate text-base font-semibold" title={displayValue(value)}>{displayValue(value)}</strong></div>)}
    </div>
    {status.data?.recompile_recommended && <p role="status" className="rounded-xl bg-[var(--accent-soft)] p-4 text-sm text-[var(--warning)]">
      The active bundle was produced by an older compiler. Review the source and compile history before reloading.</p>}
    <div className="manager-layout">
      <div className="manager-catalog-column">
      <Card title="Catalog & source inventory" description="Manage active modules and stored sources together; filter by group and select entries."
        trailing={<div className="flex flex-wrap justify-end gap-2" role="group" aria-label="Catalog management actions">
          <button type="button" className="btn-primary" onClick={()=>{setAddMode('online');setOnlineResult(null);setModal('add');}}><Plus size={16}/> Add / upload</button>
          <button type="button" className="btn-secondary" onClick={()=>setModal('maintenance')}><Wrench size={16}/> Reload & dependencies</button>
        </div>}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Inventory views" className="flex flex-wrap gap-1 rounded-lg bg-[var(--surface-muted)] p-1">
            {(['modules','traps'] as const).map(tab=><button type="button" key={tab}
              aria-pressed={activeTab===tab} className={activeTab===tab?'btn-primary':'btn-secondary'}
              onClick={()=>{setActiveTab(tab);setPage(0);setInspectSource(null);setQuery('');setGroupFilter('');setStatusFilter('');}}>
              {tab==='modules'?'Modules & sources':'Notifications'}
            </button>)}
          </div>
          <IconAction label="Refresh MIB inventory" onClick={()=>{void status.refetch();void bundles.refetch();}}><RefreshCw size={16}/></IconAction>
        </div>
        <div className={'grid min-w-0 gap-3 sm:grid-cols-2 ' +
          (activeTab==='traps'?'xl:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)]':
            'xl:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_auto]')}>
          <label className="relative min-w-0"><span className="sr-only">Search inventory</span>
            <input className="field-input pr-9" value={query} placeholder={activeTab==='traps'?'Search notifications by name or OID':'Search module, file or status'}
              onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
            <Search size={15} className="pointer-events-none absolute right-3 top-3 text-[var(--muted)]"/>
          </label>
          <label className="text-xs font-medium">{activeTab==='traps'?'Notification module':'Source group'}
            <select className="field-input mt-1" value={groupFilter} onChange={e=>{setGroupFilter(e.target.value);setPage(0);}}>
              <option value="">{activeTab==='traps'?'All modules':'All groups'}</option>
              {activeTab==='traps'?notificationModules.map(name=><option key={name} value={name}>{name}</option>)
                :status.data?.source_groups?.map(g=><option key={g.name} value={g.name}>{g.name} ({g.file_count})</option>)}
            </select>
          </label>
          {activeTab!=='traps' && <>
            <label className="text-xs font-medium">Status
              <select className="field-input mt-1" value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(0);}}>
                <option value="">All statuses</option>{['active','pending','missing_deps','failed','shadowed','invalid'].map(item=><option key={item} value={item}>{item}</option>)}
              </select>
            </label>

          </>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--muted)]">
          <span>{totalVisible} entries · {currentSelection.length} selected</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" disabled={!visibleSelectable.length} onClick={toggleVisibleSelection}>
              {visibleSelectable.length&&visibleSelectable.every(id=>currentSelection.includes(id))?'Deselect visible':'Select visible'}
            </button>
            {currentSelection.length>0&&<button className="btn-secondary" type="button" onClick={clearViewSelection}>Clear selection</button>}
          </div>
        </div>
        <StatusText busy={status.isPending} error={status.error} empty={!status.isPending && !shown.length && activeTab !== 'traps'} />
        {activeTab === 'traps' ? <><StatusText busy={traps.isPending} error={traps.error} empty={!traps.isPending && !filteredNotifications.length}/>
          <div className="manager-inventory-table overflow-auto rounded-lg border border-[var(--border)]"><table className="min-w-full text-left text-xs">
            <thead><tr><th className="p-2">Select</th><th className="p-2" aria-sort={notificationDescending?'descending':'ascending'}>
              <button className="manager-sort-button" aria-label="Sort by notification"
                onClick={()=>{setNotificationDescending(value=>!value);setPage(0);}}>Notification
                {notificationDescending?<ArrowDown size={14}/>:<ArrowUp size={14}/>}</button>
              </th><th className="p-2">OID</th><th className="p-2">Use</th></tr></thead><tbody>
              {visibleNotifications.map(t=><tr key={t.oid} className="border-t border-[var(--border)]">
                <td className="p-2"><input type="checkbox" aria-label={'Select notification '+t.full_name}
                  checked={selectedNotifications.includes(t.full_name)} onChange={e=>updateSelection(t.full_name,e.target.checked)}/></td>
                <td className="p-2">{t.full_name}</td><td className="break-all p-2 font-mono">{t.oid}</td>
                <td className="p-2"><div className="flex flex-wrap gap-2">
                  <Link to="/traps" className="btn-secondary" onClick={() => sendToTraps(t)}>
                    <Send size={15}/> Send
                  </Link>
                  <Link to="/browser" className="btn-secondary" onClick={() => sendToBrowser({
                    query: t.full_name || t.oid, type: 'NotificationType',
                  })}><BookOpen size={15}/> Browse</Link>
                </div></td></tr>)}
            </tbody></table></div></> :
          <div className="manager-inventory-table overflow-auto rounded-lg border border-[var(--border)]"><table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-[var(--surface-muted)]"><tr><th className="p-2">Select</th>
              {([['name','Module / source'],['source_group','Source group'],['status','Status'],['objects','Objects'],['traps','Traps']] as [CatalogSortKey,string][]).map(([field,label])=>
                <th className="p-2" key={field} aria-sort={catalogSort.field===field?(catalogSort.descending?'descending':'ascending'):'none'}>
                  {sortHeader(field,label)}</th>)}</tr></thead>
            <tbody>{visible.map(item=>{const path=item.sourcePath || '';const open=inspectSource===item.key;return <tr key={item.key}
              className="border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
              <td className="p-2"><input type="checkbox" aria-label={'Select '+(item.active?item.name:path||item.name)}
                checked={selectedCatalog.includes(item.key)}
                onChange={e=>updateSelection(item.key,e.target.checked)}/></td>
              <td className="max-w-64 break-words p-2"><span className="font-semibold">{item.name}</span>
                <span className="block break-all font-mono text-[var(--muted)]">{path}</span>
                {item.source_group && <span className="block text-[var(--muted)]">{item.source_group}</span>}
                {item.error && <span className="block text-[var(--danger)]">{item.error}</span>}
                {(item.imports?.length || item.missing_deps?.length || item.active_relative_path) && <div className="mt-2">
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                    aria-expanded={open} onClick={()=>setInspectSource(open?null:item.key)}>
                    {open?<ChevronDown size={14}/>:<ChevronRight size={14}/>} {open?'Hide source details':'Source details'}
                  </button>
                  {open&&<div className="mt-2 space-y-1 rounded-md border border-[var(--border)] p-2 text-xs">
                    {item.active_relative_path&&<p>Active path: <code className="break-all">{item.active_relative_path}</code></p>}
                    {!!item.imports?.length&&<p>Imports: {item.imports.join(', ')}</p>}
                    {!!item.missing_deps?.length&&<p className="text-[var(--danger)]">Missing: {item.missing_deps.join(', ')}</p>}
                  </div>}
                </div>}
                {item.active && <Link className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                  to="/browser" onClick={() => sendToBrowser({ module: item.name })}>
                  <BookOpen size={13}/> Browse module
                </Link>}</td>
              <td className="p-2 text-xs">{item.source_group||'Built-in / compiled'}</td>
              <td className="p-2"><span className={'manager-status manager-status-'+(item.status||'active').toLowerCase()}>
                {item.status||'active'}</span></td><td className="p-2">{item.objects??'—'}</td><td className="p-2">{item.traps??'—'}</td>
            </tr>})}</tbody></table></div>}
        {totalVisible>pageSize && <div className="flex items-center justify-end gap-2 text-xs">
          <span>Page {page+1} of {Math.ceil(totalVisible/pageSize)}</span>
          <button className="btn-secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous</button>
          <button className="btn-secondary" disabled={(page+1)*pageSize>=totalVisible} onClick={()=>setPage(p=>p+1)}>Next</button>
        </div>}
        <div className="flex flex-wrap items-center gap-2">
          {activeTab==='modules' && <>
            <button className="btn-secondary" disabled={!selectedPaths.length||downloading}
              title="Download selected managed source files"
              onClick={()=>void download('/api/mibs/download',{paths:selectedPaths},'trishul-mib-sources.zip')}>
              <Download size={16}/> Sources ({selectedPaths.length})
            </button>
            <button className="btn-danger" disabled={!deletable.length||pending} onClick={()=>setConfirm('delete')}>
              <Trash2 size={16}/> Delete sources ({deletable.length})
            </button>
          </>}
          <p className="text-xs text-[var(--muted)]">{currentSelection.length?
            'Export selected definitions in the sidebar; only managed uploaded files support download/delete.':
            'Select definitions to export, or uploaded sources for download/delete.'}</p>
        </div>
      </Card>
</div>
<aside className="manager-sidebar" aria-label="Catalog export and bundle history">
<Card title="Catalog export" description="Export all or selected MIB definitions.">
          <p className="text-xs text-[var(--muted)]">{selectedModules.length} modules · {selectedNotifications.length} notifications selected. {!selectedModules.length&&!selectedNotifications.length?'Full catalog export':''}</p>
        <div className="grid grid-cols-2 gap-2">
            <Field label="Format"><select className="field-input" value={exportFormat} onChange={e=>setExportFormat(e.target.value)}><option value="json">JSON</option><option value="csv">CSV</option></select></Field>
            <Field label="Export type"><select className="field-input" value={exportType} onChange={e=>setExportType(e.target.value)}>
              <option value="catalog">Catalog</option><option value="notifications">Notifications</option></select></Field>
          </div>
          <button className="btn-secondary" disabled={downloading} onClick={()=>void download('/api/mibs/export',
            {format:exportFormat,export_type:exportType,modules:selectedModules,notifications:selectedNotifications,source_groups:groupFilter?[groupFilter]:[]},
            'trishul-mib-catalog.'+exportFormat)}><Download size={16}/> Export catalog</button>
        </Card>
<Card title="Compiled bundle history" description="Compare revisions before activating a different compiled bundle.">
      <StatusText busy={bundles.isPending} error={bundles.error} empty={!bundles.isPending&&!bundles.data?.bundles.length}/>
      <Field label="Diff against" hint="Leave on active bundle to compare a candidate with the current effective bundle.">
        <select className="field-input max-w-xs" value={diffAgainst??''} onChange={e=>setDiffAgainst(e.target.value?Number(e.target.value):null)}>
          <option value="">Active bundle</option>{bundles.data?.bundles.map(b=><option key={b.id} value={b.id}>#{b.id} {b.label||b.bundle_key}</option>)}</select></Field>
      <div className="manager-bundle-list space-y-2 overflow-auto">
 {bundles.data?.bundles.map(b=><div key={b.id} className="rounded-lg border border-[var(--border)] p-3 text-sm">
   <div className="flex items-start justify-between gap-2">
     <div className="min-w-0"><strong className="block break-all">#{b.id} · {b.label||b.bundle_key||'Bundle'}</strong>
       <span className="text-xs text-[var(--muted)]">{b.module_count??'—'} modules</span></div>
     <span className={bundles.data?.active_bundle_id===b.id?'manager-status manager-status-active':'manager-status'}>
       {bundles.data?.active_bundle_id===b.id?'Active':b.status||'Stored'}</span>
   </div>
   <div className="mt-3 flex flex-wrap gap-2">
     <button className="btn-secondary" disabled={bundles.data?.active_bundle_id===b.id||diffAgainst===b.id}
       onClick={()=>void getDiff(b.id)}><GitCompareArrows size={15}/> Compare</button>
     <button className="btn-secondary" disabled={pending||bundles.data?.active_bundle_id===b.id}
       onClick={()=>{setTargetBundle(b.id);setConfirm('activate');}}>Activate / rollback</button>
   </div>
 </div>)}
</div>
{diffResult != null&&<details open><summary className="cursor-pointer text-sm font-semibold">Bundle difference</summary><JsonView data={diffResult}/></details>}
      {lastResult != null&&<details><summary className="cursor-pointer text-sm font-semibold">Last operation details</summary><JsonView data={lastResult}/></details>}
    </Card>
</aside>
</div>
<Dialog.Root open={modal==='add'} onOpenChange={open=>{if(!pending)setModal(open?'add':null);}}>
 <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/55"/>
 <Dialog.Content className="manager-modal fixed left-1/2 top-1/2 z-50 w-[min(43rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-2xl">
   <div className="flex items-center justify-between gap-3">
     <Dialog.Title className="text-lg font-semibold">Add MIB sources</Dialog.Title>
     <Dialog.Close disabled={pending} className="btn-secondary btn-icon-action" aria-label="Close add MIB sources"><X size={18}/></Dialog.Close>
   </div>
   <Dialog.Description className="mb-4 mt-1 text-xs text-[var(--muted)]">Fetch by name from online sources, or validate and upload local MIB files.</Dialog.Description>
   <div role="group" aria-label="Add MIB method" className="mb-4 flex flex-wrap gap-2">
  <button className={addMode==='online'?'btn-primary':'btn-secondary'} aria-pressed={addMode==='online'} onClick={()=>setAddMode('online')}><CloudDownload size={16}/> Fetch by name</button>
  <button className={addMode==='files'?'btn-primary':'btn-secondary'} aria-pressed={addMode==='files'} onClick={()=>setAddMode('files')}><FileUp size={16}/> Upload files</button>
</div>
{addMode==='online'?<div className="space-y-4">
 <Field label="MIB module name(s)" hint="Example: IF-MIB. Enter up to 30 names separated by commas or new lines.">
   <textarea aria-label="MIB module names" className="field-input min-h-24 font-mono text-sm" placeholder="IF-MIB"
     value={onlineNames} onChange={ev=>{setOnlineNames(ev.target.value);setOnlineResult(null);}}/>
 </Field>
 <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlineReload}
   onChange={ev=>setOnlineReload(ev.target.checked)}/> Recompile after new sources are fetched</label>
 <p className="rounded-lg bg-[var(--surface-muted)] p-3 text-xs text-[var(--muted)]">
   Requires remote MIB fetching enabled in <Link className="link" to="/settings" onClick={()=>setModal(null)}>Settings</Link>.
   Already present modules are reported as cached; not all names are necessarily available remotely.
 </p>
 <button className="btn-primary" disabled={!onlineNames.trim()||pending||fetchingOnline} onClick={()=>void fetchByName()}>
   <CloudDownload size={16}/> Fetch MIBs by name</button>
 {onlineResult&&<section aria-label="Online MIB fetch results" className="space-y-1 rounded-lg border border-[var(--border)] p-3 text-xs">
   <h3 className="text-sm font-semibold">Fetch results</h3>
   <p>Downloaded: {(onlineResult.resolved||onlineResult.downloaded||[]).join(', ')||'None'}</p>
   <p>Already cached: {(onlineResult.cached||[]).join(', ')||'None'}</p>
   <p className={onlineResult.failed?.length?'text-[var(--danger)]':''}>Unresolved: {(onlineResult.failed||[]).join(', ')||'None'}</p>
   {onlineResult.failed?.length ? <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
     <p className="font-semibold">What to try next</p>
     <p>{onlineResult.auto_enabled===false
       ? 'Turn on automatic MIB fetching in Settings before retrying.'
       : onlineResult.using_default_sources
         ? 'The default fetch sources did not return the requested module. Try a trusted remote template in Settings or upload a vendor-provided MIB file.'
         : 'The configured sources did not return the requested module. Check your URL templates and network access, or upload a vendor-provided MIB file.'}</p>
     <button type="button" className="btn-secondary" onClick={()=>setAddMode('files')}>
       <FileUp size={16}/> Upload a local MIB file instead
     </button>
   </div> : null}
 </section>}
</div>:<div className="space-y-4">
          <Field label="Source files"><input id="mib-files" className="field-input h-auto" type="file" multiple
            accept=".mib,.txt,.my"
            onChange={(e: ChangeEvent<HTMLInputElement>)=>{setFiles(Array.from(e.target.files||[]));setValidation(null);setCompileTargets([]);}} /></Field>
          <Field label="Source group" hint="Optional; uploaded group name stored by the backend."><input className="field-input" value={sourceGroup} onChange={e=>setSourceGroup(e.target.value)} /></Field>
          <Field label="Compile mode"><select className="field-input" value={compileMode} onChange={e=>setCompileMode(e.target.value)}>
            <option value="full">Full compile</option><option value="partial">Partial compile</option></select></Field>
          <p className="text-xs text-[var(--muted)]">{files.length} files selected. Validation does not contact remote MIB sources.</p>
          {compileMode === 'partial' && <div className="space-y-2 rounded-lg bg-[var(--surface-muted)] p-3">
            <p className="text-xs font-semibold">Partial compile targets</p>
            <p className="text-xs text-[var(--muted)]">Validate first to select ready modules. Without prior validation, the backend selects all dependency-ready modules automatically.</p>
            {((validation as { partial_compile?: { ready_mibs?: string[] } } | null)?.partial_compile?.ready_mibs || []).map(name =>
              <label key={name} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={compileTargets.includes(name)}
                  onChange={e=>setCompileTargets(old=>e.target.checked?[...old,name]:old.filter(x=>x!==name))} />
                {name}
              </label>)}
          </div>}
          <div className="flex flex-wrap gap-2"><button className="btn-secondary" disabled={!files.length||pending} onClick={()=>void validate()}><FileUp size={16}/> Validate</button>
            <button className="btn-primary" disabled={!files.length||pending} onClick={()=>void upload()}><FileUp size={16}/> Upload and compile</button></div>
          {validation != null && <details open><summary className="cursor-pointer text-sm font-semibold">Validation report</summary><JsonView data={validation}/></details>}
        </div>}
 </Dialog.Content></Dialog.Portal>
</Dialog.Root><Dialog.Root open={modal==='maintenance'} onOpenChange={open=>{if(!pending)setModal(open?'maintenance':null);}}>
 <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/55"/>
 <Dialog.Content className="manager-modal fixed left-1/2 top-1/2 z-50 w-[min(43rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-2xl">
   <div className="flex items-center justify-between gap-3">
     <Dialog.Title className="text-lg font-semibold">Reload & dependencies</Dialog.Title>
     <Dialog.Close disabled={pending} className="btn-secondary btn-icon-action" aria-label="Close reload and dependencies"><X size={18}/></Dialog.Close>
   </div>
   <Dialog.Description className="mb-4 mt-1 text-xs text-[var(--muted)]">Recompile stored sources, or fetch missing online dependencies.</Dialog.Description>
   <div className="space-y-4">
          <button className="btn-secondary" disabled={pending} onClick={()=>setConfirm('reload')}><RotateCcw size={16}/> Recompile / reload stored MIBs</button>
          <Field label="Missing dependency names" hint="One module per line or comma; may fetch from configured remote sources."><textarea className="field-input h-24 font-mono text-xs" value={dependencies} onChange={e=>setDependencies(e.target.value)}/></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reloadAfterFetch} onChange={e=>setReloadAfterFetch(e.target.checked)}/> Reload after fetching</label>
          <button className="btn-secondary" disabled={!asList(dependencies).length||pending} onClick={()=>setConfirm('fetch')}><Download size={16}/> Fetch dependencies</button>
        </div>
 </Dialog.Content></Dialog.Portal>
</Dialog.Root>
    <ConfirmDialog open={confirm!==null} danger={confirm==='delete'} busy={pending} onCancel={()=>setConfirm(null)}
      onConfirm={()=>void runConfirm()} title={
        confirm==='delete'?'Delete selected MIB source files?':confirm==='activate'?'Activate compiled bundle #'+targetBundle+'?':
        confirm==='fetch'?'Fetch missing dependencies?':'Recompile the current MIB sources?'}
      message={confirm==='delete'?'Selected uploaded sources will be removed permanently, potentially changing the effective bundle.':
        confirm==='activate'?'The active MIB catalog will change for all connected operators; verify the diff first.':
        confirm==='fetch'?'This may contact configured remote MIB sources and optionally recompile the bundle.':'The backend will rebuild the active catalog from stored sources.'}/>
  </div>;
}

import { useMemo, useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { BookOpen, Send, ChevronDown, ChevronRight } from 'lucide-react';
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
  const [sortBy, setSortBy] = useState<'name'|'status'>('name');
  const [page, setPage] = useState(0);
  const [inspectSource, setInspectSource] = useState<string|null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sourceGroup, setSourceGroup] = useState('');
  const [compileMode, setCompileMode] = useState('full');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [validation, setValidation] = useState<unknown>(null);
  const [compileTargets, setCompileTargets] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<'reload'|'delete'|'activate'|'fetch'|null>(null);
  const [dependencies, setDependencies] = useState('');
  const [reloadAfterFetch, setReloadAfterFetch] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const { notify } = useNotifications();
  const [exportFormat, setExportFormat] = useState('json');
  const [exportType, setExportType] = useState('catalog');
  const [diffAgainst, setDiffAgainst] = useState<number | null>(null);
  const [targetBundle, setTargetBundle] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<'modules'|'sources'|'traps'>('sources');
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
  const all = activeTab === 'sources' ? status.data?.source_inventory || [] : status.data?.mibs || [];
  const shown = useMemo(() => all.filter(item =>
    (!groupFilter || item.source_group === groupFilter) &&
    (!statusFilter || (item.status||'active').toLowerCase() === statusFilter) &&
    (!query || [item.name,item.file,item.relative_path,item.source_group,item.status,item.error]
      .some(value=>value?.toLowerCase().includes(query.toLowerCase()))))
    .sort((a,b)=>String(a[sortBy]||'').localeCompare(String(b[sortBy]||''))), [all,query,groupFilter,statusFilter,sortBy]);
  const pageSize=75;
  const visible=shown.slice(page*pageSize,(page+1)*pageSize);
  const visibleSelectable=visible.filter(item=>activeTab==='sources' && item.deletable && (item.relative_path||item.file))
    .map(item=>item.relative_path||item.file||'');
  const deletable = selectedPaths.filter(path => status.data?.source_inventory?.some(row => row.deletable && (row.relative_path || row.file) === path));
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
      if (result) { setSelectedPaths([]); setLastResult(result); }
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
    <div className="workspace-stack">
      <Card title="Catalog & source inventory" description="Filter source files, loaded modules and notifications. Selection applies only to deletable uploaded sources.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Inventory views" className="flex flex-wrap gap-1 rounded-lg bg-[var(--surface-muted)] p-1">
            {(['sources','modules','traps'] as const).map(tab=><button type="button" key={tab}
              aria-pressed={activeTab===tab} className={activeTab===tab?'btn-primary':'btn-secondary'}
              onClick={()=>{setActiveTab(tab);setPage(0);setInspectSource(null);}}>
              {tab==='sources'?'Sources':tab==='modules'?'Modules':'Notifications'}
            </button>)}
          </div>
          <IconAction label="Refresh MIB inventory" onClick={()=>{void status.refetch();void bundles.refetch();}}><RefreshCw size={16}/></IconAction>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_auto]">
          <label className="relative min-w-0"><span className="sr-only">Search inventory</span>
            <input className="field-input pr-9" value={query} placeholder="Search module, file or status"
              onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
            <Search size={15} className="pointer-events-none absolute right-3 top-3 text-[var(--muted)]"/>
          </label>
          <label className="text-xs font-medium">Source group
            <select className="field-input mt-1" value={groupFilter} onChange={e=>{setGroupFilter(e.target.value);setPage(0);}}>
              <option value="">All groups</option>{status.data?.source_groups?.map(g=><option key={g.name} value={g.name}>{g.name} ({g.file_count})</option>)}
            </select>
          </label>
          <label className="text-xs font-medium">Status
            <select className="field-input mt-1" value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(0);}}>
              <option value="">All statuses</option>{['active','pending','failed','shadowed','error'].map(item=><option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium">Sort
            <select className="field-input mt-1" value={sortBy} onChange={e=>setSortBy(e.target.value as 'name'|'status')}>
              <option value="name">Name</option><option value="status">Status</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--muted)]">
          <span>{activeTab==='traps' ? (traps.data?.traps.length??'…')+' notifications' :
            shown.length+' of '+all.length+' records'} · {selectedPaths.length} selected</span>
          {activeTab==='sources' && <button type="button" className="btn-secondary" disabled={!visibleSelectable.length}
            onClick={()=>setSelectedPaths(old=>visibleSelectable.every(path=>old.includes(path)) ?
              old.filter(path=>!visibleSelectable.includes(path)) : [...new Set([...old,...visibleSelectable])])}>
              {visibleSelectable.length && visibleSelectable.every(path=>selectedPaths.includes(path))?'Deselect visible':'Select visible'}
            </button>}
        </div>
        <StatusText busy={status.isPending} error={status.error} empty={!status.isPending && !shown.length && activeTab !== 'traps'} />
        {activeTab === 'traps' ? <><StatusText busy={traps.isPending} error={traps.error} empty={!traps.isPending && !traps.data?.traps.length}/>
          <div className="manager-inventory-table overflow-auto rounded-lg border border-[var(--border)]"><table className="min-w-full text-left text-xs">
            <thead><tr><th className="p-2">Notification</th><th className="p-2">OID</th><th className="p-2">Use</th></tr></thead><tbody>
              {traps.data?.traps.filter(x=>!query||JSON.stringify(x).toLowerCase().includes(query.toLowerCase())).map(t=><tr key={t.oid} className="border-t border-[var(--border)]">
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
            <thead className="sticky top-0 bg-[var(--surface-muted)]"><tr><th className="p-2">Select</th><th className="p-2">Module / file</th><th className="p-2">Status</th><th className="p-2">Objects</th><th className="p-2">Traps</th></tr></thead>
            <tbody>{visible.map((item,i)=>{const path=item.relative_path || item.file || '';const open=inspectSource===(path||item.name);return <tr key={path+item.name+i}
              className="border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
              <td className="p-2">{activeTab==='sources'&&item.deletable&&path&&<input aria-label={'Select '+path} type="checkbox" checked={selectedPaths.includes(path)}
                onChange={e=>setSelectedPaths(old=>e.target.checked?[...old,path]:old.filter(p=>p!==path))}/>}</td>
              <td className="max-w-64 break-words p-2"><span className="font-semibold">{item.name}</span>
                <span className="block break-all font-mono text-[var(--muted)]">{path}</span>
                {item.source_group && <span className="block text-[var(--muted)]">{item.source_group}</span>}
                {item.error && <span className="block text-[var(--danger)]">{item.error}</span>}
                {(item.imports?.length || item.missing_deps?.length || item.active_relative_path) && <div className="mt-2">
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                    aria-expanded={open} onClick={()=>setInspectSource(open?null:(path||item.name))}>
                    {open?<ChevronDown size={14}/>:<ChevronRight size={14}/>} {open?'Hide source details':'Source details'}
                  </button>
                  {open&&<div className="mt-2 space-y-1 rounded-md border border-[var(--border)] p-2 text-xs">
                    {item.active_relative_path&&<p>Active path: <code className="break-all">{item.active_relative_path}</code></p>}
                    {!!item.imports?.length&&<p>Imports: {item.imports.join(', ')}</p>}
                    {!!item.missing_deps?.length&&<p className="text-[var(--danger)]">Missing: {item.missing_deps.join(', ')}</p>}
                  </div>}
                </div>}
                {activeTab === 'modules' && <Link className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                  to="/browser" onClick={() => sendToBrowser({ module: item.name })}>
                  <BookOpen size={13}/> Browse module
                </Link>}</td>
              <td className="p-2"><span className={'manager-status manager-status-'+(item.status||'active').toLowerCase()}>
                {item.status||'active'}</span></td><td className="p-2">{item.objects??'—'}</td><td className="p-2">{item.traps??'—'}</td>
            </tr>})}</tbody></table></div>}
        {activeTab!=='traps' && shown.length>pageSize && <div className="flex items-center justify-end gap-2 text-xs">
          <span>Page {page+1} of {Math.ceil(shown.length/pageSize)}</span>
          <button className="btn-secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous</button>
          <button className="btn-secondary" disabled={(page+1)*pageSize>=shown.length} onClick={()=>setPage(p=>p+1)}>Next</button>
        </div>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={!selectedPaths.length||downloading}
            onClick={()=>void download('/api/mibs/download',{paths:selectedPaths},'trishul-mib-sources.zip')}><Download size={16}/> Download selected ({selectedPaths.length})</button>
          <button className="btn-danger" disabled={!deletable.length||pending} onClick={()=>setConfirm('delete')}><Trash2 size={16}/> Delete selected ({deletable.length})</button>
        </div>
      </Card>
      <div className="manager-tools-grid">
        <Card title="Validate and upload" description="Validate without persisting; upload with explicit compile mode.">
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
        </Card>
        <Card title="Reload & dependencies" description="Reload recompiles the stored MIB collection.">
          <button className="btn-secondary" disabled={pending} onClick={()=>setConfirm('reload')}><RotateCcw size={16}/> Recompile / reload stored MIBs</button>
          <Field label="Missing dependency names" hint="One module per line or comma; may fetch from configured remote sources."><textarea className="field-input h-24 font-mono text-xs" value={dependencies} onChange={e=>setDependencies(e.target.value)}/></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reloadAfterFetch} onChange={e=>setReloadAfterFetch(e.target.checked)}/> Reload after fetching</label>
          <button className="btn-secondary" disabled={!asList(dependencies).length||pending} onClick={()=>setConfirm('fetch')}><Download size={16}/> Fetch dependencies</button>
        </Card>
        <Card title="Catalog export" description="Choose what to export, and the output format.">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Format"><select className="field-input" value={exportFormat} onChange={e=>setExportFormat(e.target.value)}><option value="json">JSON</option><option value="csv">CSV</option></select></Field>
            <Field label="Export type"><select className="field-input" value={exportType} onChange={e=>setExportType(e.target.value)}>
              <option value="catalog">Catalog</option><option value="notifications">Notifications</option></select></Field>
          </div>
          <button className="btn-secondary" disabled={downloading} onClick={()=>void download('/api/mibs/export',
            {format:exportFormat,export_type:exportType,modules:[],notifications:[],source_groups:groupFilter?[groupFilter]:[]},
            'trishul-mib-catalog.'+exportFormat)}><Download size={16}/> Export catalog</button>
        </Card>
      </div>
    </div>
    <Card title="Compiled bundle history" description="Compare revisions before activating a different compiled bundle.">
      <StatusText busy={bundles.isPending} error={bundles.error} empty={!bundles.isPending&&!bundles.data?.bundles.length}/>
      <Field label="Diff against" hint="Leave on active bundle to compare a candidate with the current effective bundle.">
        <select className="field-input max-w-xs" value={diffAgainst??''} onChange={e=>setDiffAgainst(e.target.value?Number(e.target.value):null)}>
          <option value="">Active bundle</option>{bundles.data?.bundles.map(b=><option key={b.id} value={b.id}>#{b.id} {b.label||b.bundle_key}</option>)}</select></Field>
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead><tr>
        <th className="p-3">Bundle</th><th className="p-3">State</th><th className="p-3">Modules</th><th className="p-3">Actions</th></tr></thead><tbody>
        {bundles.data?.bundles.map(b=><tr key={b.id} className="border-t border-[var(--border)]"><td className="p-3">
          #{b.id} · {b.label||b.bundle_key||'Bundle'}</td><td className="p-3">{bundles.data?.active_bundle_id===b.id?'Active':b.status||'Stored'}</td>
          <td className="p-3">{b.module_count??'—'}</td><td className="flex flex-wrap gap-2 p-2">
            <button className="btn-secondary" disabled={bundles.data?.active_bundle_id===b.id||diffAgainst===b.id}
              onClick={()=>void getDiff(b.id)}><GitCompareArrows size={15}/> Compare</button>
            <button className="btn-secondary" disabled={pending||bundles.data?.active_bundle_id===b.id}
              onClick={()=>{setTargetBundle(b.id);setConfirm('activate');}}>Activate / rollback</button>
          </td></tr>)}</tbody></table></div>
      {diffResult != null&&<details open><summary className="cursor-pointer text-sm font-semibold">Bundle difference</summary><JsonView data={diffResult}/></details>}
      {lastResult != null&&<details><summary className="cursor-pointer text-sm font-semibold">Last operation details</summary><JsonView data={lastResult}/></details>}
    </Card>
    <ConfirmDialog open={confirm!==null} danger={confirm==='delete'} busy={pending} onCancel={()=>setConfirm(null)}
      onConfirm={()=>void runConfirm()} title={
        confirm==='delete'?'Delete selected MIB source files?':confirm==='activate'?'Activate compiled bundle #'+targetBundle+'?':
        confirm==='fetch'?'Fetch missing dependencies?':'Recompile the current MIB sources?'}
      message={confirm==='delete'?'Selected uploaded sources will be removed permanently, potentially changing the effective bundle.':
        confirm==='activate'?'The active MIB catalog will change for all connected operators; verify the diff first.':
        confirm==='fetch'?'This may contact configured remote MIB sources and optionally recompile the bundle.':'The backend will rebuild the active catalog from stored sources.'}/>
  </div>;
}

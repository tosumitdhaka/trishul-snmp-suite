import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  FolderTree,
  GitCompare,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';
import { api } from '../lib/api';
import { formatRelativeTime } from '../lib/workbench';
import type {
  BundleDiffResponse,
  BundleRecord,
  MibSourceFile,
  MibStatusResponse,
  TrapCatalogItem,
} from '../types/api';
import { EmptyPane, SlideDrawer, StatusLabel } from '../components/UiPrimitives';

type MibTab = 'sources' | 'traps' | 'bundles';

interface ValidationFileResult {
  filename: string;
  safe_name: string;
  mib_name: string;
  valid: boolean;
  errors: string[];
  imports: string[];
  missing_deps: string[];
  will_replace: boolean;
  ready_for_partial: boolean;
}

interface ValidationBatchResponse {
  source_group: string;
  files: ValidationFileResult[];
  global_missing_deps: string[];
  can_upload: boolean;
  upload_blocked_reason: string;
  partial_compile?: {
    can_partial_compile: boolean;
    ready_count: number;
    ready_mibs: string[];
  };
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const MibsWorkspace: React.FC = () => {
  const { navigate, notify, confirm, refreshLiveState, mibSummary } = useWorkbench();

  const [activeTab, setActiveTab] = useState<MibTab>('sources');
  const [statusData, setStatusData] = useState<MibStatusResponse | null>(null);
  const [trapCatalog, setTrapCatalog] = useState<TrapCatalogItem[]>([]);
  const [bundles, setBundles] = useState<BundleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);

  // Sources filters & selection
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceGroupFilter, setSourceGroupFilter] = useState('');
  const [sourceScopeFilter, setSourceScopeFilter] = useState<'all' | 'bundled' | 'uploaded'>('all');
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [failedDrawerOpen, setFailedDrawerOpen] = useState(false);

  const toggleExpandModule = (key: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Upload drawer state
  const [uploadDrawerOpen, setUploadDrawerOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadGroup, setUploadGroup] = useState('custom');
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationBatchResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Traps tab & catalog exporter
  const [trapSearch, setTrapSearch] = useState('');
  const [trapModuleFilter, setTrapModuleFilter] = useState('');
  const [inspectedTrap, setInspectedTrap] = useState<TrapCatalogItem | null>(null);
  const [exportType, setExportType] = useState('catalog');
  const [exportGroup, setExportGroup] = useState('');
  const [exporting, setExporting] = useState(false);

  // Bundles diff drawer
  const [diffDrawerOpen, setDiffDrawerOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffData, setDiffData] = useState<BundleDiffResponse | null>(null);
  const [activatingId, setActivatingId] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, trapsRes, bundlesRes] = await Promise.all([
        api.getMibStatus(),
        api.getTrapCatalog(),
        api.listBundles(),
      ]);
      setStatusData(statusRes);
      setTrapCatalog(trapsRes.traps || []);
      setBundles(bundlesRes.bundles || []);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to load MIB catalog', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, mibSummary?.active_bundle_id]);

  // Combined module inventory (active + any non-active uploaded sources)
  const combinedSources = useMemo<MibSourceFile[]>(() => {
    if (!statusData) return [];
    const map = new Map<string, MibSourceFile>();
    for (const m of statusData.active_modules || statusData.mibs || []) {
      map.set(m.relative_path || `${m.source_group}/${m.file}`, m);
    }
    for (const s of statusData.source_inventory || []) {
      const key = s.relative_path || s.file;
      if (!map.has(key)) map.set(key, s);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [statusData]);

  const sourceGroupsList = useMemo(() => {
    const groups = new Set<string>();
    combinedSources.forEach((s) => {
      if (s.source_group) groups.add(s.source_group);
    });
    return Array.from(groups).sort();
  }, [combinedSources]);

  const filteredSources = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    return combinedSources.filter((s) => {
      if (sourceScopeFilter !== 'all' && s.source_kind !== sourceScopeFilter) return false;
      if (sourceGroupFilter && s.source_group !== sourceGroupFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.file.toLowerCase().includes(q) ||
        s.source_group.toLowerCase().includes(q)
      );
    });
  }, [combinedSources, sourceScopeFilter, sourceGroupFilter, sourceSearch]);

  const selectedRecords = useMemo(
    () => combinedSources.filter((s) => selectedPaths.has(s.relative_path || s.file)),
    [combinedSources, selectedPaths]
  );

  const deletableSelected = useMemo(
    () => selectedRecords.filter((s) => s.deletable),
    [selectedRecords]
  );

  const toggleSelect = (pathKey: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    const keys = filteredSources.map((s) => s.relative_path || s.file);
    const allSelected = keys.length > 0 && keys.every((k) => selectedPaths.has(k));
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(keys));
    }
  };

  // Validate uploaded batch automatically when files or group change
  const runValidation = useCallback(
    async (files: File[], group: string) => {
      if (files.length === 0) {
        setValidation(null);
        return;
      }
      setValidating(true);
      try {
        const res = (await api.validateMibBatch(files, group)) as unknown as ValidationBatchResponse;
        setValidation(res);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'MIB validation failed', 'error');
      } finally {
        setValidating(false);
      }
    },
    [notify]
  );

  const handleStageFiles = (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setPendingFiles(arr);
    setUploadDrawerOpen(true);
    void runValidation(arr, uploadGroup);
  };

  const handleCommitUpload = async (compileMode: 'full' | 'partial') => {
    if (pendingFiles.length === 0) return;
    setUploading(true);
    try {
      const targets =
        compileMode === 'partial' ? validation?.partial_compile?.ready_mibs || [] : undefined;
      await api.uploadMibs(pendingFiles, {
        sourceGroup: uploadGroup.trim() || 'custom',
        compileMode,
        compileTargets: targets,
      });
      notify(`Uploaded and compiled ${pendingFiles.length} MIB file(s)`, 'success');
      setPendingFiles([]);
      setValidation(null);
      setUploadDrawerOpen(false);
      await Promise.all([loadAll(), refreshLiveState()]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'MIB upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await api.reloadMibs();
      notify('MIB bundle recompiled and activated', 'success');
      await Promise.all([loadAll(), refreshLiveState()]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'MIB reload failed', 'error');
    } finally {
      setReloading(false);
    }
  };

  const handleDownloadSelected = async () => {
    const paths = selectedRecords.map((s) => s.relative_path || s.file);
    if (paths.length === 0) return;
    try {
      const { blob, filename } = await api.downloadMibSources(paths);
      triggerBlobDownload(blob, filename);
      notify(`Downloaded ${filename}`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Download failed', 'error');
    }
  };

  const handleDeleteSelected = async () => {
    if (deletableSelected.length === 0) return;
    const ok = await confirm({
      title: `Delete ${deletableSelected.length} uploaded MIB source(s)?`,
      message:
        'Bundled starter MIBs are protected and will remain intact. Deleting uploaded sources triggers an immediate bundle recompile.',
      confirmLabel: 'Delete & Recompile',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      const paths = deletableSelected.map((s) => s.relative_path || s.file);
      await api.deleteMibBatch(paths);
      setSelectedPaths(new Set());
      notify(`Deleted ${paths.length} uploaded MIB source(s)`, 'success');
      await Promise.all([loadAll(), refreshLiveState()]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to delete MIBs', 'error');
    }
  };

  const handleCatalogExport = async (
    format: 'json' | 'csv',
    overrides?: { modules?: string[]; notifications?: string[]; exportType?: string }
  ) => {
    setExporting(true);
    try {
      const { blob, filename } = await api.exportMibCatalog({
        format,
        export_type: overrides?.exportType || exportType,
        modules: overrides?.modules,
        notifications: overrides?.notifications,
        source_groups: exportGroup ? [exportGroup] : undefined,
      });
      triggerBlobDownload(blob, filename);
      notify(`Exported ${filename}`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleDiffBundle = async (bundle: BundleRecord) => {
    setDiffDrawerOpen(true);
    setDiffLoading(true);
    setDiffData(null);
    try {
      const res = await api.diffBundle(bundle.id);
      setDiffData(res);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Bundle diff failed', 'error');
      setDiffDrawerOpen(false);
    } finally {
      setDiffLoading(false);
    }
  };

  const handleActivateBundle = async (bundle: BundleRecord) => {
    const ok = await confirm({
      title: `Activate bundle #${bundle.id}?`,
      message: `Switch the active compiled catalog to "${bundle.label}" (${bundle.module_count} modules). The simulator datastore will rebuild automatically.`,
      confirmLabel: 'Activate Bundle',
      variant: 'primary',
    });
    if (!ok) return;
    setActivatingId(bundle.id);
    try {
      await api.activateBundle(bundle.id);
      notify(`Activated bundle #${bundle.id}`, 'success');
      await Promise.all([loadAll(), refreshLiveState()]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Bundle activation failed', 'error');
    } finally {
      setActivatingId(null);
    }
  };

  const trapModules = useMemo(
    () => Array.from(new Set(trapCatalog.map((t) => t.module))).sort(),
    [trapCatalog]
  );

  const filteredTraps = useMemo(() => {
    const q = trapSearch.trim().toLowerCase();
    return trapCatalog.filter((t) => {
      if (trapModuleFilter && t.module !== trapModuleFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.full_name.toLowerCase().includes(q) ||
        t.oid.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    });
  }, [trapCatalog, trapSearch, trapModuleFilter]);

  const failedList = statusData?.failed_modules || statusData?.errors || [];

  return (
    <div className="p-4 lg:p-6 max-w-[1600px] mx-auto space-y-4">
      {/* Header Summary & Tabs Strip */}
      <div className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="MIB Manager sections"
          className="inline-flex items-center p-0.5 rounded-lg bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sources'}
            onClick={() => setActiveTab('sources')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'sources'
                ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Sources ({combinedSources.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'traps'}
            onClick={() => setActiveTab('traps')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'traps'
                ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            Trap Library ({trapCatalog.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'bundles'}
            onClick={() => setActiveTab('bundles')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'bundles'
                ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
            }`}
          >
            <Package className="w-3.5 h-3.5" />
            Bundles ({bundles.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {failedList.length > 0 && (
            <button
              type="button"
              onClick={() => setFailedDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)]"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              {failedList.length} Failed
            </button>
          )}
          <button
            type="button"
            onClick={handleReload}
            disabled={reloading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${reloading ? 'animate-spin' : ''}`} />
            Reload MIBs
          </button>
          <button
            type="button"
            onClick={() => setUploadDrawerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)]"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload MIBs
          </button>
        </div>
      </div>

      {/* SOURCES TAB */}
      {activeTab === 'sources' && (
        <div className="space-y-4">
          {/* Drag-and-Drop Strip */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              if (e.dataTransfer.files?.length) {
                handleStageFiles(e.dataTransfer.files);
              }
            }}
            className={`rounded-xl border border-dashed px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 transition-colors ${
              dragActive
                ? 'border-[var(--tui-brand)] bg-[var(--tui-brand-soft)]'
                : 'border-[var(--tui-border-strong)] bg-[var(--tui-bg-surface)]'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)] flex items-center justify-center text-[var(--tui-brand)] shrink-0">
                <FileCode2 className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                  Drop vendor SMI MIB files here (
                  <code className="px-1 py-0.5 rounded bg-[var(--tui-bg-muted)] text-[11px]">.mib</code>,{' '}
                  <code className="px-1 py-0.5 rounded bg-[var(--tui-bg-muted)] text-[11px]">.txt</code>,{' '}
                  <code className="px-1 py-0.5 rounded bg-[var(--tui-bg-muted)] text-[11px]">.my</code>)
                </p>
                <p className="text-[11px] text-[var(--tui-ink-muted)]">
                  Active bundle: <span className="font-mono">{statusData?.active_bundle_label || 'Bundled Starter MIBs'}</span> ·{' '}
                  {statusData?.loaded ?? 0} loaded modules · {trapCatalog.length} trap definitions
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
            >
              Choose Files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".mib,.txt,.my"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) handleStageFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* Sources Filter & Batch Actions Bar */}
          <div className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
            <div className="p-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={sourceSearch}
                  onChange={(e) => setSourceSearch(e.target.value)}
                  placeholder="Filter modules by name, filename, or group..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>

              <select
                value={sourceScopeFilter}
                onChange={(e) => setSourceScopeFilter(e.target.value as 'all' | 'bundled' | 'uploaded')}
                aria-label="Filter by source scope"
                className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
              >
                <option value="all">All Scopes</option>
                <option value="bundled">Bundled Starter</option>
                <option value="uploaded">Uploaded Custom</option>
              </select>

              <select
                value={sourceGroupFilter}
                onChange={(e) => setSourceGroupFilter(e.target.value)}
                aria-label="Filter by source group"
                className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
              >
                <option value="">All Groups</option>
                {sourceGroupsList.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>

              {selectedRecords.length > 0 && (
                <div className="flex items-center gap-1.5 ml-auto">
                  <span className="text-[11px] font-mono text-[var(--tui-ink-muted)] mr-1">
                    {selectedRecords.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCatalogExport('json', {
                        modules: selectedRecords.map((r) => r.name),
                        exportType: 'catalog',
                      })
                    }
                    className="px-2 py-1.5 text-[11px] font-medium rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] cursor-pointer"
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDownloadSelected()}
                    className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    Source
                  </button>
                  {deletableSelected.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteSelected()}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded-md border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] hover:brightness-95 dark:hover:brightness-110 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete ({deletableSelected.length})
                    </button>
                  )}
                </div>
              )}
            </div>

            {loading ? (
              <div className="py-12 flex items-center justify-center gap-2 text-xs text-[var(--tui-ink-muted)]">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
                Loading MIB sources...
              </div>
            ) : filteredSources.length === 0 ? (
              <EmptyPane
                icon={<Layers className="w-5 h-5" />}
                title="No MIB sources match filters"
                description="Try clearing the search or scope filters, or upload new vendor MIB files."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[10px] font-mono uppercase tracking-wider text-[var(--tui-ink-muted)]">
                    <tr>
                      <th className="w-9 px-3 py-2.5 text-left">
                        <input
                          type="checkbox"
                          checked={
                            filteredSources.length > 0 &&
                            filteredSources.every((s) => selectedPaths.has(s.relative_path || s.file))
                          }
                          onChange={toggleSelectAllFiltered}
                          aria-label="Select all visible MIBs"
                          className="accent-[var(--tui-brand)]"
                        />
                      </th>
                      <th className="w-7 px-1 py-2.5" aria-label="Expand metadata" />
                      <th className="px-3 py-2.5 text-left">Module</th>
                      <th className="px-3 py-2.5 text-left">Source File</th>
                      <th className="px-3 py-2.5 text-left">Group / Origin</th>
                      <th className="px-3 py-2.5 text-right">Objects</th>
                      <th className="px-3 py-2.5 text-right">Traps</th>
                      <th className="px-3 py-2.5 text-left">Status</th>
                      <th className="px-3 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--tui-border-subtle)]">
                    {filteredSources.map((src) => {
                      const pathKey = src.relative_path || src.file;
                      const checked = selectedPaths.has(pathKey);
                      const isExpanded = expandedModules.has(pathKey);
                      const meta = src.module_metadata;
                      const hasDetails = Boolean(
                        meta?.organization ||
                          meta?.last_updated ||
                          meta?.contact_info ||
                          meta?.description ||
                          (meta?.revisions && meta.revisions.length > 0) ||
                          (src.imports && src.imports.length > 0)
                      );
                      return (
                        <React.Fragment key={pathKey}>
                          <tr
                            className={`transition-colors ${
                              checked ? 'bg-[var(--tui-brand-soft)]' : 'hover:bg-[var(--tui-bg-hover)]'
                            }`}
                          >
                            <td className="px-3 py-2.5">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSelect(pathKey)}
                                aria-label={`Select ${src.name}`}
                                className="accent-[var(--tui-brand)]"
                              />
                            </td>
                            <td className="px-1 py-2.5">
                              <button
                                type="button"
                                onClick={() => toggleExpandModule(pathKey)}
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? `Collapse ${src.name} metadata` : `Expand ${src.name} metadata`}
                                title="Inspect module metadata & imports"
                                className="w-6 h-6 rounded inline-flex items-center justify-center text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-muted)] cursor-pointer"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2.5 font-mono font-semibold text-[var(--tui-ink-primary)]">
                              <button
                                type="button"
                                onClick={() => toggleExpandModule(pathKey)}
                                className="hover:text-[var(--tui-brand)] transition-colors text-left cursor-pointer"
                              >
                                {src.name}
                              </button>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[var(--tui-ink-muted)]">
                              {src.file}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--tui-ink-secondary)]">
                              {src.source_group} · {src.source_kind}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[var(--tui-ink-primary)]">
                              {src.objects}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[var(--tui-ink-primary)]">
                              {src.traps}
                            </td>
                            <td className="px-3 py-2.5">
                              <StatusLabel
                                tone={
                                  src.status === 'active'
                                    ? 'success'
                                    : src.status === 'pending'
                                    ? 'warning'
                                    : 'danger'
                                }
                                label={src.status.toUpperCase()}
                              />
                            </td>
                            <td className="px-3 py-2.5 text-right whitespace-nowrap">
                              {src.status === 'active' && (
                                <button
                                  type="button"
                                  onClick={() => navigate('browser', { browseModule: src.name })}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] cursor-pointer"
                                >
                                  <FolderTree className="w-3 h-3 text-[var(--tui-brand)]" />
                                  <span>Browse</span>
                                </button>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-[var(--tui-bg-subtle)]">
                              <td colSpan={9} className="px-6 py-4">
                                {!hasDetails ? (
                                  <p className="text-xs text-[var(--tui-ink-muted)]">
                                    No SMI MODULE-IDENTITY metadata or IMPORTS recorded for {src.name}.
                                  </p>
                                ) : (
                                  <div className="space-y-3.5 text-xs">
                                    <dl className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <div className="p-2.5 rounded-lg bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)]">
                                        <dt className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">
                                          Organization
                                        </dt>
                                        <dd className="mt-1 text-[var(--tui-ink-primary)] font-medium">
                                          {meta?.organization || '—'}
                                        </dd>
                                      </div>
                                      <div className="p-2.5 rounded-lg bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)]">
                                        <dt className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">
                                          Last Updated
                                        </dt>
                                        <dd className="mt-1 font-mono text-[var(--tui-ink-primary)]">
                                          {meta?.last_updated || '—'}
                                        </dd>
                                      </div>
                                      <div className="p-2.5 rounded-lg bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)]">
                                        <dt className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">
                                          Contact Info
                                        </dt>
                                        <dd className="mt-1 text-[var(--tui-ink-secondary)] whitespace-pre-wrap break-words">
                                          {meta?.contact_info || '—'}
                                        </dd>
                                      </div>
                                    </dl>

                                    {src.imports && src.imports.length > 0 && (
                                      <div>
                                        <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1.5">
                                          Imported Modules ({src.imports.length})
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                          {src.imports.map((imp) => (
                                            <span
                                              key={imp}
                                              className="px-2 py-0.5 rounded font-mono text-[11px] bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
                                            >
                                              {imp}
                                            </span>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {meta?.description && (
                                      <div>
                                        <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1">
                                          Description
                                        </div>
                                        <p className="p-2.5 rounded-lg bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] leading-relaxed whitespace-pre-wrap">
                                          {meta.description}
                                        </p>
                                      </div>
                                    )}

                                    {meta?.revisions && meta.revisions.length > 0 && (
                                      <div>
                                        <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1.5">
                                          Revisions ({meta.revisions.length})
                                        </div>
                                        <div className="border border-[var(--tui-border-default)] rounded-lg bg-[var(--tui-bg-surface)] divide-y divide-[var(--tui-border-subtle)]">
                                          {meta.revisions.map((rev, idx) => (
                                            <div key={`${rev.date}-${idx}`} className="px-3 py-2 flex flex-col sm:flex-row sm:items-start gap-2">
                                              <span className="font-mono text-[11px] font-semibold text-[var(--tui-brand)] shrink-0 sm:w-36">
                                                {rev.date}
                                              </span>
                                              <span className="text-[var(--tui-ink-secondary)] leading-relaxed">
                                                {rev.description}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TRAP LIBRARY & EXPORTS TAB */}
      {activeTab === 'traps' && (
        <div className="space-y-4">
          {/* Scoped Catalog Exporter Bar */}
          <div className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Scoped Catalog Exporter
              </h3>
              <p className="text-[11px] text-[var(--tui-ink-muted)]">
                Download structured MIB objects, modules, or notification definitions directly from the active bundle.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={exportType}
                onChange={(e) => setExportType(e.target.value)}
                aria-label="Export dataset type"
                className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
              >
                <option value="catalog">Full Catalog</option>
                <option value="modules">Modules Only</option>
                <option value="objects">All Objects</option>
                <option value="notifications">Notifications</option>
                <option value="notification-members">Notification Members</option>
                <option value="summary">Summary Only</option>
              </select>
              <select
                value={exportGroup}
                onChange={(e) => setExportGroup(e.target.value)}
                aria-label="Export source group filter"
                className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
              >
                <option value="">All Source Groups</option>
                {sourceGroupsList.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={exporting}
                onClick={() => void handleCatalogExport('json')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] disabled:opacity-50 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                JSON
              </button>
              <button
                type="button"
                disabled={exporting}
                onClick={() => void handleCatalogExport('csv')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] disabled:opacity-50 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                CSV
              </button>
            </div>
          </div>

          {/* Notification Catalog Table */}
          <div className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
            <div className="p-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={trapSearch}
                  onChange={(e) => setTrapSearch(e.target.value)}
                  placeholder="Search notifications by name, OID, or description..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>
              <select
                value={trapModuleFilter}
                onChange={(e) => setTrapModuleFilter(e.target.value)}
                aria-label="Filter notifications by module"
                className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
              >
                <option value="">All Modules ({trapModules.length})</option>
                {trapModules.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            {filteredTraps.length === 0 ? (
              <EmptyPane
                icon={<Bell className="w-5 h-5" />}
                title="No notifications found"
                description="No compiled TRAP-TYPE or NOTIFICATION-TYPE entries match your current filter."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[10px] font-mono uppercase tracking-wider text-[var(--tui-ink-muted)]">
                    <tr>
                      <th className="px-3.5 py-2.5 text-left">Notification</th>
                      <th className="px-3.5 py-2.5 text-left">Numeric OID</th>
                      <th className="px-3.5 py-2.5 text-right">VarBinds</th>
                      <th className="px-3.5 py-2.5 text-left">Description</th>
                      <th className="px-3.5 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--tui-border-subtle)]">
                    {filteredTraps.map((trap) => (
                      <tr
                        key={trap.full_name}
                        onClick={() => setInspectedTrap(trap)}
                        className="hover:bg-[var(--tui-bg-hover)] cursor-pointer transition-colors"
                      >
                        <td className="px-3.5 py-2.5 font-mono font-semibold text-[var(--tui-ink-primary)] whitespace-nowrap">
                          {trap.full_name}
                        </td>
                        <td className="px-3.5 py-2.5 font-mono text-[var(--tui-ink-muted)] tabular-nums whitespace-nowrap">
                          {trap.oid}
                        </td>
                        <td className="px-3.5 py-2.5 text-right font-mono tabular-nums text-[var(--tui-ink-secondary)]">
                          {trap.objects.length}
                        </td>
                        <td className="px-3.5 py-2.5 text-[var(--tui-ink-secondary)] max-w-md truncate">
                          {trap.description || '—'}
                        </td>
                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate('traps', {
                                trapOid: trap.oid,
                                trapFullName: trap.full_name,
                              });
                            }}
                            className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--tui-brand-soft)] border border-[var(--tui-brand-border)] text-[var(--tui-brand-ink)] hover:brightness-95 dark:hover:brightness-110 cursor-pointer"
                          >
                            Use in Traps
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* BUNDLES TAB */}
      {activeTab === 'bundles' && (
        <div className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Compiled Bundle Timeline
              </h3>
              <p className="text-[11px] text-[var(--tui-ink-muted)]">
                Every MIB reload, upload, or deletion snapshots an immutable compiled bundle for diffing and instant rollback.
              </p>
            </div>
            <span className="text-[11px] font-mono text-[var(--tui-ink-muted)] tabular-nums">
              {bundles.length} snapshot{bundles.length === 1 ? '' : 's'}
            </span>
          </div>

          {bundles.length === 0 ? (
            <EmptyPane
              icon={<Package className="w-5 h-5" />}
              title="No compiled bundles yet"
              description="Reload or upload MIB files to create a versioned bundle snapshot."
            />
          ) : (
            <div className="divide-y divide-[var(--tui-border-subtle)]">
              {bundles.map((bundle) => (
                <div
                  key={bundle.id}
                  className="px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 hover:bg-[var(--tui-bg-hover)] transition-colors"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs font-bold text-[var(--tui-ink-primary)]">
                        #{bundle.id} · {bundle.label}
                      </span>
                      {bundle.is_active ? (
                        <StatusLabel tone="success" label="ACTIVE" liveDot />
                      ) : (
                        <StatusLabel tone="neutral" label="SNAPSHOT" />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-[var(--tui-ink-muted)]">
                      <span>{bundle.bundle_key}</span>
                      <span>·</span>
                      <span className="tabular-nums">{bundle.module_count} modules</span>
                      <span>·</span>
                      <span>sha256:{bundle.content_hash.slice(0, 12)}</span>
                      <span>·</span>
                      <span>{formatRelativeTime(bundle.created_at)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {!bundle.is_active && (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleDiffBundle(bundle)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
                        >
                          <GitCompare className="w-3.5 h-3.5" />
                          Diff vs Active
                        </button>
                        <button
                          type="button"
                          disabled={activatingId === bundle.id}
                          onClick={() => void handleActivateBundle(bundle)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-50"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          {activatingId === bundle.id ? 'Activating...' : 'Activate'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* UPLOAD & VALIDATE DRAWER */}
      <SlideDrawer
        open={uploadDrawerOpen}
        onClose={() => setUploadDrawerOpen(false)}
        title="Upload & Validate MIB Files"
        subtitle="Pre-flight dependency check before compiling into the active bundle"
        footer={
          <>
            <button
              type="button"
              onClick={() => setUploadDrawerOpen(false)}
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
            >
              Cancel
            </button>
            {validation?.partial_compile?.can_partial_compile && (
              <button
                type="button"
                disabled={uploading}
                onClick={() => void handleCommitUpload('partial')}
                className="px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--tui-warning-border)] bg-[var(--tui-warning-soft)] text-[var(--tui-warning-ink)] disabled:opacity-50"
              >
                Partial Compile ({validation.partial_compile.ready_count})
              </button>
            )}
            <button
              type="button"
              disabled={uploading || pendingFiles.length === 0 || (validation != null && !validation.can_upload)}
              onClick={() => void handleCommitUpload('full')}
              className="px-3.5 py-1.5 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-50"
            >
              {uploading ? 'Compiling...' : 'Upload & Compile'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1">
                Source Group
              </label>
              <input
                type="text"
                value={uploadGroup}
                onChange={(e) => {
                  setUploadGroup(e.target.value);
                  if (pendingFiles.length > 0) void runValidation(pendingFiles, e.target.value);
                }}
                placeholder="e.g. cisco, juniper, custom"
                className="w-full px-3 py-1.5 text-xs font-mono rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
              >
                {pendingFiles.length > 0
                  ? `Replace Selection (${pendingFiles.length} files)`
                  : 'Select MIB Files'}
              </button>
            </div>
          </div>

          {validating && (
            <div className="flex items-center gap-2 text-xs text-[var(--tui-ink-muted)] py-4">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
              Validating SMI headers & IMPORTS...
            </div>
          )}

          {validation && !validating && (
            <div className="space-y-3">
              {validation.upload_blocked_reason && (
                <div className="p-3 rounded-lg border border-[var(--tui-warning-border)] bg-[var(--tui-warning-soft)] text-xs text-[var(--tui-warning-ink)]">
                  {validation.upload_blocked_reason}
                </div>
              )}

              {validation.global_missing_deps.length > 0 && (
                <div className="p-3 rounded-lg border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] text-xs">
                  <div className="font-mono text-[10px] uppercase text-[var(--tui-ink-muted)] mb-1">
                    Missing Imported Modules
                  </div>
                  <div className="font-mono text-[var(--tui-danger-ink)]">
                    {validation.global_missing_deps.join(', ')}
                  </div>
                </div>
              )}

              <div className="divide-y divide-[var(--tui-border-subtle)] border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                {validation.files.map((f) => (
                  <div key={f.filename} className="p-3 text-xs space-y-1 bg-[var(--tui-bg-surface)]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-[var(--tui-ink-primary)] truncate">
                        {f.mib_name} ({f.filename})
                      </span>
                      <StatusLabel
                        tone={f.valid && f.missing_deps.length === 0 ? 'success' : 'danger'}
                        label={f.valid && f.missing_deps.length === 0 ? 'READY' : 'BLOCKED'}
                      />
                    </div>
                    {f.errors.length > 0 && (
                      <p className="text-[11px] text-[var(--tui-danger-ink)]">{f.errors.join(' ')}</p>
                    )}
                    {f.missing_deps.length > 0 && (
                      <p className="text-[11px] font-mono text-[var(--tui-warning-ink)]">
                        Missing: {f.missing_deps.join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SlideDrawer>

      {/* FAILED MIBS DRAWER */}
      <SlideDrawer
        open={failedDrawerOpen}
        onClose={() => setFailedDrawerOpen(false)}
        title={`Failed MIB Sources (${failedList.length})`}
        subtitle="Uploaded MIBs with syntax errors or unresolved dependencies"
      >
        {failedList.length === 0 ? (
          <EmptyPane
            icon={<CheckCircle2 className="w-5 h-5" />}
            title="All MIB sources compiled cleanly"
            description="No failed or broken MIB modules were reported."
          />
        ) : (
          <div className="space-y-3">
            {failedList.map((f) => (
              <div
                key={f.relative_path || f.file}
                className="p-3 rounded-lg border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] space-y-1"
              >
                <div className="text-xs font-mono font-semibold text-[var(--tui-danger-ink)]">
                  {f.name} · {f.file}
                </div>
                {f.error && <p className="text-xs text-[var(--tui-ink-primary)]">{f.error}</p>}
                {f.missing_deps && f.missing_deps.length > 0 && (
                  <p className="text-[11px] font-mono text-[var(--tui-ink-secondary)]">
                    Missing imports: {f.missing_deps.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </SlideDrawer>

      {/* TRAP DETAIL DRAWER */}
      <SlideDrawer
        open={inspectedTrap != null}
        onClose={() => setInspectedTrap(null)}
        title={inspectedTrap?.full_name || 'Trap Definition'}
        subtitle={inspectedTrap?.oid}
        footer={
          inspectedTrap && (
            <>
              <button
                type="button"
                onClick={() =>
                  void handleCatalogExport('json', {
                    notifications: [inspectedTrap.full_name],
                    exportType: 'notifications',
                  })
                }
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
              >
                Export JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = inspectedTrap;
                  setInspectedTrap(null);
                  navigate('traps', { trapOid: target.oid, trapFullName: target.full_name });
                }}
                className="px-3.5 py-1.5 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)]"
              >
                Compose Trap
              </button>
            </>
          )
        }
      >
        {inspectedTrap && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-xs text-[var(--tui-ink-secondary)] leading-relaxed whitespace-pre-wrap">
              {inspectedTrap.description || 'No description provided.'}
            </div>
            <div>
              <h4 className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[var(--tui-ink-muted)] mb-2">
                Payload VarBinds ({inspectedTrap.objects.length})
              </h4>
              {inspectedTrap.objects.length === 0 ? (
                <p className="text-xs text-[var(--tui-ink-muted)]">No required varbind objects defined.</p>
              ) : (
                <div className="border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                  <table className="w-full text-xs font-mono">
                    <thead className="bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[10px] uppercase text-[var(--tui-ink-muted)]">
                      <tr>
                        <th className="px-3 py-2 text-left">Object</th>
                        <th className="px-3 py-2 text-left">OID</th>
                        <th className="px-3 py-2 text-left">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--tui-border-subtle)]">
                      {inspectedTrap.objects.map((o) => (
                        <tr key={o.full_name}>
                          <td className="px-3 py-2 text-[var(--tui-ink-primary)]">{o.full_name}</td>
                          <td className="px-3 py-2 text-[var(--tui-ink-muted)] tabular-nums">{o.oid}</td>
                          <td className="px-3 py-2 text-[var(--tui-ink-secondary)]">{o.syntax || o.input_type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </SlideDrawer>

      {/* BUNDLE DIFF DRAWER */}
      <SlideDrawer
        open={diffDrawerOpen}
        onClose={() => setDiffDrawerOpen(false)}
        title="Bundle Diff Comparison"
        subtitle={
          diffData
            ? `#${diffData.left_bundle.id} (${diffData.left_bundle.label}) vs Active #${diffData.right_bundle.id}`
            : 'Comparing compiled bundle contents'
        }
      >
        {diffLoading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-xs text-[var(--tui-ink-muted)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
            Computing structural diff...
          </div>
        ) : diffData?.identical ? (
          <EmptyPane
            icon={<CheckCircle2 className="w-5 h-5 text-[var(--tui-success)]" />}
            title="Bundles are identical"
            description={`Both bundles share identical compiled content hash ${diffData.hash?.slice(0, 16)}.`}
          />
        ) : diffData ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-3 gap-2">
              <div className="p-3 rounded-lg bg-[var(--tui-success-soft)] border border-[var(--tui-success-border)]">
                <div className="text-[10px] font-mono uppercase text-[var(--tui-success-ink)]">Added</div>
                <div className="text-lg font-mono font-bold text-[var(--tui-success-ink)] tabular-nums">
                  {diffData.modules_added?.length || 0}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[var(--tui-danger-soft)] border border-[var(--tui-danger-border)]">
                <div className="text-[10px] font-mono uppercase text-[var(--tui-danger-ink)]">Removed</div>
                <div className="text-lg font-mono font-bold text-[var(--tui-danger-ink)] tabular-nums">
                  {diffData.modules_removed?.length || 0}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[var(--tui-info-soft)] border border-[var(--tui-info-border)]">
                <div className="text-[10px] font-mono uppercase text-[var(--tui-info-ink)]">Modified</div>
                <div className="text-lg font-mono font-bold text-[var(--tui-info-ink)] tabular-nums">
                  {diffData.modules_changed?.length || 0}
                </div>
              </div>
            </div>

            {diffData.modules_added && diffData.modules_added.length > 0 && (
              <div>
                <h4 className="font-mono text-[10px] uppercase text-[var(--tui-ink-muted)] mb-1.5">
                  Modules Added in Active
                </h4>
                <div className="space-y-1 font-mono">
                  {diffData.modules_added.map((m) => (
                    <div
                      key={m.module_name}
                      className="px-2.5 py-1.5 rounded bg-[var(--tui-success-soft)] text-[var(--tui-success-ink)]"
                    >
                      + {m.module_name} ({m.object_count ?? 0} objs)
                    </div>
                  ))}
                </div>
              </div>
            )}

            {diffData.modules_removed && diffData.modules_removed.length > 0 && (
              <div>
                <h4 className="font-mono text-[10px] uppercase text-[var(--tui-ink-muted)] mb-1.5">
                  Modules Removed in Active
                </h4>
                <div className="space-y-1 font-mono">
                  {diffData.modules_removed.map((m) => (
                    <div
                      key={m.module_name}
                      className="px-2.5 py-1.5 rounded bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)]"
                    >
                      - {m.module_name} ({m.object_count ?? 0} objs)
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </SlideDrawer>
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderTree,
  GitBranch,
  Layers,
  Loader2,
  Radar,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';
import { api } from '../lib/api';
import { downloadTextFile, normalizeEnums, toCsv } from '../lib/workbench';
import type { MibModuleTreeGroup, MibNodeRecord } from '../types/api';
import { EmptyPane, StatusLabel } from '../components/UiPrimitives';

type TreeMode = 'module' | 'oid';

const TYPE_OPTIONS = [
  { value: '', label: 'All Object Types' },
  { value: 'MibScalar', label: 'Scalar' },
  { value: 'MibTable', label: 'Table' },
  { value: 'MibTableRow', label: 'Table Row' },
  { value: 'MibTableColumn', label: 'Table Column' },
  { value: 'NotificationType', label: 'Notification / Trap' },
  { value: 'MibIdentifier', label: 'Identifier' },
];

const OID_ROOTS = [
  { oid: '1.3.6.1', label: 'internet (1.3.6.1)' },
  { oid: '1.3.6.1.2.1', label: 'mib-2 (1.3.6.1.2.1)' },
  { oid: '1.3.6.1.6', label: 'snmpV2 (1.3.6.1.6)' },
  { oid: '1.3.6.1.4.1', label: 'enterprises (1.3.6.1.4.1)' },
];

interface NodeDetailState {
  node: MibNodeRecord;
  breadcrumb: Array<{ oid: string; name: string; full_name: string; module: string }>;
  trapObjects: Array<{
    name: string;
    full_name: string;
    module: string;
    oid: string;
    syntax: string;
    input_type: string;
  }>;
}

function typeTagStyle(type: string): string {
  switch (type) {
    case 'NotificationType':
      return 'text-[var(--tui-warning-ink)] bg-[var(--tui-warning-soft)] border-[var(--tui-warning-border)]';
    case 'MibTable':
    case 'MibTableRow':
      return 'text-[var(--tui-info-ink)] bg-[var(--tui-info-soft)] border-[var(--tui-info-border)]';
    case 'MibScalar':
    case 'MibTableColumn':
      return 'text-[var(--tui-success-ink)] bg-[var(--tui-success-soft)] border-[var(--tui-success-border)]';
    default:
      return 'text-[var(--tui-ink-secondary)] bg-[var(--tui-bg-muted)] border-[var(--tui-border-default)]';
  }
}

function shortTypeLabel(type: string): string {
  switch (type) {
    case 'MibScalar':
      return 'SCALAR';
    case 'MibTable':
      return 'TABLE';
    case 'MibTableRow':
      return 'ROW';
    case 'MibTableColumn':
      return 'COL';
    case 'NotificationType':
      return 'TRAP';
    case 'MibIdentifier':
      return 'OID';
    default:
      return (type || 'NODE').toUpperCase().slice(0, 8);
  }
}

export const BrowserWorkspace: React.FC = () => {
  const { navigate, notify, mibSummary, handoff, clearHandoff } = useWorkbench();

  const [mode, setMode] = useState<TreeMode>('module');
  const [modulesList, setModulesList] = useState<Array<{ name: string; objects: number; notifications: number }>>([]);
  const [moduleFilter, setModuleFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [oidRoot, setOidRoot] = useState('1.3.6.1.2.1');

  const [moduleGroups, setModuleGroups] = useState<MibModuleTreeGroup[]>([]);
  const [oidChildren, setOidChildren] = useState<MibNodeRecord[]>([]);
  const [oidDescendants, setOidDescendants] = useState(0);
  const [searchResults, setSearchResults] = useState<MibNodeRecord[] | null>(null);

  const [expandedModules, setExpandedModules] = useState<Set<string>>(() => new Set(['SNMPv2-MIB', 'IF-MIB']));
  const [expandedOids, setExpandedOids] = useState<Record<string, MibNodeRecord[]>>({});
  const [loadingOids, setLoadingOids] = useState<Set<string>>(new Set());

  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const selectedKeyRef = useRef<string>('');
  const [detail, setDetail] = useState<NodeDetailState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadModulesList = useCallback(async () => {
    try {
      const res = await api.getBrowseModules();
      setModulesList(res.modules || []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void loadModulesList();
  }, [loadModulesList, mibSummary?.active_bundle_id]);

  const loadNodeDetail = useCallback(
    async (oidOrName: string, modName?: string) => {
      if (!oidOrName) return;
      const initialKey = `${modName || ''}::${oidOrName}`;
      selectedKeyRef.current = initialKey;
      setSelectedKey(initialKey);
      setDetailLoading(true);
      try {
        const res = await api.getBrowseNode(oidOrName, modName);
        if (res.node) {
          setDetail({
            node: res.node,
            breadcrumb: res.breadcrumb || [],
            trapObjects: res.trap_objects || [],
          });
          const resolvedKey = `${res.node.module}::${res.node.oid || res.node.full_name}`;
          selectedKeyRef.current = resolvedKey;
          setSelectedKey(resolvedKey);
          return;
        }
      } catch (err) {
        // If walking an instance OID (e.g. 1.3.6.1.2.1.1.1.0), retry with stripped instance suffix
        const trimmed = oidOrName.trim();
        if (/^\.?\d+(\.\d+){4,}$/.test(trimmed)) {
          const parentOid = trimmed.replace(/\.\d+$/, '');
          try {
            const fallback = await api.getBrowseNode(parentOid, modName);
            if (fallback.node) {
              setDetail({
                node: fallback.node,
                breadcrumb: fallback.breadcrumb || [],
                trapObjects: fallback.trap_objects || [],
              });
              const resolvedKey = `${fallback.node.module}::${fallback.node.oid || fallback.node.full_name}`;
              selectedKeyRef.current = resolvedKey;
              setSelectedKey(resolvedKey);
              return;
            }
          } catch {
            // fall through to original error
          }
        }
        notify(err instanceof Error ? err.message : 'Failed to load MIB node', 'error');
      } finally {
        setDetailLoading(false);
      }
    },
    [notify]
  );

  // Consume cross-workspace handoff (from Walker row inspect or MIB Manager Browse button)
  useEffect(() => {
    if (!handoff?.browseOid && !handoff?.browseModule) return;
    if (handoff.browseModule) {
      setMode('module');
      setSearchQuery('');
      setModuleFilter(handoff.browseModule);
      setExpandedModules((prev) => new Set([...prev, handoff.browseModule!]));
    }
    if (handoff.browseOid) {
      setSearchQuery('');
      void loadNodeDetail(handoff.browseOid, handoff.browseModule);
    }
    clearHandoff();
  }, [handoff, clearHandoff, loadNodeDetail]);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      if (mode === 'module') {
        const res = await api.getModuleTree(moduleFilter || undefined, typeFilter || undefined);
        const groups = res.modules || [];
        setModuleGroups(groups);
        if (groups.length > 0 && !selectedKeyRef.current && !handoff?.browseOid) {
          const firstNode = groups[0].children?.[0];
          if (firstNode) {
            setExpandedModules((prev) => new Set([...prev, groups[0].name]));
            void loadNodeDetail(firstNode.oid || firstNode.full_name, firstNode.module);
          }
        }
      } else {
        const res = await api.getOidTree(oidRoot, moduleFilter || undefined, typeFilter || undefined);
        setOidChildren(res.children || []);
        setOidDescendants(res.total_descendants || 0);
        if (res.children?.length && !selectedKeyRef.current && !handoff?.browseOid) {
          void loadNodeDetail(res.children[0].oid, res.children[0].module);
        }
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to load MIB tree', 'error');
    } finally {
      setTreeLoading(false);
    }
  }, [mode, moduleFilter, typeFilter, oidRoot, handoff?.browseOid, loadNodeDetail, notify]);

  useEffect(() => {
    if (searchQuery.trim()) return;
    setSearchResults(null);
    void loadTree();
  }, [loadTree, searchQuery, mibSummary?.active_bundle_id]);

  // Debounced live search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      setTreeLoading(true);
      try {
        const res = await api.searchBrowse(q, moduleFilter || undefined, typeFilter || undefined, 120);
        setSearchResults(res.results || []);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'MIB search failed', 'error');
      } finally {
        setTreeLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchQuery, moduleFilter, typeFilter, notify]);

  const toggleOidExpand = async (node: MibNodeRecord) => {
    if (!node.oid || !node.has_children) return;
    if (expandedOids[node.oid]) {
      setExpandedOids((prev) => {
        const copy = { ...prev };
        delete copy[node.oid];
        return copy;
      });
      return;
    }
    setLoadingOids((prev) => new Set(prev).add(node.oid));
    try {
      const res = await api.getOidTree(node.oid, moduleFilter || undefined, typeFilter || undefined);
      setExpandedOids((prev) => ({ ...prev, [node.oid]: res.children || [] }));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to expand OID subtree', 'error');
    } finally {
      setLoadingOids((prev) => {
        const next = new Set(prev);
        next.delete(node.oid);
        return next;
      });
    }
  };

  const toggleModuleGroup = (modName: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(modName)) next.delete(modName);
      else next.add(modName);
      return next;
    });
  };

  const expandAllModules = () => {
    setExpandedModules(new Set(moduleGroups.map((g) => g.name)));
  };

  const collapseAll = () => {
    setExpandedModules(new Set());
    setExpandedOids({});
  };

  const visibleNodesForExport = useMemo((): MibNodeRecord[] => {
    if (searchResults) return searchResults;
    if (mode === 'oid') {
      const flat: MibNodeRecord[] = [];
      const walk = (nodes: MibNodeRecord[]) => {
        for (const n of nodes) {
          flat.push(n);
          if (n.oid && expandedOids[n.oid]) walk(expandedOids[n.oid]);
        }
      };
      walk(oidChildren);
      return flat;
    }
    const flat: MibNodeRecord[] = [];
    const walk = (nodes: MibNodeRecord[]) => {
      for (const n of nodes) {
        flat.push(n);
        if (n.oid && expandedOids[n.oid]) walk(expandedOids[n.oid]);
      }
    };
    for (const g of moduleGroups) {
      walk(g.children || []);
    }
    return flat;
  }, [searchResults, mode, oidChildren, moduleGroups, expandedOids]);

  const handleExport = (format: 'json' | 'csv') => {
    if (visibleNodesForExport.length === 0) {
      notify('No visible MIB nodes to export', 'warning');
      return;
    }
    if (format === 'json') {
      downloadTextFile(
        `mib-browser-${Date.now()}.json`,
        JSON.stringify(visibleNodesForExport, null, 2),
        'application/json'
      );
    } else {
      const rows = visibleNodesForExport.map((n) => ({
        module: n.module,
        name: n.name,
        oid: n.oid,
        type: n.type,
        syntax: n.syntax || '',
        access: n.access || '',
        status: n.status || '',
        description: n.description || '',
      }));
      const csv = toCsv(rows, [
        { key: 'module', label: 'module' },
        { key: 'name', label: 'name' },
        { key: 'oid', label: 'oid' },
        { key: 'type', label: 'type' },
        { key: 'syntax', label: 'syntax' },
        { key: 'access', label: 'access' },
        { key: 'status', label: 'status' },
        { key: 'description', label: 'description' },
      ]);
      downloadTextFile(`mib-browser-${Date.now()}.csv`, csv, 'text/csv');
    }
    notify(`Exported ${visibleNodesForExport.length} MIB nodes (${format.toUpperCase()})`, 'success');
  };

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(`Copied ${label}`, 'success');
    } catch {
      notify('Clipboard access denied', 'error');
    }
  };

  const renderTreeNode = (node: MibNodeRecord, depth: number): React.ReactNode => {
    const key = `${node.module}::${node.oid || node.full_name}`;
    const isSelected = selectedKey === key || detail?.node.oid === node.oid && detail?.node.name === node.name;
    const isExpanded = Boolean(node.oid && expandedOids[node.oid]);
    const isLoading = Boolean(node.oid && loadingOids.has(node.oid));
    const children = (node.oid && expandedOids[node.oid]) || [];

    return (
      <div key={`${key}-${depth}`}>
        <div
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          className={`group flex items-center gap-1.5 pr-2.5 py-1.5 text-xs cursor-pointer border-b border-[var(--tui-border-subtle)] transition-colors ${
            isSelected
              ? 'bg-[var(--tui-brand-soft)] text-[var(--tui-ink-primary)]'
              : 'hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)]'
          }`}
          onClick={() => void loadNodeDetail(node.oid || node.full_name, node.module)}
        >
          <button
            type="button"
            disabled={!node.has_children}
            onClick={(e) => {
              e.stopPropagation();
              void toggleOidExpand(node);
            }}
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className={`w-4 h-4 flex items-center justify-center rounded shrink-0 ${
              node.has_children
                ? 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
                : 'opacity-0 pointer-events-none'
            }`}
          >
            {isLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>

          <span
            className={`px-1 py-0.5 text-[9px] font-mono font-semibold border rounded-[3px] shrink-0 ${typeTagStyle(
              node.type
            )}`}
          >
            {shortTypeLabel(node.type)}
          </span>

          <span className="font-mono font-medium truncate flex-1">{node.name}</span>
          <span className="font-mono text-[10px] text-[var(--tui-ink-soft)] tabular-nums shrink-0 hidden sm:inline">
            {node.oid}
          </span>
        </div>

        {isExpanded && children.map((child) => renderTreeNode(child, depth + 1))}
      </div>
    );
  };

  const activeEnums = useMemo(() => normalizeEnums(detail?.node.enums), [detail?.node.enums]);

  return (
    <div className="p-4 lg:p-6 max-w-[1600px] mx-auto space-y-4">
      {/* Control Strip */}
      <div className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl p-3 flex flex-wrap items-center gap-2.5">
        {/* Segmented Mode Toggle */}
        <div
          role="tablist"
          aria-label="Tree browsing mode"
          className="inline-flex items-center p-0.5 rounded-lg bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'module'}
            onClick={() => setMode('module')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
              mode === 'module'
                ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            By Module
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'oid'}
            onClick={() => setMode('oid')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
              mode === 'oid'
                ? 'bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] shadow-xs'
                : 'text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)]'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            By OID
          </button>
        </div>

        {/* Search Input */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-[var(--tui-ink-soft)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search OID, symbol, module, or description..."
            className="w-full pl-8 pr-7 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)] focus:outline-none focus:border-[var(--tui-brand)]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--tui-ink-soft)] hover:text-[var(--tui-ink-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Module Filter */}
        <select
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          aria-label="Filter by MIB module"
          className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
        >
          <option value="">All Modules ({modulesList.length})</option>
          {modulesList.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} ({m.objects + m.notifications})
            </option>
          ))}
        </select>

        {/* Type Filter */}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by object type"
          className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {mode === 'oid' && !searchResults && (
          <select
            value={oidRoot}
            onChange={(e) => {
              setOidRoot(e.target.value);
              setExpandedOids({});
            }}
            aria-label="Select root OID"
            className="px-2.5 py-1.5 text-xs font-mono rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
          >
            {OID_ROOTS.map((r) => (
              <option key={r.oid} value={r.oid}>
                {r.label}
              </option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          {mode === 'module' && !searchResults && (
            <>
              <button
                type="button"
                onClick={expandAllModules}
                className="px-2 py-1.5 text-[11px] font-medium rounded-md border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]"
              >
                Expand
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="px-2 py-1.5 text-[11px] font-medium rounded-md border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]"
              >
                Collapse
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => handleExport('json')}
            className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]"
          >
            <Download className="w-3 h-3" />
            JSON
          </button>
          <button
            type="button"
            onClick={() => handleExport('csv')}
            className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]"
          >
            <Download className="w-3 h-3" />
            CSV
          </button>
        </div>
      </div>

      {/* Split Explorer & Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left Tree Pane */}
        <section className="lg:col-span-5 xl:col-span-5 bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden flex flex-col h-[calc(100vh-190px)] min-h-[460px]">
          <div className="px-3.5 py-2.5 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-between text-[11px] font-mono text-[var(--tui-ink-muted)]">
            <span className="flex items-center gap-1.5 uppercase tracking-wider font-semibold">
              <FolderTree className="w-3.5 h-3.5 text-[var(--tui-brand)]" />
              {searchResults
                ? `Search Matches (${searchResults.length})`
                : mode === 'module'
                ? `MIB Modules (${moduleGroups.length})`
                : `OID Tree · ${oidRoot}`}
            </span>
            {mode === 'oid' && !searchResults && (
              <span className="tabular-nums">{oidDescendants} descendants</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {treeLoading ? (
              <div className="flex items-center justify-center py-16 text-xs text-[var(--tui-ink-muted)] gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
                Loading MIB hierarchy...
              </div>
            ) : searchResults ? (
              searchResults.length === 0 ? (
                <EmptyPane
                  icon={<Search className="w-5 h-5" />}
                  title="No matching MIB objects"
                  description={`Nothing matched "${searchQuery}". Try searching by OID prefix, symbol name, or clearing filters.`}
                />
              ) : (
                <div>
                  {searchResults.map((item) => {
                    const isSelected =
                      detail?.node.oid === item.oid && detail?.node.name === item.name;
                    return (
                      <button
                        key={`${item.module}::${item.name}::${item.oid}`}
                        type="button"
                        onClick={() => void loadNodeDetail(item.oid || item.full_name, item.module)}
                        className={`w-full text-left px-3 py-2 border-b border-[var(--tui-border-subtle)] flex items-center gap-2 transition-colors ${
                          isSelected
                            ? 'bg-[var(--tui-brand-soft)]'
                            : 'hover:bg-[var(--tui-bg-hover)]'
                        }`}
                      >
                        <span
                          className={`px-1 py-0.5 text-[9px] font-mono font-semibold border rounded-[3px] shrink-0 ${typeTagStyle(
                            item.type
                          )}`}
                        >
                          {shortTypeLabel(item.type)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-mono font-medium text-[var(--tui-ink-primary)] truncate">
                            {item.full_name}
                          </div>
                          <div className="text-[10px] font-mono text-[var(--tui-ink-soft)] truncate">
                            {item.oid}
                            {item.syntax ? ` · ${item.syntax}` : ''}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            ) : mode === 'module' ? (
              moduleGroups.length === 0 ? (
                <EmptyPane
                  icon={<Layers className="w-5 h-5" />}
                  title="No modules match filters"
                  description="Clear the module or object type filter to inspect the loaded MIB catalog."
                />
              ) : (
                <div>
                  {moduleGroups.map((group) => {
                    const open = expandedModules.has(group.name);
                    return (
                      <div key={group.name}>
                        <button
                          type="button"
                          onClick={() => toggleModuleGroup(group.name)}
                          className="w-full px-3 py-2 flex items-center justify-between gap-2 bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] border-b border-[var(--tui-border-default)] text-left transition-colors"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            {open ? (
                              <ChevronDown className="w-3.5 h-3.5 text-[var(--tui-ink-muted)] shrink-0" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-[var(--tui-ink-muted)] shrink-0" />
                            )}
                            <span className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] truncate">
                              {group.name}
                            </span>
                          </span>
                          <span className="text-[10px] font-mono text-[var(--tui-ink-muted)] tabular-nums shrink-0">
                            {group.object_count ?? group.children.length}
                          </span>
                        </button>
                        {open && (group.children || []).map((child) => renderTreeNode(child, 1))}
                      </div>
                    );
                  })}
                </div>
              )
            ) : oidChildren.length === 0 ? (
              <EmptyPane
                icon={<GitBranch className="w-5 h-5" />}
                title="No child OIDs found"
                description={`No MIB nodes exist directly under ${oidRoot} with the active filters.`}
              />
            ) : (
              <div>{oidChildren.map((child) => renderTreeNode(child, 0))}</div>
            )}
          </div>
        </section>

        {/* Right Object Inspector */}
        <section className="lg:col-span-7 xl:col-span-7 bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden flex flex-col min-h-[460px] lg:h-[calc(100vh-190px)]">
          {detailLoading ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[var(--tui-ink-muted)] gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
              Loading object definition...
            </div>
          ) : !detail ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyPane
                icon={<FolderTree className="w-5 h-5" />}
                title="Select a MIB Object"
                description="Click any object, table, or notification in the tree to inspect its SMI syntax, constraints, enumerations, and description."
              />
            </div>
          ) : (
            <>
              {/* Inspector Header */}
              <div className="px-5 py-4 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] space-y-2.5">
                {detail.breadcrumb.length > 0 && (
                  <nav aria-label="OID Breadcrumb" className="flex flex-wrap items-center gap-1 text-[11px] font-mono text-[var(--tui-ink-muted)]">
                    {detail.breadcrumb.map((b, idx) => (
                      <React.Fragment key={b.oid}>
                        {idx > 0 && <span className="text-[var(--tui-ink-soft)]">/</span>}
                        <button
                          type="button"
                          onClick={() => void loadNodeDetail(b.oid, b.module)}
                          className="hover:text-[var(--tui-brand)] transition-colors"
                        >
                          {b.name}
                        </button>
                      </React.Fragment>
                    ))}
                  </nav>
                )}

                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-mono font-bold text-[var(--tui-ink-primary)] break-all">
                        {detail.node.name}
                      </h2>
                      <StatusLabel
                        tone={detail.node.entry_type === 'notification' ? 'warning' : 'info'}
                        label={detail.node.type || 'Object'}
                      />
                    </div>
                    <p className="text-xs font-mono text-[var(--tui-ink-muted)] mt-1 break-all">
                      {detail.node.full_name}
                    </p>
                  </div>

                  {/* Cross-workspace handoffs */}
                  <div className="flex items-center gap-2 shrink-0">
                    {detail.node.oid && (
                      <button
                        type="button"
                        onClick={() => navigate('walker', { walkOid: detail.node.oid })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] transition-colors cursor-pointer"
                      >
                        <Radar className="w-3.5 h-3.5" />
                        Walk OID
                      </button>
                    )}
                    {detail.node.entry_type === 'notification' && (
                      <button
                        type="button"
                        onClick={() =>
                          navigate('traps', {
                            trapOid: detail.node.oid,
                            trapFullName: detail.node.full_name,
                          })
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--tui-brand-border)] bg-[var(--tui-brand-soft)] text-[var(--tui-brand-ink)] hover:brightness-95 dark:hover:brightness-110 transition-colors cursor-pointer"
                      >
                        <Bell className="w-3.5 h-3.5" />
                        Use in Traps
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Inspector Body */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                {/* OID & Symbol Copy Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--tui-ink-muted)]">
                        Numeric OID
                      </div>
                      <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] truncate mt-0.5 tabular-nums">
                        {detail.node.oid || '—'}
                      </div>
                    </div>
                    {detail.node.oid && (
                      <button
                        type="button"
                        onClick={() => void copyText(detail.node.oid, 'numeric OID')}
                        aria-label="Copy numeric OID"
                        className="p-1.5 rounded-md text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--tui-ink-muted)]">
                        Module :: Symbol
                      </div>
                      <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] truncate mt-0.5">
                        {detail.node.full_name}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyText(detail.node.full_name, 'symbolic name')}
                      aria-label="Copy symbolic name"
                      className="p-1.5 rounded-md text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)]"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* SMI Attributes Matrix */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[var(--tui-border-default)] border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                  <div className="bg-[var(--tui-bg-surface)] p-3">
                    <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">Syntax</div>
                    <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] mt-1 break-words">
                      {detail.node.syntax || '—'}
                    </div>
                  </div>
                  <div className="bg-[var(--tui-bg-surface)] p-3">
                    <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">Max Access</div>
                    <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] mt-1">
                      {detail.node.access || '—'}
                    </div>
                  </div>
                  <div className="bg-[var(--tui-bg-surface)] p-3">
                    <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">Status</div>
                    <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] mt-1">
                      {detail.node.status || '—'}
                    </div>
                  </div>
                  <div className="bg-[var(--tui-bg-surface)] p-3">
                    <div className="text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">Units</div>
                    <div className="text-xs font-mono font-semibold text-[var(--tui-ink-primary)] mt-1">
                      {detail.node.units || '—'}
                    </div>
                  </div>
                </div>

                {/* Indexes */}
                {detail.node.indexes && detail.node.indexes.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[var(--tui-ink-muted)] mb-2 flex items-center gap-1.5">
                      <Table2 className="w-3.5 h-3.5" />
                      Row Indexes
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.node.indexes.map((idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 text-xs font-mono rounded-md bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
                        >
                          {idx}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Constraints */}
                {detail.node.constraints != null && (
                  <div>
                    <h3 className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[var(--tui-ink-muted)] mb-2">
                      SMI Constraints
                    </h3>
                    <pre className="p-3 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-xs font-mono text-[var(--tui-ink-primary)] overflow-x-auto">
                      {JSON.stringify(detail.node.constraints, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Enumerations */}
                {activeEnums.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[var(--tui-ink-muted)] mb-2">
                      Enumerated Values ({activeEnums.length})
                    </h3>
                    <div className="border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                      <table className="w-full text-xs font-mono">
                        <thead className="bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[10px] uppercase text-[var(--tui-ink-muted)]">
                          <tr>
                            <th className="text-left px-3 py-2 w-24">Integer</th>
                            <th className="text-left px-3 py-2">Symbolic Label</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--tui-border-subtle)]">
                          {activeEnums.map((ev) => (
                            <tr key={`${ev.value}-${ev.label}`}>
                              <td className="px-3 py-1.5 font-semibold text-[var(--tui-brand)] tabular-nums">
                                {ev.value}
                              </td>
                              <td className="px-3 py-1.5 text-[var(--tui-ink-primary)]">{ev.label}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Trap / Notification Member Objects */}
                {detail.trapObjects.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[var(--tui-ink-muted)] mb-2">
                      Notification Payload Objects ({detail.trapObjects.length})
                    </h3>
                    <div className="border border-[var(--tui-border-default)] rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-[var(--tui-bg-subtle)] border-b border-[var(--tui-border-default)] text-[10px] font-mono uppercase text-[var(--tui-ink-muted)]">
                          <tr>
                            <th className="text-left px-3 py-2">Object</th>
                            <th className="text-left px-3 py-2">OID</th>
                            <th className="text-left px-3 py-2">Syntax</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--tui-border-subtle)] font-mono">
                          {detail.trapObjects.map((obj) => (
                            <tr
                              key={`${obj.full_name}-${obj.oid}`}
                              className="hover:bg-[var(--tui-bg-hover)] cursor-pointer"
                              onClick={() => obj.oid && void loadNodeDetail(obj.oid, obj.module)}
                            >
                              <td className="px-3 py-2 text-[var(--tui-brand)] font-medium">
                                {obj.full_name}
                              </td>
                              <td className="px-3 py-2 text-[var(--tui-ink-muted)] tabular-nums">
                                {obj.oid || '—'}
                              </td>
                              <td className="px-3 py-2 text-[var(--tui-ink-secondary)]">
                                {obj.syntax || obj.input_type}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <h3 className="text-[11px] font-mono uppercase tracking-wider font-semibold text-[var(--tui-ink-muted)] mb-2">
                    SMI Description
                  </h3>
                  <div className="p-3.5 rounded-lg bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-xs text-[var(--tui-ink-secondary)] leading-relaxed whitespace-pre-wrap">
                    {detail.node.description || 'No description provided in MIB module.'}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
};

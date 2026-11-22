import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  Bell,
  Database,
  ExternalLink,
  FolderTree,
  Moon,
  Play,
  RotateCcw,
  Route,
  Search,
  Server,
  Sliders,
  Square,
  Sun,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  filterPaletteItems,
  isNumericOid,
  stripLeadingOidDot,
  type PaletteItem,
} from '../lib/workbench';
import { useWorkbench } from '../context/WorkbenchContext';
import type { MibNodeRecord, WorkspaceId } from '../types/api';

interface CommandAction extends PaletteItem {
  icon: React.ReactNode;
  run: () => void;
}

export const CommandPalette: React.FC = () => {
  const {
    paletteOpen,
    setPaletteOpen,
    navigate,
    theme,
    toggleTheme,
    simulatorStatus,
    trapStatus,
    toggleSimulator,
    toggleTrapReceiver,
    notify,
    confirm,
    refreshLiveState,
  } = useWorkbench();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mibResults, setMibResults] = useState<MibNodeRecord[]>([]);
  const [searchingMibs, setSearchingMibs] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setMibResults([]);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [paletteOpen]);

  // Debounced live MIB search when query >= 2 chars (supports numeric OIDs and symbols)
  useEffect(() => {
    if (!paletteOpen) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setMibResults([]);
      setSearchingMibs(false);
      return;
    }
    let cancelled = false;
    setSearchingMibs(true);
    const timer = window.setTimeout(async () => {
      try {
        if (isNumericOid(trimmed)) {
          const cleanOid = stripLeadingOidDot(trimmed);
          const nodeRes = await api.getBrowseNode(cleanOid).catch(() => null);
          if (!cancelled) {
            setMibResults(nodeRes?.node ? [nodeRes.node] : []);
          }
        } else {
          const res = await api.searchBrowse(trimmed, undefined, undefined, 8);
          if (!cancelled) setMibResults(res.results || []);
        }
      } catch {
        if (!cancelled) setMibResults([]);
      } finally {
        if (!cancelled) setSearchingMibs(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [paletteOpen, query]);

  const baseActions = useMemo<CommandAction[]>(() => {
    const go = (ws: WorkspaceId) => () => {
      navigate(ws);
      setPaletteOpen(false);
    };

    const actions: CommandAction[] = [
      {
        id: 'nav-overview',
        label: 'Overview',
        hint: 'Command center & telemetry',
        group: 'Workspaces',
        keywords: ['dashboard', 'home', 'stats'],
        icon: <Activity className="w-4 h-4" />,
        run: go('overview'),
      },
      {
        id: 'nav-simulator',
        label: 'SNMP Simulator',
        hint: 'Responder lifecycle & custom OID overrides',
        group: 'Workspaces',
        keywords: ['agent', 'udp', 'logs'],
        icon: <Server className="w-4 h-4" />,
        run: go('simulator'),
      },
      {
        id: 'nav-walker',
        label: 'Walk & Parse',
        hint: 'Execute SNMP walks and export tables',
        group: 'Workspaces',
        keywords: ['walk', 'getnext', 'json', 'csv'],
        icon: <Route className="w-4 h-4" />,
        run: go('walker'),
      },
      {
        id: 'nav-traps',
        label: 'Traps Console',
        hint: 'Send traps/informs, capture notifications, decode BER',
        group: 'Workspaces',
        keywords: ['receiver', 'inform', 'ber', 'decode'],
        icon: <Bell className="w-4 h-4" />,
        run: go('traps'),
      },
      {
        id: 'nav-browser',
        label: 'MIB Browser',
        hint: 'Explore module & OID hierarchy',
        group: 'Workspaces',
        keywords: ['tree', 'oid', 'enums', 'syntax'],
        icon: <FolderTree className="w-4 h-4" />,
        run: go('browser'),
      },
      {
        id: 'nav-mibs',
        label: 'MIB Manager',
        hint: 'Upload sources, diff bundles, rollback',
        group: 'Workspaces',
        keywords: ['bundle', 'upload', 'compile', 'export'],
        icon: <Database className="w-4 h-4" />,
        run: go('mibs'),
      },
      {
        id: 'nav-settings',
        label: 'Settings',
        hint: 'Credentials, runtime defaults, metadata',
        group: 'Workspaces',
        keywords: ['auth', 'password', 'timeout'],
        icon: <Sliders className="w-4 h-4" />,
        run: go('settings'),
      },
      {
        id: 'act-sim-toggle',
        label: simulatorStatus?.running ? 'Stop SNMP Simulator' : 'Start SNMP Simulator',
        hint: `UDP ${simulatorStatus?.port || 1161}`,
        group: 'Quick Actions',
        keywords: ['simulator', 'start', 'stop', 'responder'],
        icon: simulatorStatus?.running ? (
          <Square className="w-4 h-4 text-[var(--tui-danger)]" />
        ) : (
          <Play className="w-4 h-4 text-[var(--tui-success)]" />
        ),
        run: async () => {
          setPaletteOpen(false);
          try {
            await toggleSimulator();
          } catch (err) {
            notify(err instanceof Error ? err.message : 'Simulator action failed', 'error');
          }
        },
      },
      {
        id: 'act-trap-toggle',
        label: trapStatus?.running ? 'Stop Trap Receiver' : 'Start Trap Receiver',
        hint: `UDP ${trapStatus?.port || 1162}`,
        group: 'Quick Actions',
        keywords: ['trap', 'receiver', 'listener', 'start', 'stop'],
        icon: trapStatus?.running ? (
          <Square className="w-4 h-4 text-[var(--tui-danger)]" />
        ) : (
          <Play className="w-4 h-4 text-[var(--tui-success)]" />
        ),
        run: async () => {
          setPaletteOpen(false);
          try {
            await toggleTrapReceiver();
          } catch (err) {
            notify(err instanceof Error ? err.message : 'Trap receiver action failed', 'error');
          }
        },
      },
      {
        id: 'act-theme',
        label: theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode',
        hint: 'Synced with Classic UI',
        group: 'Quick Actions',
        keywords: ['theme', 'dark', 'light', 'appearance'],
        icon: theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />,
        run: () => {
          toggleTheme();
          setPaletteOpen(false);
        },
      },
      {
        id: 'act-reset-stats',
        label: 'Reset Activity Counters',
        hint: 'Zero simulator, walk, and trap counters',
        group: 'Quick Actions',
        keywords: ['clear', 'counters', 'metrics'],
        icon: <RotateCcw className="w-4 h-4" />,
        run: async () => {
          setPaletteOpen(false);
          const ok = await confirm({
            title: 'Reset all activity counters?',
            message: 'This clears cumulative SNMP request, walk, trap, and reload statistics.',
            confirmLabel: 'Reset Counters',
          });
          if (!ok) return;
          try {
            await api.resetStats();
            await refreshLiveState();
            notify('Activity counters reset.', 'success');
          } catch (err) {
            notify(err instanceof Error ? err.message : 'Reset failed', 'error');
          }
        },
      },
      {
        id: 'act-classic',
        label: 'Switch to Classic UI',
        hint: 'Open legacy interface at /',
        group: 'Quick Actions',
        keywords: ['legacy', 'classic', 'old'],
        icon: <ExternalLink className="w-4 h-4" />,
        run: () => {
          window.location.href = '/';
        },
      },
    ];
    return actions;
  }, [
    navigate,
    setPaletteOpen,
    simulatorStatus,
    trapStatus,
    theme,
    toggleTheme,
    toggleSimulator,
    toggleTrapReceiver,
    notify,
    confirm,
    refreshLiveState,
  ]);

  const combinedItems = useMemo<CommandAction[]>(() => {
    const filtered = filterPaletteItems(baseActions, query);
    const dynamicMibs: CommandAction[] = mibResults.map((node) => ({
      id: `mib-${node.oid}-${node.full_name}`,
      label: node.full_name,
      hint: `${node.oid}${node.syntax ? ` · ${node.syntax}` : ''}`,
      group: node.entry_type === 'notification' ? 'Notifications (MIB Catalog)' : 'OIDs (MIB Catalog)',
      icon:
        node.entry_type === 'notification' ? (
          <Bell className="w-4 h-4 text-[var(--tui-warning)]" />
        ) : (
          <FolderTree className="w-4 h-4 text-[var(--tui-info)]" />
        ),
      run: () => {
        if (node.entry_type === 'notification') {
          navigate('traps', { trapOid: node.oid, trapFullName: node.full_name });
        } else {
          navigate('walker', { walkOid: node.oid });
        }
        setPaletteOpen(false);
      },
    }));
    return [...filtered, ...dynamicMibs];
  }, [baseActions, query, mibResults, navigate, setPaletteOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, mibResults.length]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (combinedItems.length ? (i + 1) % combinedItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) =>
        combinedItems.length ? (i - 1 + combinedItems.length) % combinedItems.length : 0
      );
    } else if (e.key === 'Enter' && combinedItems[selectedIndex]) {
      e.preventDefault();
      combinedItems[selectedIndex].run();
    }
  };

  // Group items preserving order
  const groups: Array<{ name: string; items: Array<{ action: CommandAction; globalIndex: number }> }> = [];
  combinedItems.forEach((action, idx) => {
    let g = groups.find((x) => x.name === action.group);
    if (!g) {
      g = { name: action.group, items: [] };
      groups.push(g);
    }
    g.items.push({ action, globalIndex: idx });
  });

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[65] bg-[var(--tui-backdrop)] backdrop-blur-[2px]" />
        <Dialog.Content
          onKeyDown={handleSearchKeyDown}
          className="fixed left-1/2 top-[12vh] -translate-x-1/2 z-[65] w-[calc(100%-2rem)] max-w-xl rounded-xl bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] shadow-2xl overflow-hidden"
        >
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Jump to workspaces, execute quick actions, or search MIB OIDs and notifications.
          </Dialog.Description>

          <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--tui-border-default)]">
            <Search className="w-4 h-4 text-[var(--tui-ink-muted)] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Jump to workspace, run an action, or search MIB OIDs (e.g. sysDescr, 1.3.6.1)..."
              aria-label="Command palette search"
              className="flex-1 bg-transparent px-1 py-0.5 rounded text-sm text-[var(--tui-ink-primary)] placeholder:text-[var(--tui-ink-soft)]"
            />
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-[var(--tui-border-default)] text-[var(--tui-ink-muted)]">
              ESC
            </kbd>
          </div>

          <div className="max-h-[380px] overflow-y-auto py-2">
            {groups.length === 0 ? (
              <div className="py-10 text-center text-xs text-[var(--tui-ink-muted)]">
                {searchingMibs ? 'Searching MIB catalog...' : 'No matching commands or OIDs.'}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.name} className="mb-2 last:mb-0">
                  <div className="px-4 py-1 text-[11px] font-semibold text-[var(--tui-ink-muted)]">
                    {group.name}
                  </div>
                  {group.items.map(({ action, globalIndex }) => {
                    const active = globalIndex === selectedIndex;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                        onClick={action.run}
                        className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-left text-xs transition-colors cursor-pointer ${
                          active
                            ? 'bg-[var(--tui-brand-soft)] text-[var(--tui-ink-primary)]'
                            : 'text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span className="text-[var(--tui-ink-muted)] shrink-0">{action.icon}</span>
                          <span className="font-medium text-[var(--tui-ink-primary)] truncate">
                            {action.label}
                          </span>
                        </span>
                        {action.hint && (
                          <span className="font-mono text-[11px] text-[var(--tui-ink-muted)] truncate max-w-[230px]">
                            {action.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="px-4 py-2 border-t border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-between text-[11px] text-[var(--tui-ink-muted)]">
            <span>OIDs open in Walker · Notifications open in Traps</span>
            <span className="font-mono">↑↓ Navigate · ↵ Select</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

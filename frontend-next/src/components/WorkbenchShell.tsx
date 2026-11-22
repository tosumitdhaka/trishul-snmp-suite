import React, { useEffect, useState } from 'react';
import {
  Activity,
  Bell,
  Command,
  Database,
  ExternalLink,
  FolderTree,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Server,
  Sliders,
  Sun,
  X,
} from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';
import type { WorkspaceId } from '../types/api';
import { StatusLabel, TrishulMark } from './UiPrimitives';

interface NavEntry {
  id: WorkspaceId;
  label: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavEntry[] = [
  { id: 'overview', label: 'Overview', subtitle: 'Live runtimes & telemetry', icon: Activity },
  { id: 'simulator', label: 'Simulator', subtitle: 'SNMP responder & custom OIDs', icon: Server },
  { id: 'walker', label: 'Walk & Parse', subtitle: 'Walk agents & inspect parsed trees', icon: Route },
  { id: 'traps', label: 'Traps', subtitle: 'Send traps/informs, receive & decode BER', icon: Bell },
  { id: 'browser', label: 'MIB Browser', subtitle: 'Explore active catalog by module or OID', icon: FolderTree },
  { id: 'mibs', label: 'MIB Manager', subtitle: 'Upload sources, diff bundles & exports', icon: Database },
  { id: 'settings', label: 'Settings', subtitle: 'Credentials, runtime defaults & metadata', icon: Sliders },
];

const RAIL_STORAGE_KEY = 'trishul_rail_expanded';

export const WorkbenchShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    meta,
    theme,
    toggleTheme,
    username,
    logout,
    activeWorkspace,
    navigate,
    setPaletteOpen,
    wsStatus,
    simulatorStatus,
    trapStatus,
  } = useWorkbench();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggleRail = () => {
    setRailExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  // Keyboard shortcut '[' to toggle sidebar expansion when not typing in an input
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target as HTMLElement | null)?.isContentEditable) {
        return;
      }
      e.preventDefault();
      toggleRail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const currentNav = NAV_ITEMS.find((n) => n.id === activeWorkspace) || NAV_ITEMS[0];

  return (
    <div className="h-screen w-full flex overflow-hidden bg-[var(--tui-bg-canvas)] text-[var(--tui-ink-primary)]">
      {/* Desktop Expandable Obsidian Rail (64px compact <-> 224px expanded) */}
      <aside
        aria-label="Primary workspaces"
        data-expanded={railExpanded ? 'true' : 'false'}
        className={`hidden md:flex shrink-0 flex-col justify-between py-3 bg-[var(--tui-rail-bg)] border-r border-[var(--tui-rail-border)] select-none transition-[width] duration-200 ease-out ${
          railExpanded ? 'w-56' : 'w-16'
        }`}
      >
        <div className="flex flex-col gap-3 w-full">
          {/* Brand Row + Expand/Collapse Control */}
          <div
            className={`flex items-center px-3 ${
              railExpanded ? 'justify-between gap-2' : 'justify-center'
            }`}
          >
            <button
              type="button"
              onClick={() => navigate('overview')}
              title={`Trishul SNMP Suite v${meta?.version || '2.2.4'}`}
              aria-label="Trishul Overview"
              className={`flex items-center gap-2.5 min-w-0 rounded-lg transition-colors cursor-pointer ${
                railExpanded ? 'py-1 pr-2 hover:bg-[var(--tui-rail-hover)]' : ''
              }`}
            >
              <span className="w-10 h-10 shrink-0 rounded-lg bg-[var(--tui-brand-soft)] border border-[var(--tui-brand-border)] flex items-center justify-center hover:brightness-95 dark:hover:brightness-110 transition-all">
                <TrishulMark className="w-6 h-6" />
              </span>
              {railExpanded && (
                <div className="min-w-0 text-left">
                  <div className="text-xs font-bold tracking-tight text-[var(--tui-rail-ink-strong)] truncate">
                    Trishul
                  </div>
                  <div className="text-[10px] font-mono text-[var(--tui-brand)] truncate">
                    v{meta?.version || '2.2.4'} · Next
                  </div>
                </div>
              )}
            </button>

            {railExpanded && (
              <button
                type="button"
                onClick={toggleRail}
                title="Collapse sidebar ([)"
                aria-label="Collapse sidebar"
                className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)] hover:bg-[var(--tui-rail-hover)] transition-colors cursor-pointer"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            )}
          </div>

          <nav
            className={`flex flex-col gap-1 w-full mt-1 ${railExpanded ? 'px-2.5' : 'px-2 items-center'}`}
            aria-label="Workspace navigation"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeWorkspace;
              const isSimLive = item.id === 'simulator' && simulatorStatus?.running;
              const isTrapLive = item.id === 'traps' && trapStatus?.running;
              const isLiveDot = isSimLive || isTrapLive;
              const livePort = isSimLive
                ? `:${simulatorStatus?.port}`
                : isTrapLive
                ? `:${trapStatus?.port}`
                : null;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  title={railExpanded ? item.subtitle : item.label}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={`group relative rounded-lg flex items-center transition-colors cursor-pointer ${
                    railExpanded
                      ? 'w-full h-10 px-3 gap-3 justify-start'
                      : 'w-11 h-11 justify-center'
                  } ${
                    active
                      ? 'bg-[var(--tui-rail-active-bg)] text-[var(--tui-rail-active-ink)] font-semibold'
                      : 'text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)] hover:bg-[var(--tui-rail-hover)]'
                  }`}
                >
                  {active && (
                    <span
                      className={`absolute top-2 bottom-2 w-[3px] rounded-r bg-[var(--tui-brand)] ${
                        railExpanded ? '-left-2.5' : '-left-2'
                      }`}
                      aria-hidden="true"
                    />
                  )}
                  <Icon className="w-[18px] h-[18px] shrink-0" />
                  {railExpanded && (
                    <span className="text-xs font-medium truncate flex-1 text-left">{item.label}</span>
                  )}
                  {railExpanded && isLiveDot && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-[var(--tui-success-ink)] shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--tui-success)]" aria-hidden="true" />
                      {livePort}
                    </span>
                  )}
                  {!railExpanded && isLiveDot && (
                    <span
                      className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[var(--tui-success)]"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div
          className={`flex flex-col gap-1 w-full pt-2 border-t border-[var(--tui-rail-border)] ${
            railExpanded ? 'px-2.5' : 'px-2 items-center'
          }`}
        >
          {!railExpanded && (
            <button
              type="button"
              onClick={toggleRail}
              title="Expand sidebar ([)"
              aria-label="Expand sidebar"
              className="w-11 h-9 rounded-lg flex items-center justify-center text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)] hover:bg-[var(--tui-rail-hover)] transition-colors cursor-pointer"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          <a
            href="/"
            title="Switch to Classic UI"
            aria-label="Switch to Classic UI"
            className={`rounded-lg flex items-center text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)] hover:bg-[var(--tui-rail-hover)] transition-colors ${
              railExpanded ? 'w-full h-9 px-3 gap-3 text-xs font-medium' : 'w-11 h-9 justify-center'
            }`}
          >
            <ExternalLink className="w-4 h-4 shrink-0" />
            {railExpanded && <span className="truncate">Classic UI</span>}
          </a>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            className={`rounded-lg flex items-center text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)] hover:bg-[var(--tui-rail-hover)] transition-colors cursor-pointer ${
              railExpanded ? 'w-full h-9 px-3 gap-3 text-xs font-medium' : 'w-11 h-9 justify-center'
            }`}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
            {railExpanded && <span className="truncate">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            title={`Sign out (${username})`}
            aria-label="Sign out"
            className={`rounded-lg flex items-center text-[var(--tui-rail-ink)] hover:text-[var(--tui-danger-ink)] hover:bg-[var(--tui-rail-hover)] transition-colors cursor-pointer ${
              railExpanded ? 'w-full h-9 px-3 gap-3 text-xs font-medium' : 'w-11 h-9 justify-center'
            }`}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {railExpanded && <span className="truncate">Sign Out ({username})</span>}
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/65 backdrop-blur-[2px]"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 w-64 h-full flex flex-col bg-[var(--tui-rail-bg)] text-[var(--tui-rail-ink-strong)] border-r border-[var(--tui-rail-border)]">
            <div className="h-14 px-4 flex items-center justify-between border-b border-[var(--tui-rail-border)]">
              <div className="flex items-center gap-2.5">
                <TrishulMark className="w-5 h-5" />
                <span className="text-sm font-bold tracking-tight">Trishul Workbench</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="p-1.5 text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-2.5 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeWorkspace;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      navigate(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-xs font-medium ${
                      active
                        ? 'bg-[var(--tui-rail-active-bg)] text-[var(--tui-rail-active-ink)] font-semibold'
                        : 'text-[var(--tui-rail-ink)] hover:text-[var(--tui-rail-ink-strong)] hover:bg-[var(--tui-rail-hover)]'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-[var(--tui-rail-border)] flex items-center justify-between text-xs">
              <a href="/" className="text-[var(--tui-rail-ink)] hover:text-[var(--tui-brand)] inline-flex items-center gap-1.5">
                <ExternalLink className="w-3.5 h-3.5" />
                Classic UI
              </a>
              <button
                type="button"
                onClick={() => void logout()}
                className="text-[var(--tui-danger-ink)] hover:underline inline-flex items-center gap-1"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Single-Row Architectural Command Topbar (52px) */}
        <header className="h-[52px] shrink-0 px-4 lg:px-6 flex items-center justify-between gap-4 bg-[var(--tui-bg-surface)] border-b border-[var(--tui-border-default)]">
          {/* Left: Contextual Breadcrumb */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="md:hidden p-1.5 rounded-md border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)]"
            >
              <Menu className="w-4 h-4" />
            </button>
            <span className="hidden sm:inline text-xs font-medium text-[var(--tui-ink-muted)] whitespace-nowrap">
              Trishul
            </span>
            <span className="hidden sm:inline text-[var(--tui-border-strong)] select-none">/</span>
            <h1 className="text-sm font-semibold tracking-tight text-[var(--tui-ink-primary)] whitespace-nowrap truncate">
              {currentNav.label}
            </h1>
            <span className="hidden xl:inline text-xs text-[var(--tui-ink-muted)] truncate">
              · {currentNav.subtitle}
            </span>
          </div>

          {/* Right: Command Palette Trigger + Live Status + Account */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="inline-flex items-center gap-2 h-8 px-2.5 sm:px-3 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] hover:bg-[var(--tui-bg-hover)] text-xs text-[var(--tui-ink-muted)] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Command className="w-3.5 h-3.5 text-[var(--tui-ink-soft)]" />
              <span className="hidden sm:inline">Search OIDs &amp; actions...</span>
              <kbd className="hidden sm:inline px-1.5 py-0.5 text-[10px] font-mono rounded bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)]">
                ⌘K
              </kbd>
            </button>

            <StatusLabel
              tone={wsStatus === 'online' ? 'success' : wsStatus === 'connecting' ? 'warning' : 'danger'}
              label={wsStatus === 'online' ? 'Live' : wsStatus === 'connecting' ? 'Connecting' : 'Offline'}
              liveDot
            />

            <a
              href="/"
              className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-secondary)] transition-colors whitespace-nowrap"
            >
              <span>Classic UI</span>
              <ExternalLink className="w-3 h-3" />
            </a>

            <button
              type="button"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-secondary)] hover:text-[var(--tui-ink-primary)] transition-colors cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => navigate('settings')}
              title={`Signed in as ${username}`}
              className="hidden lg:inline-flex items-center gap-2 h-8 px-2.5 rounded-md hover:bg-[var(--tui-bg-hover)] text-xs font-medium text-[var(--tui-ink-primary)] transition-colors cursor-pointer"
            >
              <span className="w-5 h-5 rounded-full bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)] flex items-center justify-center text-[10px] font-mono font-semibold uppercase">
                {username.slice(0, 1)}
              </span>
              <span className="max-w-[96px] truncate">{username}</span>
            </button>
          </div>
        </header>

        {/* Active Workspace Viewport */}
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
};

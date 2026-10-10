import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bell, Database, LayoutDashboard, LogOut, Menu, Moon, Network,
  Route as RouteIcon,
  Server, Settings, Sun, Wifi, WifiOff, X,
} from 'lucide-react';
import { Link, NavLink, useLocation } from 'react-router';
import trishulLogo from '../../assets/trishul-icon.svg';
import { workspaces, type Workspace } from '../../lib/navigation/workspaces';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { useTheme } from '../../lib/theme/ThemeProvider';
import { WorkspaceSearch } from './WorkspaceSearch';
import { NotificationCenter } from './NotificationCenter';

export const SIDEBAR_STORAGE_KEY = 'trishul_next_sidebar_collapsed';

export const DESKTOP_SIDEBAR_MEDIA_QUERY = '(min-width: 1024px)';

function getIsDesktopViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.(DESKTOP_SIDEBAR_MEDIA_QUERY).matches ?? window.innerWidth >= 1024;
}


export function getSavedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

const icons = {
  layout: LayoutDashboard, server: Server, route: RouteIcon, bell: Bell,
  network: Network, database: Database, settings: Settings,
};

function SidebarLinks({ collapsed = false, onNavigate }: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  let previousGroup = '';
  return (
    <nav aria-label="Workspaces" className={'space-y-1 py-4 ' + (collapsed ? 'px-2' : 'px-3')}>
      {workspaces.map((workspace) => {
        const Icon = icons[workspace.icon];
        const isNewGroup = workspace.group !== previousGroup;
        previousGroup = workspace.group;
        return (
          <div key={workspace.path}>
            {isNewGroup && (collapsed ? (
              <div className="mx-3 my-4 border-t border-[var(--border)]" aria-hidden="true" />
            ) : (
              <p className="px-3 pb-2 pt-5 text-[0.68rem] font-bold uppercase tracking-widest text-[var(--muted)] first:pt-1">
                {workspace.group}
              </p>
            ))}
            <NavLink
              to={workspace.path}
              end={workspace.path === '/'}
              onClick={onNavigate}
              title={collapsed ? workspace.label : undefined}
              aria-label={collapsed ? workspace.label : undefined}
              className={({ isActive }) => 'nav-item ' +
                (collapsed ? 'justify-center px-0 ' : '') +
                (isActive ? 'nav-item-active' : '')}
            >
              <Icon size={19} className="shrink-0" aria-hidden="true" />
              <span className={collapsed ? 'sr-only' : ''}>{workspace.label}</span>
            </NavLink>
          </div>
        );
      })}
    </nav>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" aria-label="Trishul SNMP Suite — Dashboard"
      className={'flex items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' +
        (compact ? 'justify-center p-1' : 'gap-3 p-2')}
      title={compact ? 'Trishul SNMP Suite' : undefined}>
      <img src={trishulLogo} alt="" aria-hidden="true"
        className="h-10 w-10 shrink-0 object-contain" width={40} height={40} />
      <span className={compact ? 'sr-only' : 'min-w-0 leading-tight'}>
        <strong className="block text-base font-bold">Trishul</strong>
        <span className="block whitespace-nowrap text-xs text-[var(--muted)]">SNMP Suite · Preview</span>
      </span>
    </Link>
  );
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(getSavedSidebarCollapsed);
  const [isDesktop, setIsDesktop] = useState(getIsDesktopViewport);
  const { auth, logout } = useAuth();
  const ws = useRealtime();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const active: Workspace = workspaces.find((item) => item.path === location.pathname) || workspaces[0];
  const connected = ws === 'live';

  useEffect(() => {
    const media = window.matchMedia?.(DESKTOP_SIDEBAR_MEDIA_QUERY);
    const syncViewport = () => {
      setIsDesktop(media?.matches ?? window.innerWidth >= 1024);
    };
    syncViewport();

    if (media?.addEventListener) {
      media.addEventListener('change', syncViewport);
      return () => media.removeEventListener('change', syncViewport);
    }
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    if (isDesktop) setMobileOpen(false);
  }, [isDesktop]);

  const navButtonLabel = isDesktop
    ? collapsed ? 'Expand sidebar' : 'Collapse sidebar'
    : mobileOpen ? 'Close menu' : 'Open menu';

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed)); }
    catch { /* The sidebar still works when localStorage is disabled. */ }
  }, [collapsed]);

  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--text)]">
      <a href="#main-content"
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-80 focus:not-sr-only focus:rounded-lg focus:bg-[var(--surface)] focus:p-3">
        Skip to main content
      </a>
      <aside id="desktop-sidebar" aria-label="Desktop sidebar"
        className={'fixed inset-y-0 left-0 hidden flex-col overflow-x-hidden border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-200 motion-reduce:transition-none lg:flex ' +
          (collapsed ? 'w-[4.75rem]' : 'w-64')}>
        <div className={'border-b border-[var(--border)] py-4 ' + (collapsed ? 'px-2' : 'px-4')}>
          <Brand compact={collapsed} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <SidebarLinks collapsed={collapsed} />
        </div>
        <div className={'border-t border-[var(--border)] py-4 text-center text-xs text-[var(--muted)] ' +
          (collapsed ? 'px-1' : 'px-4')}>
          {collapsed ? <span aria-label="Modern UI · Integration preview" title="Modern UI · Stage 2 preview">v2</span>
            : 'Modern UI · Integration preview'}
        </div>
      </aside>

      <Dialog.Root open={!isDesktop && mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/60" />
          <Dialog.Content id="mobile-navigation" className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,90vw)] flex-col overflow-hidden bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl focus:outline-none">
            <Dialog.Title className="sr-only">Navigate workspaces</Dialog.Title>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-4">
              <Brand />
              <Dialog.Close className="btn-secondary p-2" aria-label="Close menu">
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SidebarLinks onNavigate={() => setMobileOpen(false)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className={'min-w-0 transition-[padding] duration-200 motion-reduce:transition-none ' +
        (collapsed ? 'lg:pl-[4.75rem]' : 'lg:pl-64')}>
        <header className="sticky top-0 z-30 flex min-h-18 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 sm:px-7">
          <button
            className="btn-secondary shrink-0 p-2"
            type="button"
            aria-label={navButtonLabel}
            aria-pressed={isDesktop ? collapsed : undefined}
            aria-expanded={isDesktop ? !collapsed : mobileOpen}
            aria-controls={isDesktop ? 'desktop-sidebar' : 'mobile-navigation'}
            title={navButtonLabel}
            onClick={() => {
              if (isDesktop) setCollapsed((value) => !value);
              else setMobileOpen((value) => !value);
            }}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold leading-tight sm:text-lg">{active.label}</p>
            <p className="mt-0.5 hidden truncate text-xs text-[var(--muted)] sm:block">{active.description}</p>
          </div>
          <WorkspaceSearch />
          <NotificationCenter />
          <span className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold sm:inline-flex"
            role="status" aria-live="polite">
            {connected ? <Wifi size={15} className="text-[var(--success)]" aria-hidden="true" />
              : <WifiOff size={15} className="text-[var(--warning)]" aria-hidden="true" />}
            {connected ? 'Live updates' : 'WS: ' + ws}
          </span>
          <button className="btn-secondary p-2" type="button"
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
          </button>
          <button className="btn-secondary p-2 sm:px-3" type="button" onClick={() => void logout()} title="Log out">
            <LogOut size={17} aria-hidden="true" />
            <span className="hidden text-sm sm:inline">
              {auth.state === 'authenticated' ? auth.username : 'Log out'}
            </span>
          </button>
        </header>
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-7 sm:py-8">
          <div id="workspace-content">{children}</div>
        </main>
      </div>
    </div>
  );
}

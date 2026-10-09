import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Bell, Database, LayoutDashboard, LogOut, Menu, Moon, Network, Route as RouteIcon, Server, Settings, Sun, Wifi, WifiOff, X } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import { workspaces, type Workspace } from '../../lib/navigation/workspaces';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { useTheme } from '../../lib/theme/ThemeProvider';
import { WorkspaceSearch } from './WorkspaceSearch';

const icons = {
  layout: LayoutDashboard, server: Server, route: RouteIcon, bell: Bell,
  network: Network, database: Database, settings: Settings,
};

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  let previousGroup = '';
  return (
    <nav aria-label="Workspaces" className="space-y-1 px-3 py-4">
      {workspaces.map((workspace) => {
        const Icon = icons[workspace.icon];
        const groupLabel = workspace.group !== previousGroup;
        previousGroup = workspace.group;
        return (
          <div key={workspace.path}>
            {groupLabel && <p className="px-3 pb-2 pt-5 text-[0.68rem] font-bold uppercase tracking-widest text-[var(--muted)] first:pt-1">{workspace.group}</p>}
            <NavLink to={workspace.path} end={workspace.path === '/'} onClick={onNavigate}
              className={({ isActive }) => 'nav-item ' + (isActive ? 'nav-item-active' : '')}>
              <Icon size={18} aria-hidden="true" />
              <span>{workspace.label}</span>
            </NavLink>
          </div>
        );
      })}
    </nav>
  );
}

function Brand() {
  return <a href="/next/" className="flex items-center gap-3 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-white"><Network size={23} aria-hidden="true" /></span>
    <span className="leading-tight"><strong className="block text-base font-bold">Trishul</strong><span className="block text-xs text-[var(--muted)]">SNMP Suite · Preview</span></span>
  </a>;
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { auth, logout } = useAuth();
  const ws = useRealtime();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const active: Workspace = workspaces.find((item) => item.path === location.pathname) || workspaces[0];
  const connected = ws === 'live';
  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--text)]">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="border-b border-[var(--border)] px-4 py-4"><Brand /></div>
        <div className="min-h-0 flex-1 overflow-y-auto"><SidebarLinks /></div>
        <div className="border-t border-[var(--border)] px-5 py-4 text-xs text-[var(--muted)]">Modern UI · Stage 2 preview</div>
      </aside>
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/60" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,90vw)] flex-col overflow-hidden bg-[var(--surface)] p-0 shadow-2xl focus:outline-none">
            <Dialog.Title className="sr-only">Navigate workspaces</Dialog.Title>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-4">
              <Brand />
              <Dialog.Close className="btn-secondary p-2" aria-label="Close menu"><X size={18} aria-hidden="true" /></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto"><SidebarLinks onNavigate={() => setMobileOpen(false)} /></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-30 flex min-h-18 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 sm:px-7">
          <button className="btn-secondary p-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold leading-tight sm:text-lg">{active.label}</p>
            <p className="mt-0.5 hidden truncate text-xs text-[var(--muted)] sm:block">{active.description}</p>
          </div>
          <WorkspaceSearch />
          <span className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold sm:inline-flex"
            role="status" aria-live="polite">
            {connected ? <Wifi size={15} className="text-[var(--success)]" aria-hidden="true" />
              : <WifiOff size={15} className="text-[var(--warning)]" aria-hidden="true" />}
            {connected ? 'Live updates' : 'WS: ' + ws}
          </span>
          <button className="btn-secondary p-2" type="button" aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
          </button>
          <button className="btn-secondary p-2 sm:px-3" type="button" onClick={() => void logout()} title="Log out">
            <LogOut size={17} aria-hidden="true" />
            <span className="hidden text-sm sm:inline">{auth.state === 'authenticated' ? auth.username : 'Log out'}</span>
          </button>
        </header>
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-7 sm:py-8">
          <a className="sr-only focus:not-sr-only" href="#workspace-content">Skip workspace navigation</a>
          <div id="workspace-content">{children}</div>
        </main>
      </div>
    </div>
  );
}

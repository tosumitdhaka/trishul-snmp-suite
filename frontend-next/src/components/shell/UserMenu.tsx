import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '../../lib/auth/AuthProvider';

/** A compact, keyboard-accessible account menu without a direct logout action in the header. */
export function UserMenu() {
  const { auth, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    const first = root.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
    if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false); trigger.current?.focus(); return;
    }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || !items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }
  return <div className="relative shrink-0" ref={root}>
    <button ref={trigger} type="button" className="header-icon-button user-menu-trigger gap-1"
      aria-label="User menu" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? 'trishul-user-menu' : undefined}
      title="Account" onClick={() => setOpen(value => !value)}>
      <UserRound size={20} aria-hidden="true"/>
      <ChevronDown size={13} aria-hidden="true" className="hidden sm:block"/>
    </button>
    {open && <div id="trishul-user-menu" role="menu" aria-label="Account actions"
      className="user-menu-panel absolute right-0 top-[calc(100%+.6rem)] z-50 min-w-52 space-y-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text)] shadow-xl"
      onKeyDown={keyDown}>
      <div className="border-b border-[var(--border)] px-3 py-2">
        <p className="text-[0.68rem] uppercase tracking-wide text-[var(--muted)]">Signed in as</p>
        <p className="mt-1 max-w-44 truncate text-sm font-semibold">{auth.state === 'authenticated' ? auth.username : 'Operator'}</p>
      </div>
      <Link role="menuitem" to="/settings" className="user-menu-item" onClick={() => setOpen(false)}>
        <Settings size={16} aria-hidden="true"/> Settings
      </Link>
      <button role="menuitem" type="button" className="user-menu-item w-full text-left" onClick={() => { setOpen(false); void logout(); }}>
        <LogOut size={16} aria-hidden="true"/> Log out
      </button>
    </div>}
  </div>;
}

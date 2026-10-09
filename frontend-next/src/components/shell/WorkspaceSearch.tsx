import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, Command, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { workspaces, type Workspace } from '../../lib/navigation/workspaces';

const synonyms: Record<Workspace['path'], string> = {
  '/': 'home health overview counters stats',
  '/simulator': 'server responder agent logs configuration',
  '/walker': 'snmpwalk walk parse target oid export',
  '/traps': 'alerts notification inform replay listener',
  '/browser': 'mib oid tree resolve search schemas',
  '/mibs': 'mib upload sources bundle rollback dependency export',
  '/settings': 'user login credentials preferences account',
};

export function searchWorkspaces(input: string): readonly Workspace[] {
  const words = input.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return workspaces;
  return workspaces.filter((page) => {
    const text = (page.label + ' ' + page.description + ' ' + page.group + ' ' + synonyms[page.path])
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function WorkspaceSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const matching = searchWorkspaces(query);
  useEffect(() => {
    function handleKeydown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, []);
  function goTo(page: Workspace) {
    setOpen(false);
    navigate(page.path);
  }
  function handleInputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && matching.length) {
      event.preventDefault();
      setSelected((value) => (value + 1) % matching.length);
    }
    if (event.key === 'ArrowUp' && matching.length) {
      event.preventDefault();
      setSelected((value) => (value + matching.length - 1) % matching.length);
    }
    if (event.key === 'Enter' && matching.length) {
      event.preventDefault();
      goTo(matching[Math.min(selected, matching.length - 1)]);
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(value) => {
      setOpen(value);
      if (value) { setQuery(''); setSelected(0); }
    }}>
      <Dialog.Trigger asChild>
        <button type="button" className="btn-secondary gap-2" aria-label="Search and jump to a workspace" aria-keyshortcuts="Control+K Meta+K">
          <Search size={17} aria-hidden="true" />
          <span className="hidden text-sm sm:inline">Jump to…</span>
          <kbd className="hidden rounded border border-[var(--border)] px-1.5 text-[0.68rem] lg:inline">Ctrl K</kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/60" />
        <Dialog.Content aria-describedby="workspace-search-help"
          className="fixed left-1/2 top-[12vh] z-70 w-[min(37rem,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl">
          <Dialog.Title className="sr-only">Search workspaces</Dialog.Title>
          <p id="workspace-search-help" className="sr-only">Search by tool or task. Use arrow keys to choose, Enter to open, or Escape to close.</p>
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
            <Search size={18} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <input ref={inputRef} type="search" autoComplete="off"
              className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none placeholder:text-[var(--muted)]"
              placeholder="Search tools, OIDs, traps…"
              aria-label="Search workspaces" role="combobox" aria-autocomplete="list"
              aria-expanded="true" aria-controls="workspace-search-results"
              aria-activedescendant={matching.length ? 'workspace-search-' + Math.min(selected, matching.length - 1) : undefined}
              onKeyDown={handleInputKey} value={query}
              onChange={(event) => { setQuery(event.target.value); setSelected(0); }} />
            <Dialog.Close className="btn-secondary p-2" aria-label="Close workspace search"><X size={17} aria-hidden="true" /></Dialog.Close>
          </div>
          <div id="workspace-search-results" role="listbox" aria-label="Matching workspaces"
            className="max-h-[min(60vh,29rem)] overflow-y-auto p-2">
            {matching.length ? matching.map((page, index) => (
              <button key={page.path} id={'workspace-search-' + index} type="button" role="option"
                aria-selected={index === selected}
                onMouseEnter={() => setSelected(index)} onClick={() => goTo(page)}
                className={'flex w-full items-center gap-3 rounded-xl border p-3 text-left ' +
                  (index === selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' :
                    'border-transparent hover:bg-[var(--surface-muted)]')}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)] text-[var(--accent)]">
                  <Command size={17} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{page.label}</span>
                  <span className="block truncate text-xs text-[var(--muted)]">{page.description}</span>
                </span>
                <ArrowRight size={16} className="shrink-0 text-[var(--muted)]" aria-hidden="true" />
              </button>
            )) : (
              <p role="status" className="p-5 text-center text-sm text-[var(--muted)]">No matching workspaces. Try “trap”, “walk”, or “OID”.</p>
            )}
          </div>
          <p className="border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--muted)]">↑ ↓ Navigate · Enter Open · Esc Close</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

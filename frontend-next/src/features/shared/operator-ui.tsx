import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Download, Play, Square, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useNotifications } from '../../lib/notifications/NotificationProvider';

export type Notice = { tone: 'success' | 'error'; text: string } | null;
export function Card({ title, description, children, trailing, compact = false }: {
  title: string; description?: string; children: ReactNode; trailing?: ReactNode; compact?: boolean;
}) {
  return <section aria-label={title} className={"panel flex min-w-0 flex-col overflow-hidden " + (compact ? "panel-compact h-auto shrink-0" : "h-full")}>
    <div className="panel-heading">
      <div className="min-w-0"><h2 className="text-base font-semibold leading-snug">{title}</h2>
        {description && <p className="mt-1 text-xs text-[var(--muted)]">{description}</p>}</div>
      {trailing}
    </div>
    <div className="panel-body space-y-4">{children}</div>
  </section>;
}
/** Single source-of-truth control for start/stop; green starts and red stops. */
export function ServiceToggle({ running, disabled, busy, noun, onToggle }: {
  running: boolean;
  disabled: boolean;
  busy: boolean;
  noun: string;
  onToggle: () => void;
}) {
  const action = running ? 'Stop' : 'Start';
  return <button type="button" aria-label={action + ' ' + noun}
    className={running ? 'btn-service-stop' : 'btn-service-start'}
    disabled={disabled || busy} onClick={onToggle}>
    {running ? <Square size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
    {busy ? 'Working…' : action + ' ' + noun}
  </button>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block space-y-1 text-sm font-semibold"><span>{label}</span>
    {children}{hint && <span className="block text-xs font-normal text-[var(--muted)]">{hint}</span>}
  </label>;
}
export function ConfirmDialog({ title, message, open, danger = false, busy = false, onCancel, onConfirm }: {
  title: string; message: string; open: boolean; danger?: boolean; busy?: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen && !busy) onCancel(); }}>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-70 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-[var(--text)] shadow-2xl">
        <div className="flex items-center justify-between gap-3"><AlertTriangle size={22} className="text-[var(--warning)]" aria-hidden="true" />
          <Dialog.Close className="btn-secondary p-2" disabled={busy} aria-label="Close confirmation"><X size={16} /></Dialog.Close>
        </div>
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="text-sm leading-relaxed text-[var(--muted)]">{message}</Dialog.Description>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className={danger ? 'btn-secondary border-[var(--danger)] text-[var(--danger)]' : 'btn-primary'}
            type="button" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : 'Confirm'}</button>
        </div>
      </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
export function JsonView({ data }: { data: unknown }) {
  return <pre className="max-h-[31rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface-muted)] p-4 text-xs leading-relaxed text-[var(--text)]"
    aria-label="Response details">{JSON.stringify(data ?? {}, null, 2)}</pre>;
}
export function StatusText({ busy, error, empty }: { busy: boolean; error?: Error | null; empty?: boolean }) {
  if (busy) return <p role="status" className="text-sm text-[var(--muted)]">Loading current data…</p>;
  if (error) return <p role="alert" className="text-sm text-[var(--danger)]">{error.message}</p>;
  if (empty) return <p className="text-sm text-[var(--muted)]">No records are available.</p>;
  return null;
}
/** The center should identify the operation, not display identical generic toasts. */
export function operatorActionLabel(path: string, method = 'POST'): string {
  const pathname = path.split('?')[0];
  const labels: Record<string, string> = {
    '/api/simulator/start': 'Simulator start',
    '/api/simulator/stop': 'Simulator stop',
    '/api/simulator/restart': 'Simulator restart',
    '/api/simulator/data': 'Simulator data save',
    '/api/simulator/logs': 'Simulator log clear',
    '/api/traps/start': 'Trap receiver start',
    '/api/traps/stop': 'Trap receiver stop',
    '/api/traps/send': 'Trap send',
    '/api/traps/send-inform': 'Inform send',
    '/api/traps/decode': 'Offline trap decode',
    '/api/traps/resolve-mibs': 'Trap MIB resolution change',
    '/api/mibs/validate-batch': 'MIB validation',
    '/api/mibs/upload': 'MIB upload',
    '/api/mibs/reload': 'MIB reload',
    '/api/mibs/fetch-dependencies': 'MIB dependency fetch',
    '/api/mibs/delete-batch': 'MIB source deletion',
  };
  if (labels[pathname]) return labels[pathname];
  if (pathname.startsWith('/api/traps/replay/')) return 'Trap replay';
  if (pathname.startsWith('/api/bundles/') && pathname.endsWith('/activate')) return 'Bundle activation';
  if (pathname === '/api/traps/' && method === 'DELETE') return 'Trap history clear';
  if (/^\/api\/traps\/\d+$/.test(pathname) && method === 'DELETE') return 'Trap event deletion';
  return 'Operation';
}

export function useOperatorApi() {
  const { auth } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const { notify } = useNotifications();
  const setNotice = (next: Notice) => {
    if (!next) return;
    notify({
      tone: next.tone,
      title: next.tone === 'error' ? 'Action failed' : 'Action completed',
      message: next.text,
    });
  };
  async function invoke<T>(path: string, init: RequestInit = {}, keys: readonly (readonly string[])[] = []): Promise<T | null> {
    if (!token || pending) return null;
    setPending(true);
    try {
      const data = await apiRequest<T>(path, token, init);
      for (const key of keys) await cache.invalidateQueries({ queryKey: [...key] });
      notify({ tone: 'success', title: operatorActionLabel(path, init.method) + ' completed' });
      return data;
    } catch (cause) {
      notify({ tone: 'error', title: operatorActionLabel(path, init.method) + ' failed',
        message: cause instanceof Error ? cause.message : 'Request failed.' });
      return null;
    } finally { setPending(false); }
  }
  return { token, pending, setNotice, invoke };
}
export function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
export function saveLocalFile(content: string, filename: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally { URL.revokeObjectURL(url); }
}
export function SaveDataButton({ value, filename }: { value: unknown; filename: string }) {
  return <button type="button" className="btn-secondary" onClick={() => saveLocalFile(JSON.stringify(value, null, 2), filename)}>
    <Download size={16} /> Export JSON
  </button>;
}
export function positivePort(value: string): number | null {
  const n = Number(value);
  return value.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
export function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

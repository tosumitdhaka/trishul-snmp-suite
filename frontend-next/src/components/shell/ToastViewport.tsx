import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useNotifications, type ActivityNotification } from '../../lib/notifications/NotificationProvider';

export const TOAST_DURATION_MS = 2700;
export function toastDurationMs(tone: ActivityNotification['tone']): number {
  return tone === 'error' ? 12000 : tone === 'warning' ? 8000 : tone === 'info' ? 5000 : TOAST_DURATION_MS;
}
const toneIcons = { success: CircleCheck, error: CircleAlert, warning: TriangleAlert, info: Info } as const;

function ToastItem({ item, onDismiss }: { item: ActivityNotification; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), toastDurationMs(item.tone));
    return () => window.clearTimeout(timer);
  }, [item.id, item.tone, onDismiss]);
  const Icon = toneIcons[item.tone];
  return <div className={'toast-item pointer-events-auto flex items-start gap-3 border-l-4 toast-tone-' + item.tone}>
    <Icon className="mt-0.5 shrink-0" size={19} aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold leading-5">{item.title}</p>
      {item.message && <div className="mt-1"><p className="line-clamp-2 break-words text-xs text-[var(--muted)]">{item.message}</p>{item.message.length > 125 && <details className="mt-1 text-xs"><summary className="cursor-pointer font-medium underline underline-offset-2">Read full details</summary><p className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[var(--muted)]">{item.message}</p></details>}</div>}
    </div>
    <button type="button" className="notification-item-action shrink-0" aria-label={'Close toast: ' + item.title}
      onClick={() => onDismiss(item.id)}>
      <X size={15} aria-hidden="true" />
    </button>
  </div>;
}

/** Transient feedback that never replaces unread action history in the bell drawer. */
export function ToastViewport() {
  const { latest } = useNotifications();
  const [toasts, setToasts] = useState<ActivityNotification[]>([]);
  useEffect(() => {
    if (!latest) return;
    setToasts(existing => [latest, ...existing.filter(item => item.id !== latest.id)].slice(0, 3));
  }, [latest]);
  const dismiss = (id: number) => setToasts(items => items.filter(item => item.id !== id));
  return <div aria-label="Temporary action messages" className="toast-viewport fixed right-4 top-20 z-40 flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2 pointer-events-none sm:right-7">
    {toasts.map(item => <ToastItem key={item.id} item={item} onDismiss={dismiss} />)}
  </div>;
}

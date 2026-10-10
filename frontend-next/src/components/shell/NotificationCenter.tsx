import * as Dialog from '@radix-ui/react-dialog';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, Trash2, TriangleAlert, X } from 'lucide-react';
import { useNotifications, type ActivityNotification } from '../../lib/notifications/NotificationProvider';

const toneIcons = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
} as const;

function NotificationRow({ notification }: { notification: ActivityNotification }) {
  const { markRead, dismiss } = useNotifications();
  const Icon = toneIcons[notification.tone];
  return <li className={'notification-item ' + (!notification.read ? 'notification-item-unread' : '')}>
    <div className="flex min-w-0 items-start gap-3">
      <span className={'notification-tone notification-tone-' + notification.tone}><Icon size={18} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-semibold leading-5">{notification.title}</p>
          {!notification.read && <span className="notification-unread-dot" title="Unread" aria-label="Unread" />}
        </div>
        {notification.message && <p className="break-words text-xs leading-relaxed text-[var(--muted)]">{notification.message}</p>}
        <p className="text-[0.7rem] text-[var(--muted)]">
          {notification.workspace} · <time dateTime={new Date(notification.createdAt).toISOString()}>
            {new Date(notification.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {!notification.read && <button type="button" className="notification-item-action" onClick={() => markRead(notification.id)} aria-label={'Mark read: ' + notification.title} title="Mark read">
          <CheckCheck size={15} aria-hidden="true" />
        </button>}
        <button type="button" className="notification-item-action" onClick={() => dismiss(notification.id)} aria-label={'Dismiss: ' + notification.title} title="Dismiss">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  </li>;
}

export function NotificationCenter() {
  const { notifications, unreadCount, latest, markAllRead, clearAll } = useNotifications();
  return <>
    <Dialog.Root>
      <Dialog.Trigger className="header-icon-button relative shrink-0" type="button" aria-label={'Notification center, ' + unreadCount + ' unread'} title="Notification center">
        <Bell size={19} aria-hidden="true" />
        {unreadCount > 0 && <span className="notification-badge" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
        <Dialog.Content className="notification-drawer fixed inset-y-0 right-0 z-50 flex w-[min(27rem,100vw)] flex-col border-l border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-2xl focus:outline-none"
          aria-describedby="notification-center-description">
          <div className="border-b border-[var(--border)] px-5 py-5">
            <div className="flex items-center justify-between gap-3">
              <div><Dialog.Title className="text-xl font-semibold tracking-tight">Notification center</Dialog.Title>
                <Dialog.Description id="notification-center-description" className="mt-1 text-xs text-[var(--muted)]">
                  Recent interface actions and results · {unreadCount} unread
                </Dialog.Description></div>
              <Dialog.Close className="header-icon-button" aria-label="Close notification center"><X size={19} /></Dialog.Close>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button className="btn-secondary" type="button" disabled={!unreadCount} onClick={markAllRead}><CheckCheck size={15} /> Mark all read</button>
              <button className="btn-secondary" type="button" disabled={!notifications.length} onClick={clearAll}><Trash2 size={15} /> Clear all</button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {notifications.length
              ? <ul aria-label="Recent notifications" className="divide-y divide-[var(--border)]">
                  {notifications.map(item => <NotificationRow key={item.id} notification={item} />)}
                </ul>
              : <div className="flex h-full min-h-52 flex-col items-center justify-center px-8 text-center">
                  <span className="rounded-2xl bg-[var(--surface-muted)] p-4 text-[var(--accent)]"><Bell size={24} /></span>
                  <p className="mt-4 font-semibold">You're all caught up</p>
                  <p className="mt-1 max-w-64 text-xs leading-relaxed text-[var(--muted)]">Completed actions, warnings and errors will appear here instead of moving your page content.</p>
                </div>}
          </div>
          <p className="border-t border-[var(--border)] px-5 py-4 text-xs text-[var(--muted)]">
            Activity from this signed-in preview session only. Incoming SNMP traps remain in the Traps workspace.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {latest ? latest.title + (latest.message ? ': ' + latest.message : '') : ''}
    </span>
  </>;
}

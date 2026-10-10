import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { workspaces } from '../navigation/workspaces';

export type NotificationTone = 'success' | 'error' | 'warning' | 'info';
export interface ActivityNotification {
  id: number;
  title: string;
  message: string;
  tone: NotificationTone;
  workspace: string;
  createdAt: number;
  read: boolean;
}
export interface NotificationInput {
  title: string;
  message?: string;
  tone: NotificationTone;
  workspace?: string;
}
interface NotificationContextValue {
  notifications: ActivityNotification[];
  unreadCount: number;
  latest: ActivityNotification | null;
  notify: (input: NotificationInput) => void;
  markRead: (id: number) => void;
  markAllRead: () => void;
  dismiss: (id: number) => void;
  clearAll: () => void;
}
export const NOTIFICATION_LIMIT = 40;

const NotificationContext = createContext<NotificationContextValue | null>(null);

/** UI action history is intentionally memory-only: no credentials, trap payloads or server data persisted. */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);
  const serial = useRef(0);
  const route = useLocation();
  const workspace = workspaces.find(item => item.path === route.pathname)?.label || 'Workspace';

  const notify = useCallback((input: NotificationInput) => {
    const title = input.title.trim().slice(0, 100);
    if (!title) return;
    const entry: ActivityNotification = {
      id: ++serial.current,
      title,
      message: (input.message || '').trim().slice(0, 400),
      tone: input.tone,
      workspace: input.workspace || workspace,
      createdAt: Date.now(),
      read: false,
    };
    setNotifications(previous => [entry, ...previous].slice(0, NOTIFICATION_LIMIT));
  }, [workspace]);
  const markRead = useCallback((id: number) => {
    setNotifications(items => items.map(item => item.id === id ? { ...item, read: true } : item));
  }, []);
  const markAllRead = useCallback(() => {
    setNotifications(items => items.map(item => item.read ? item : { ...item, read: true }));
  }, []);
  const dismiss = useCallback((id: number) => {
    setNotifications(items => items.filter(item => item.id !== id));
  }, []);
  const clearAll = useCallback(() => setNotifications([]), []);
  const unreadCount = notifications.filter(item => !item.read).length;
  const value = useMemo<NotificationContextValue>(() => ({
    notifications, unreadCount, latest: notifications[0] || null,
    notify, markRead, markAllRead, dismiss, clearAll,
  }), [notifications, unreadCount, notify, markRead, markAllRead, dismiss, clearAll]);
  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}
export function useNotifications(): NotificationContextValue {
  const value = useContext(NotificationContext);
  if (!value) throw new Error('useNotifications requires NotificationProvider.');
  return value;
}

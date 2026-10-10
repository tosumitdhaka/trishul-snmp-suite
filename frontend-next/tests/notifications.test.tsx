// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Link, Route, Routes } from 'react-router';
import { NotificationProvider, NOTIFICATION_LIMIT, useNotifications } from '../src/lib/notifications/NotificationProvider';
import { NotificationCenter } from '../src/components/shell/NotificationCenter';
import { ToastViewport, TOAST_DURATION_MS } from '../src/components/shell/ToastViewport';

function Actions() {
  const { notify } = useNotifications();
  return <div>
    <button onClick={() => notify({ tone: 'success', title: 'Simulator started', message: 'Listening on test port.' })}>Notify success</button>
    <button onClick={() => notify({ tone: 'error', title: 'Operation failed', message: 'Backend unavailable.' })}>Notify error</button>
    <button onClick={() => { for (let i = 0; i < NOTIFICATION_LIMIT + 5; i++) notify({ tone: 'info', title: 'Entry ' + i }); }}>Fill history</button>
    <Link to="/simulator">Simulator route</Link>
    <Link to="/traps">Traps route</Link>
  </div>;
}
function setup() {
  render(<MemoryRouter initialEntries={['/simulator']}>
    <NotificationProvider>
      <NotificationCenter />
      <ToastViewport />
      <Actions />
      <Routes>
        <Route path="/simulator" element={<p>Simulator page</p>} />
        <Route path="/traps" element={<p>Trap page</p>} />
      </Routes>
    </NotificationProvider>
  </MemoryRouter>);
}
afterEach(cleanup);
describe('shared notification center', () => {
  it('records action feedback in a single drawer instead of rendering page alerts', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Notify success' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notification center, 1 unread' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Notification center, 1 unread' }));
    const drawer = screen.getByRole('dialog', { name: 'Notification center' });
    expect(within(drawer).getByText('Simulator started')).toBeInTheDocument();
    expect(within(drawer).getByText('Listening on test port.')).toBeInTheDocument();
    expect(within(drawer).getByText(/Simulator ·/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Mark all read' }));
    expect(within(drawer).getByText(/0 unread/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Clear all' }));
    expect(within(drawer).getByText("You're all caught up")).toBeInTheDocument();
  });
  it('keeps history while changing workspaces and records error messages', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Notify error' }));
    fireEvent.click(screen.getByRole('link', { name: 'Traps route' }));
    fireEvent.click(screen.getByRole('button', { name: 'Notify success' }));
    fireEvent.click(screen.getByRole('button', { name: 'Notification center, 2 unread' }));
    const drawer = screen.getByRole('dialog', { name: 'Notification center' });
    const rows = within(drawer).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Traps');
    expect(rows[1]).toHaveTextContent('Simulator');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Dismiss: Operation failed' }));
    expect(within(drawer).getAllByRole('listitem')).toHaveLength(1);
  });
  it('bounds in-memory history so repeated events cannot grow unbounded', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Fill history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Notification center, 40 unread' }));
    const drawer = screen.getByRole('dialog', { name: 'Notification center' });
    expect(within(drawer).getAllByRole('listitem')).toHaveLength(NOTIFICATION_LIMIT);
  });
});

describe('short-lived action toasts', () => {
  it('disappears after 2.7 seconds but remains in the notification center', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.click(screen.getByRole('button', { name: 'Notify success' }));
      expect(screen.getByText('Listening on test port.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Notification center, 1 unread' })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS + 50); });
      expect(screen.queryByText('Listening on test port.')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Notification center, 1 unread' }));
      expect(within(screen.getByRole('dialog', { name: 'Notification center' })).getByText('Simulator started')).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  getSavedSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
  WorkspaceShell,
} from '../src/components/shell/WorkspaceShell';
import { LoginView } from '../src/app/LoginView';
import trishulLogo from '../src/assets/trishul-icon.svg';

vi.mock('../src/lib/auth/AuthProvider', () => ({
  useAuth: () => ({
    auth: { state: 'authenticated', token: 'test-token', username: 'operator' },
    login: vi.fn(), logout: vi.fn(),
  }),
}));
vi.mock('../src/lib/realtime/RealtimeProvider', () => ({
  useRealtime: () => 'live',
}));
vi.mock('../src/lib/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('../src/components/shell/WorkspaceSearch', () => ({
  WorkspaceSearch: () => null,
}));

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/simulator']}>
      <WorkspaceShell><p>Workspace content</p></WorkspaceShell>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

describe('Trishul desktop sidebar', () => {
  it('uses the existing branded Trishul SVG and keeps full labels when expanded', () => {
    renderShell();
    const sidebar = screen.getByRole('complementary', { name: 'Desktop sidebar' });
    const logo = sidebar.querySelector('img');
    expect(logo).toHaveAttribute('src', trishulLogo);
    expect(logo).toHaveAttribute('alt', '');
    expect(within(sidebar).getByRole('link', { name: 'Simulator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('collapses to icon-only links, saves preference, expands on demand', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('header button[aria-controls]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Collapse sidebar' }).querySelector('svg'))
      .toHaveClass('lucide-menu');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('true');
    const sidebar = screen.getByRole('complementary', { name: 'Desktop sidebar' });
    expect(sidebar).toHaveClass('w-[4.75rem]');
    expect(within(sidebar).getByRole('link', { name: 'Simulator' })).toHaveAttribute('title', 'Simulator');
    expect(within(sidebar).getByRole('link', { name: 'Simulator' })).toHaveAttribute('href', '/simulator');
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(sidebar).toHaveClass('w-64');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('false');
  });

  it('restores the collapsed setting independently of login and theme state', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'true');
    expect(getSavedSidebarCollapsed()).toBe(true);
    renderShell();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('mx-auto');
  });

  it('switches the same control across breakpoints without opening a second menu', () => {
    renderShell();
    const navigation = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(navigation).toHaveAttribute('aria-controls', 'desktop-sidebar');

    window.innerWidth = 390;
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('button', { name: 'Open menu' })).toBe(navigation);
    expect(navigation).toHaveAttribute('aria-controls', 'mobile-navigation');
    expect(navigation.querySelector('svg')).toHaveClass('lucide-menu');
    fireEvent.click(navigation);
    expect(screen.getByRole('dialog', { name: 'Navigate workspaces' })).toBeInTheDocument();

    window.innerWidth = 1280;
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBe(navigation);
    expect(document.querySelectorAll('header button[aria-controls]')).toHaveLength(1);
  });

  it('keeps full-label mobile navigation when desktop rail is collapsed', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'true');
    window.innerWidth = 390;
    renderShell();
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelectorAll('header button[aria-controls]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigate workspaces' });
    expect(within(dialog).getByRole('link', { name: 'MIB Manager' }))
      .toHaveAttribute('href', '/mibs');
    expect(within(dialog).getByRole('link', { name: 'Trishul SNMP Suite — Dashboard' }))
      .toBeInTheDocument();
  });
});

describe('Trishul login branding', () => {
  it('reuses the official SVG instead of a generic network glyph', () => {
    render(<LoginView />);
    const logo = document.querySelector('main img');
    expect(logo).toHaveAttribute('src', trishulLogo);
  });
});

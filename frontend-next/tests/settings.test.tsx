// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SettingsPage } from '../src/features/settings/SettingsPage';
import { NotificationProvider } from '../src/lib/notifications/NotificationProvider';
import { NotificationCenter } from '../src/components/shell/NotificationCenter';

const authMocks = vi.hoisted(() => ({ expire: vi.fn() }));
vi.mock('../src/lib/auth/AuthProvider', () => ({
  useAuth: () => ({
    auth: { state: 'authenticated', username: 'admin', token: 'test-token' },
    expire: authMocks.expire,
  }),
}));

const serverPrefs = {
  auto_start_simulator: false,
  auto_start_trap_receiver: true,
  session_timeout: 3600,
  mib_auto_fetch: false,
  mib_remote_sources: ['https://example.invalid/@mib@'],
  restart_required: false,
};

function mockApi(initialFail = false) {
  const calls: { path: string; method: string; body: unknown; token: string | null }[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
    const path = String(input);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined;
    const token = new Headers(init.headers).get('X-Auth-Token');
    calls.push({ path, method, body, token });
    if (initialFail && path === '/api/settings/app' && method === 'GET') {
      return new Response(JSON.stringify({ detail: 'Service unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    let result: unknown;
    if (path === '/api/settings/app') result = method === 'POST'
      ? { ...body as object, restart_required: true } : serverPrefs;
    else if (path === '/api/meta') result = { name: 'Trishul SNMP Suite', version: '2.2.4', author: 'Team', description: 'Ops' };
    else if (path === '/api/mibs/status') result = { active_bundle_label: 'Starter bundle', producer_version: '2.2.4', loaded: 7, recompile_recommended: true };
    else if (path === '/api/settings/auth') result = { status: 'updated', reauth_required: true };
    else if (path === '/api/stats/') result = method === 'DELETE' ? { status: 'reset' } : { walker: { walks_executed: 2 }, runtime: { internal: true } };
    else return new Response('missing', { status: 404 });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function renderSettings() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const view = render(<QueryClientProvider client={cache}><MemoryRouter><NotificationProvider><NotificationCenter /><SettingsPage /></NotificationProvider></MemoryRouter></QueryClientProvider>);
  return { ...view, cache };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  authMocks.expire.mockReset();
});

describe('Stage 3 Settings preview', () => {
  it('loads persisted fields and real About details, and saves a complete validated payload', async () => {
    const { calls } = mockApi();
    renderSettings();
    const section = screen.getByRole('region', { name: 'Application settings' });
    const save = await within(section).findByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    expect(screen.getByText('Starter bundle')).toBeInTheDocument();
    expect(within(section).getByRole('switch', { name: 'Trap receiver' })).toBeChecked();
    fireEvent.click(within(section).getByRole('switch', { name: 'Simulator' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Application settings saved.'));
    const post = calls.find((item) => item.path === '/api/settings/app' && item.method === 'POST');
    expect(post?.token).toBe('test-token');
    expect(post?.body).toEqual({
      auto_start_simulator: true,
      auto_start_trap_receiver: true,
      session_timeout: 3600,
      mib_auto_fetch: false,
      mib_remote_sources: ['https://example.invalid/@mib@'],
    });
    expect(within(section).getByText('Restart required')).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it('never saves defaults if the initial settings request fails', async () => {
    const { calls } = mockApi(true);
    renderSettings();
    const section = screen.getByRole('region', { name: 'Application settings' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('Saving is disabled');
    expect(within(section).queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Retry loading' })).toBeEnabled();
    expect(calls.some((item) => item.path === '/api/settings/app' && item.method === 'POST')).toBe(false);
  });

  it('shows inline validation and blocks invalid timeout or MIB URL templates', async () => {
    const { calls } = mockApi();
    renderSettings();
    const section = screen.getByRole('region', { name: 'Application settings' });
    const timeout = await within(section).findByRole('spinbutton', { name: 'Session timeout (seconds)' });
    fireEvent.change(timeout, { target: { value: '33' } });
    expect(within(section).getByRole('alert')).toHaveTextContent('between 60 and 86400');
    expect(timeout).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(timeout, { target: { value: '3600' } });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Approved remote MIB sources' }), {
      target: { value: 'ftp://bad.invalid/@mib@\nhttps://missing.invalid/IF-MIB' },
    });
    expect(within(section).getByRole('alert')).toHaveTextContent('Line 1: use an http(s) URL.');
    expect(within(section).getByRole('alert')).toHaveTextContent('Line 2: include the @mib@ placeholder.');
    expect(within(section).getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(calls.some((item) => item.path === '/api/settings/app' && item.method === 'POST')).toBe(false);
  });

  it('requires confirmation before credential rotation and invalidates the current session on success', async () => {
    const { calls } = mockApi();
    renderSettings();
    const section = screen.getByRole('region', { name: 'Authentication' });
    fireEvent.change(within(section).getByLabelText('Current password'), { target: { value: 'currentPassword' } });
    fireEvent.change(within(section).getByLabelText('New password'), { target: { value: 'UpdatedSecret123!' } });
    fireEvent.change(within(section).getByLabelText('Confirm new password'), { target: { value: 'UpdatedSecret123!' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Update credentials' }));
    expect(calls.filter((item) => item.path === '/api/settings/auth')).toHaveLength(0);
    const confirm = await screen.findByRole('dialog', { name: 'Update credentials and sign out?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Update and sign out' }));
    await waitFor(() => expect(authMocks.expire).toHaveBeenCalledWith('test-token'));
    const request = calls.find((item) => item.path === '/api/settings/auth');
    expect(request?.body).toEqual({
      username: 'admin', current_password: 'currentPassword', password: 'UpdatedSecret123!',
    });
    expect(request?.token).toBe('test-token');
  });

  it('never resets counters without confirmation and sends authenticated DELETE after confirming', async () => {
    const { calls } = mockApi();
    renderSettings();
    const section = screen.getByRole('region', { name: 'Statistics' });
    fireEvent.click(within(section).getByRole('button', { name: 'Reset stats' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset every activity counter?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((item) => item.method === 'DELETE')).toBe(false);
    fireEvent.click(within(section).getByRole('button', { name: 'Reset stats' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Reset every activity counter?' })).getByRole('button', { name: 'Reset counters' }));
    await waitFor(() => expect(calls.find((item) => item.method === 'DELETE')).toMatchObject({ path: '/api/stats/', token: 'test-token' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Activity counters reset.'));
  });

  it('exports a fresh stats snapshot using the same protected endpoint as the legacy UI', async () => {
    const { calls } = mockApi();
    const createUrl = vi.fn(() => 'blob:mock-download');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderSettings();
    const section = screen.getByRole('region', { name: 'Statistics' });
    fireEvent.click(within(section).getByRole('button', { name: 'Export stats' }));
    await waitFor(() => expect(within(section).getByText('Activity statistics exported.')).toBeInTheDocument());
    expect(calls.find((item) => item.path === '/api/stats/' && item.method === 'GET')?.token).toBe('test-token');
    expect(createUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith('blob:mock-download');
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SimulatorPage } from '../src/features/simulator/SimulatorPage';
import { WalkerPage } from '../src/features/walker/WalkerPage';
import { TrapsPage } from '../src/features/traps/TrapsPage';
import { BrowserPage } from '../src/features/browser/BrowserPage';
import { MibsPage } from '../src/features/mibs/MibsPage';
import { NotificationProvider } from '../src/lib/notifications/NotificationProvider';

vi.mock('../src/lib/auth/AuthProvider', () => ({
  useAuth: () => ({ auth: { state: 'authenticated', token: 'test-token', username: 'operator' }, expire: vi.fn() }),
}));
vi.mock('../src/lib/realtime/RealtimeProvider', () => ({ useRealtime: () => 'live' }));

function fixture(path: string, method: string, simulatorRunning = false, receiverRunning = false): unknown {
  if (path.startsWith('/api/simulator/status')) return { running: simulatorRunning, port: 1061, community: 'public', requests: 0 };
  if (path.startsWith('/api/simulator/data')) return {};
  if (path.startsWith('/api/simulator/logs')) return { items: [{ level: 'INFO', msg: 'started' }] };
  if (path === '/api/traps/status') return { running: receiverRunning, port: 1162, community: 'public', resolve_mibs: true };
  if (path.startsWith('/api/traps/?')) return { data: [{ id: 42, trap_type: 'linkDown', source: 'localhost', varbinds: [] }], total: 1, count: 1 };
  if (path === '/api/mibs/traps') return { traps: [{ oid: '1.3.6.1.6.3.1.1.5.3', name: 'linkDown', full_name: 'SNMPv2-MIB::linkDown' }] };
  if (path.startsWith('/api/mibs/objects?')) return { objects: [] };
  if (path === '/api/mibs/browse/modules') return { modules: [{ name: 'IF-MIB' }] };
  if (path.startsWith('/api/mibs/browse/search?')) return { count: 1, results: [{ oid: '1.3.6.1.2.1.2.2', name: 'ifTable', module: 'IF-MIB' }] };
  if (path.startsWith('/api/mibs/browse/tree/module')) return { count: 2, modules: [{ name: 'IF-MIB', module: 'IF-MIB', oid: '1.3.6.1.2.1.2.2', object_count: 2, children: [{ oid: '1.3.6.1.2.1.2.2', name: 'ifTable', module: 'IF-MIB', has_children: true }] }] };
  if (path.startsWith('/api/mibs/browse/tree/oid?')) return { root: {oid:'1.3.6.1',name:'internet'}, children: [{oid:'1.3.6.1.2', name:'mgmt',has_children:false}], total_descendants: 1 };
  if (path.startsWith('/api/mibs/browse/node/')) return { node: { oid: '1.3.6.1.2.1.2.2', name: 'ifTable', module: 'IF-MIB' }, breadcrumb: [] };
  if (path === '/api/mibs/status') return { loaded: 1, failed: 0, mibs: [{ name: 'IF-MIB', status: 'active', objects: 2 }], source_inventory: [
    { name: 'IF-MIB', relative_path: 'uploads/IF-MIB', source_group: 'uploaded', status: 'active', deletable: true },
  ], source_groups: [{ name: 'uploaded', file_count: 1 }], active_bundle_label: 'bundle-1' };
  if (path === '/api/bundles') return { bundles: [{ id: 1, label: 'bundle-1' }, { id: 2, label: 'older' }], active_bundle_id: 1 };
  if (path === '/api/walk/execute' && method === 'POST') return { mode: 'parsed', count: 1, data: [{ oid: '1.3.6.1', value: 17 }] };
  return { status: 'ok' };
}
const calls: { path: string; method: string; init: RequestInit }[] = [];
function mockApi(simulatorRunning = false, receiverRunning = false) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input), method = init.method || 'GET';
    calls.push({ path, method, init });
    return new Response(JSON.stringify(fixture(path, method, simulatorRunning, receiverRunning)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}
function setup(component: React.ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const rendered = render(<QueryClientProvider client={cache}><MemoryRouter><NotificationProvider>{component}</NotificationProvider></MemoryRouter></QueryClientProvider>);
  return { ...rendered, cache };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe('remaining five React workspaces', () => {
  it('Simulator loads real endpoints and start sends authenticated port/community', async () => {
    mockApi(); setup(<SimulatorPage />);
    expect(await screen.findByText('started')).toBeInTheDocument();
    const runtime = screen.getByRole('region', { name: 'Runtime' });
    fireEvent.click(within(runtime).getByRole('button', { name: 'Start simulator' }));
    await waitFor(() => expect(calls.some(c => c.path === '/api/simulator/start' && c.method === 'POST')).toBe(true));
    const call = calls.find(c => c.path === '/api/simulator/start');
    expect(new Headers(call?.init.headers).get('X-Auth-Token')).toBe('test-token');
    expect(JSON.parse(String(call?.init.body))).toEqual({ port: 1061, community: 'public' });
  });
  it('uses a single red Stop action for a running simulator, retaining Restart', async () => {
    mockApi(true); setup(<SimulatorPage />);
    const runtime = screen.getByRole('region', { name: 'Runtime' });
    const stop = await within(runtime).findByRole('button', { name: 'Stop simulator' });
    expect(stop).toHaveClass('btn-service-stop');
    expect(within(runtime).queryByRole('button', { name: 'Start simulator' })).not.toBeInTheDocument();
    expect(within(runtime).getByText('Running')).toHaveClass('service-status-simulator');
    fireEvent.click(stop);
    await waitFor(() => expect(calls.some(c => c.path === '/api/simulator/stop' && c.method === 'POST')).toBe(true));
    expect(within(runtime).getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });
  it('uses the same state-aware receiver toggle with its own status color', async () => {
    mockApi(true, true); setup(<TrapsPage />);
    const receiver = screen.getByRole('region', { name: 'Trap receiver' });
    const stop = await within(receiver).findByRole('button', { name: 'Stop receiver' });
    expect(stop).toHaveClass('btn-service-stop');
    expect(within(receiver).queryByRole('button', { name: 'Start receiver' })).not.toBeInTheDocument();
    expect(within(receiver).getByText('Running')).toHaveClass('service-status-receiver');
    fireEvent.click(stop);
    await waitFor(() => expect(calls.some(c => c.path === '/api/traps/stop' && c.method === 'POST')).toBe(true));
  });
  it('uses green Start for a stopped receiver with a single action', async () => {
    mockApi(false, false); setup(<TrapsPage />);
    const receiver = screen.getByRole('region', { name: 'Trap receiver' });
    const start = await within(receiver).findByRole('button', { name: 'Start receiver' });
    expect(start).toHaveClass('btn-service-start');
    fireEvent.click(start);
    await waitFor(() => expect(calls.some(c => c.path === '/api/traps/start' && c.method === 'POST')).toBe(true));
  });
  it('Walker posts the current form, receives tabulated rows and keeps history local', async () => {
    mockApi(); setup(<WalkerPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Execute walk' }));
    expect(await screen.findByText('17')).toBeInTheDocument();
    const call = calls.find(c => c.path === '/api/walk/execute');
    expect(JSON.parse(String(call?.init.body))).toMatchObject({ target: '127.0.0.1', oid: '1.3.6.1.2.1', timeout_ms: 2000, parse: true });
    expect(screen.getByRole('region', { name: 'Recent walks' })).toHaveTextContent('127.0.0.1');
    expect(localStorage.getItem('trishul_next_walk_history')).not.toContain('public');
  });
  it('Traps uses a paginated history endpoint and requires confirmation before clearing', async () => {
    mockApi(); setup(<TrapsPage />);
    expect(await screen.findByText('linkDown')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Received trap history' });
    fireEvent.click(within(history).getByRole('button', { name: 'Clear all' }));
    expect(calls.some(c => c.path === '/api/traps/' && c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete all received traps?' })).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    expect(calls.some(c => c.path === '/api/traps/?limit=50&offset=0')).toBe(true);
  });
  it('MIB Browser shows module roots by default, expands and switches to numeric OID view', async () => {
    mockApi(); setup(<BrowserPage />);
    const tree = screen.getByRole('tree', { name: 'MIB module tree' });
    expect(await within(tree).findByRole('button', { name: 'Expand IF-MIB' })).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/mibs/browse/tree/module')).toBe(true);
    fireEvent.click(within(tree).getByRole('button', { name: 'Expand IF-MIB' }));
    expect(await within(tree).findByRole('button', { name: 'Expand ifTable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'By OID' }));
    expect(await screen.findByRole('tree', { name: 'Numeric OID tree' })).toBeInTheDocument();
    expect(calls.some(c => c.path.startsWith('/api/mibs/browse/tree/oid?root_oid=1.3.6.1'))).toBe(true);
    const expand = screen.getByRole('group', { name: 'Tree expansion controls' });
    expect(within(expand).getByRole('combobox', { name: 'Expansion depth' })).toHaveValue('3');
    expect(within(expand).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(within(expand).getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
    const downloads = screen.getByRole('group', { name: 'Refresh and export' });
    expect(within(downloads).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(within(downloads).getByRole('button', { name: 'JSON' })).toBeInTheDocument();
  });
  it('MIB Manager lists active sources and bundles, preventing immediate destructive actions', async () => {
    mockApi(); setup(<MibsPage />);
    expect(await screen.findByText('bundle-1')).toBeInTheDocument();
    expect(await screen.findByText('uploads/IF-MIB')).toBeInTheDocument();
    const source = screen.getByRole('checkbox', { name: 'Select uploads/IF-MIB' });
    fireEvent.click(source);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    expect(calls.some(c => c.path === '/api/mibs/delete-batch')).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Delete selected MIB source files?' })).toBeInTheDocument();
  });
});

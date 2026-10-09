// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DashboardPage } from '../src/features/dashboard/DashboardPage';

vi.mock('../src/lib/auth/AuthProvider', () => ({
  useAuth: () => ({ auth: { state: 'authenticated', token: 'test-token' } }),
}));
vi.mock('../src/lib/realtime/RealtimeProvider', () => ({
  useRealtime: () => 'live',
}));

afterEach(() => vi.unstubAllGlobals());

describe('dashboard preview', () => {
  it('shows contract-backed summary, all activity counters, and six routes', async () => {
    const paths: Record<string, unknown> = {
      '/api/meta': { name: 'Trishul SNMP Suite', version: '2.2.4', author: 'Test', description: '' },
      '/api/simulator/status': { running: true },
      '/api/traps/status': { running: false },
      '/api/mibs/status': {
        loaded: 3,
        mibs: [{ traps: 2 }, { traps: 3 }],
        source_groups: [{ file_count: 4 }],
      },
      '/api/stats/': {
        simulator: { snmp_requests_served: 82, oids_loaded: 150 },
        traps: { traps_received_total: 7, traps_sent_total: 4 },
        walker: { walks_executed: 8, oids_returned: 91 },
        mibs: { upload_count: 4, reload_count: 2 },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string) =>
      new Response(JSON.stringify(paths[input]), { status: paths[input] ? 200 : 404, headers: { 'Content-Type': 'application/json' } })));
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    render(<QueryClientProvider client={cache}><MemoryRouter><DashboardPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('82')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Service health' });
    expect(within(section).getByText('Running')).toBeInTheDocument();
    expect(within(section).getByText('Stopped')).toBeInTheDocument();
    expect(within(section).getByText('5')).toBeInTheDocument();
    expect(screen.getAllByText('MIB sources')[0]).toBeInTheDocument();
    const links = within(screen.getByRole('region', { name: 'Workspaces' })).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/simulator', '/walker', '/traps', '/browser', '/mibs', '/settings',
    ]);
    cache.clear();
  });
});

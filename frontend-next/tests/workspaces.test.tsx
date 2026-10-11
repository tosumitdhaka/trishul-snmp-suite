// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
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
  if (path.startsWith('/api/traps/?')) return { data: [{ id: 42, trap_type: 'linkDown', source: 'localhost',
    varbinds: [{ oid:'1.3.6.1.2.1.2.2.1.1', name:'IF-MIB::ifIndex', value: 7, resolved:true }] }], total: 1, count: 1 };
  if (path === '/api/mibs/traps') return { traps: [{
    oid: '1.3.6.1.6.3.1.1.5.3', name: 'linkDown', full_name: 'IF-MIB::linkDown', module: 'IF-MIB',
    objects: [{ name: 'ifIndex', oid: '1.3.6.1.2.1.2.2.1.1', input_type: 'Integer' }],
  }] };
  if (path.startsWith('/api/mibs/objects?')) return { objects: [] };
  if (path === '/api/mibs/browse/modules') return { modules: [{ name: 'IF-MIB' }] };
  if (path.startsWith('/api/mibs/browse/search?')) return { count: 1, results: [{ oid: '1.3.6.1.2.1.2.2', name: 'ifTable', module: 'IF-MIB' }] };
  if (path.startsWith('/api/mibs/browse/tree/module')) return { count: 2, modules: [{ name: 'IF-MIB', module: 'IF-MIB', oid: '1.3.6.1.2.1.2.2', object_count: 2, children: [{ oid: '1.3.6.1.2.1.2.2', name: 'ifTable', module: 'IF-MIB', has_children: true }] }] };
  if (path.startsWith('/api/mibs/browse/tree/oid?')) return { root: {oid:'1.3.6.1',name:'internet'}, children: [{oid:'1.3.6.1.2', name:'mgmt',has_children:false}], total_descendants: 1 };
  if (path.startsWith('/api/mibs/browse/node/')) return { node: { oid: '1.3.6.1.2.1.2.2', name: 'ifTable', full_name: 'IF-MIB::ifTable', module: 'IF-MIB' }, breadcrumb: [] };
  if (path === '/api/mibs/status') return { loaded: 1, failed: 0, mibs: [{ name: 'IF-MIB', status: 'active', objects: 2 }], source_inventory: [
    { name: 'IF-MIB', relative_path: 'uploads/IF-MIB', source_group: 'uploaded', status: 'active', deletable: true },
  ], source_groups: [{ name: 'uploaded', file_count: 1 }], active_bundle_label: 'bundle-1' };
  if (path === '/api/bundles') return { bundles: [{ id: 1, label: 'bundle-1' }, { id: 2, label: 'older' }], active_bundle_id: 1 };
  if (path === '/api/mibs/fetch-dependencies' && method === 'POST') return {
    attempted: ['IF-MIB'], resolved: ['IF-MIB'], cached: [], failed: [],
  };
  if (path === '/api/walk/execute' && method === 'POST') return { mode: 'parsed', count: 1,
    json_format: 'grouped', rawLines: ['1.3.6.1 = INTEGER: 17'],
    data: [{ oid: '1.3.6.1', value: 17, metric_category:'system', mib_module:'SNMPv2-MIB' }] };
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
  it('beautifies JSON locally without saving it until explicitly requested', async () => {
    mockApi(); setup(<SimulatorPage />);
    const panel=screen.getByRole('region',{name:'Custom SNMP data'});
    const editor=await within(panel).findByRole('textbox',{name:/Override JSON/});
    await waitFor(()=>expect(editor).toBeEnabled());
    fireEvent.change(editor,{target:{value:'{"foo":1,"nested":{"bar":true}}'}});
    fireEvent.click(within(panel).getByRole('button',{name:'Beautify JSON'}));
    expect(editor).toHaveValue('{'+'\n  "foo": 1,\n  "nested": {\n    "bar": true\n  }\n}');
    expect(calls.some(c=>c.path==='/api/simulator/data' && c.method==='POST')).toBe(false);
    fireEvent.click(within(panel).getByRole('button',{name:'Save custom data'}));
    await waitFor(()=>expect(calls.some(c=>c.path==='/api/simulator/data'&&c.method==='POST')).toBe(true));
  });
  it('pauses simulator log auto refresh with a checkbox', async () => {
    mockApi(); setup(<SimulatorPage />);
    const logs=screen.getByRole('region',{name:'Activity logs'});
    const checkbox=within(logs).getByRole('checkbox',{name:'Pause auto refresh'});
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(within(logs).getByRole('button',{name:'Clear simulator logs'})).toHaveClass('btn-danger');
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
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(calls.some(c => c.path === '/api/traps/start' && c.method === 'POST')).toBe(true));
  });
  it('Walker posts the current form, receives tabulated rows and keeps history local', async () => {
    mockApi(); setup(<WalkerPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Execute walk' }));
    expect(await screen.findByLabelText('Raw SNMP walk result')).toHaveTextContent('INTEGER: 17');
    expect(screen.getByRole('button', {name:'Raw'})).toHaveAttribute('aria-pressed','true');
    fireEvent.click(screen.getByRole('button', {name:'Grouped table'}));
    expect(screen.getByRole('region',{name:'Category: system'})).toHaveTextContent('17');
    const call = calls.find(c => c.path === '/api/walk/execute');
    expect(JSON.parse(String(call?.init.body))).toMatchObject({ target: '127.0.0.1', oid: '1.3.6.1.2.1', timeout_ms: 2000, parse: true });
    expect(screen.getByRole('region', { name: 'Recent walks' })).toHaveTextContent('127.0.0.1');
    expect(localStorage.getItem('trishul_next_walk_history')).not.toContain('public');
  });
  it('Traps uses a paginated history endpoint and requires confirmation before clearing', async () => {
    mockApi(); setup(<TrapsPage />);
    expect(await screen.findByText('linkDown')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Received trap history' });
    fireEvent.click(within(history).getByRole('button', { name: 'Clear received trap history' }));
    expect(calls.some(c => c.path === '/api/traps/' && c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete all received traps?' })).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    expect(calls.some(c => c.path === '/api/traps/?limit=50&offset=0')).toBe(true);
  });
  it('shows matching notification suggestions and opens an in-page notification catalog', async () => {
    mockApi(); setup(<TrapsPage />);
    const sender = screen.getByRole('region', {name:'Notification sender'});
    const oid = within(sender).getByRole('textbox',{name:'Notification OID'});
    fireEvent.change(oid,{target:{value:'linkDo'}});
    const suggestion=await within(sender).findByRole('button',{name:/IF-MIB::linkDown/});
    fireEvent.click(suggestion);
    expect(oid).toHaveValue('1.3.6.1.6.3.1.1.5.3');
    fireEvent.click(within(sender).getByRole('button',{name:'Browse notification catalog'}));
    const dialog=await screen.findByRole('dialog',{name:'Notification catalog'});
    expect(within(dialog).getByText('IF-MIB::linkDown')).toBeInTheDocument();
  });
  it('expands a received trap row with resolved varbind names and applies MIB names immediately', async () => {
    mockApi(); setup(<TrapsPage />);
    const history=screen.getByRole('region',{name:'Received trap history'});
    const toggle=await within(history).findByRole('button',{name:'Expand trap event 42'});
    fireEvent.click(toggle);
    const detail=within(history).getByRole('region',{name:'Event details 42'});
    expect(within(detail).getByText('IF-MIB::ifIndex')).toBeInTheDocument();
    expect(within(history).queryByRole('button',{name:'Inspect'})).not.toBeInTheDocument();
    const receiver=screen.getByRole('region',{name:'Trap receiver'});
    const resolve=within(receiver).getByRole('checkbox',{name:'Resolve MIB names in received events'});
    await waitFor(()=>expect(resolve).toBeEnabled());
    fireEvent.click(resolve);
    await waitFor(()=>expect(calls.some(c=>c.path==='/api/traps/resolve-mibs'&&c.method==='POST')).toBe(true));
    expect(within(receiver).queryByRole('button',{name:'Apply MIB resolution'})).not.toBeInTheDocument();
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
  it('moves simulator port into Walker while keeping the editor compact', async () => {
    mockApi(); setup(<Routes>
      <Route path="/" element={<SimulatorPage />} />
      <Route path="/walker" element={<WalkerPage />} />
    </Routes>);
    const runtime = screen.getByRole('region', { name: 'Runtime' });
    const edit = screen.getByRole('region', { name: 'Custom SNMP data' });
    expect(runtime).toHaveClass('panel-compact');
    expect(edit).toHaveClass('panel-compact');
    expect(within(edit).getByRole('textbox', { name: /Override JSON/ })).toHaveClass('simulator-data-editor');
    fireEvent.click(within(runtime).getByRole('link', { name: 'Walk simulator' }));
    expect(await screen.findByRole('heading', { name: 'SNMP walk explorer' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'UDP port' })).toHaveValue(1061);
  });
  it('opens the Walker current numeric OID in the By OID tree, not text search', async () => {
    mockApi(); setup(<Routes>
      <Route path="/" element={<WalkerPage />} />
      <Route path="/browser" element={<BrowserPage />} />
    </Routes>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Root OID' }), { target: { value: '1.3.6.1.2.1.2.2' } });
    fireEvent.click(screen.getByRole('link', { name: 'Browse this OID' }));
    const mode = await screen.findByRole('button', { name: 'By OID' });
    expect(mode).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(calls.some(c => c.path.includes('/api/mibs/browse/tree/oid?root_oid=1.3.6.1.2.1.2.2'))).toBe(true));
    expect(calls.some(c => c.path.startsWith('/api/mibs/browse/search?query=1.3.6.1'))).toBe(false);
  });
  it('opens a catalog notification from MIB Manager with declared varbinds in Trap Sender', async () => {
    mockApi(); setup(<Routes>
      <Route path="/" element={<MibsPage />} />
      <Route path="/traps" element={<TrapsPage />} />
    </Routes>);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('IF-MIB::linkDown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Send' }));
    const sender = screen.getByRole('region', { name: 'Notification sender' });
    expect(within(sender).getByRole('textbox', { name: 'Notification OID' })).toHaveValue('1.3.6.1.6.3.1.1.5.3');
    expect(within(sender).getByRole('textbox', { name: 'Varbind 1 OID' })).toHaveValue('1.3.6.1.2.1.2.2.1.1');
    expect(within(sender).getByRole('combobox', { name: 'Varbind 1 type' })).toHaveValue('Integer');
  });
  it('allows MIB Manager module inventory to open its selected module in Browser', async () => {
    mockApi(); setup(<Routes>
      <Route path="/" element={<MibsPage />} />
      <Route path="/browser" element={<BrowserPage />} />
    </Routes>);
    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    const browse = await screen.findByRole('link', { name: 'Browse module' });
    fireEvent.click(browse);
    await waitFor(() => expect(calls.some(c => c.path.includes('/api/mibs/browse/tree/module?module=IF-MIB'))).toBe(true));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Module' })).toHaveValue('IF-MIB'));
  });
  it('keeps a 2:1 catalog/sidebar design and allows module + source + notification selection', async () => {
    mockApi(); setup(<MibsPage />);
    const inventory=screen.getByRole('region',{name:'Catalog & source inventory'});
    expect(inventory.parentElement).toHaveClass('manager-catalog-column');
    expect(inventory.parentElement?.parentElement).toHaveClass('manager-layout');
    const sidebar=screen.getByRole('complementary',{name:'Catalog export and bundle history'});
    expect(within(sidebar).getByRole('region',{name:'Catalog export'})).toBeInTheDocument();
    expect(within(sidebar).getByRole('region',{name:'Compiled bundle history'})).toBeInTheDocument();
    const moduleBox=await within(inventory).findByRole('checkbox',{name:'Select IF-MIB'});
    fireEvent.click(moduleBox);
    expect(moduleBox).toBeChecked();
    fireEvent.click(within(inventory).getByRole('button',{name:'Sources'}));
    const source=await within(inventory).findByRole('checkbox',{name:'Select uploads/IF-MIB'});
    fireEvent.click(source);
    expect(source).toBeChecked();
    fireEvent.click(within(inventory).getByRole('button',{name:'Notifications'}));
    const notice=await within(inventory).findByRole('checkbox',{name:'Select notification IF-MIB::linkDown'});
    fireEvent.click(notice);
    expect(notice).toBeChecked();
    expect(within(inventory).getByRole('combobox',{name:'Notification module'})).toBeInTheDocument();
    expect(within(inventory).queryByRole('combobox',{name:'Status'})).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('region',{name:'Catalog export'})).toHaveTextContent('1 modules · 1 notifications selected');
  });
  it('exports the selected module names and notification OIDs rather than the entire catalog', async () => {
    mockApi(); setup(<MibsPage />);
    const inventory=screen.getByRole('region',{name:'Catalog & source inventory'});
    const moduleCheckbox=await within(inventory).findByRole('checkbox',{name:'Select IF-MIB'});
    fireEvent.click(moduleCheckbox);
    fireEvent.click(within(inventory).getByRole('button',{name:'Notifications'}));
    const notificationCheckbox=await within(inventory).findByRole('checkbox',{name:'Select notification IF-MIB::linkDown'});
    fireEvent.click(notificationCheckbox);
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(()=> 'blob:export-test'), revokeObjectURL: vi.fn(),
    }));
    vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
    const panel=screen.getByRole('region',{name:'Catalog export'});
    fireEvent.click(within(panel).getByRole('button',{name:'Export catalog'}));
    await waitFor(()=>expect(calls.some(c=>c.path==='/api/mibs/export' && c.method==='POST')).toBe(true));
    const body=JSON.parse(String(calls.find(c=>c.path==='/api/mibs/export')?.init.body));
    expect(body).toMatchObject({
      format:'json', export_type:'catalog', modules:['IF-MIB'], notifications:['1.3.6.1.6.3.1.1.5.3'],
    });
  });
  it('opens catalog header Add/Upload and fetches online by module name through the existing API', async () => {
    mockApi(); setup(<MibsPage />);
    const inventory=screen.getByRole('region',{name:'Catalog & source inventory'});
    fireEvent.click(within(inventory).getByRole('button',{name:'Add / upload'}));
    const dialog=await screen.findByRole('dialog',{name:'Add MIB sources'});
    expect(within(dialog).getByRole('button',{name:'Fetch by name'})).toHaveAttribute('aria-pressed','true');
    fireEvent.change(within(dialog).getByRole('textbox',{name:'MIB module names'}),{target:{value:'IF-MIB'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Fetch MIBs by name'}));
    await waitFor(()=>expect(calls.some(c=>c.path==='/api/mibs/fetch-dependencies' && c.method==='POST')).toBe(true));
    const req=calls.find(c=>c.path==='/api/mibs/fetch-dependencies');
    expect(JSON.parse(String(req?.init.body))).toEqual({dependencies:['IF-MIB'],reload_after_fetch:true});
    expect(await within(dialog).findByRole('region',{name:'Online MIB fetch results'})).toHaveTextContent('Downloaded: IF-MIB');
    fireEvent.click(within(dialog).getByRole('button',{name:'Upload files'}));
    expect(within(dialog).getByLabelText('Source files')).toBeInTheDocument();
    expect(within(dialog).getByRole('button',{name:'Validate'})).toBeDisabled();
    expect(calls.some(c=>c.path==='/api/mibs/upload')).toBe(false);
  });
  it('opens Reload and dependencies in a modal without triggering a compile before confirmation', async () => {
    mockApi(); setup(<MibsPage />);
    const inventory=screen.getByRole('region',{name:'Catalog & source inventory'});
    fireEvent.click(within(inventory).getByRole('button',{name:'Reload & dependencies'}));
    const dialog=await screen.findByRole('dialog',{name:'Reload & dependencies'});
    expect(within(dialog).getByLabelText(/Missing dependency names/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button',{name:'Recompile / reload stored MIBs'}));
    expect(calls.some(c=>c.path==='/api/mibs/reload'&&c.method==='POST')).toBe(false);
    expect(await screen.findByRole('dialog',{name:'Recompile the current MIB sources?'})).toBeInTheDocument();
  });
  it('MIB Manager lists active sources and bundles, preventing immediate destructive actions', async () => {
    mockApi(); setup(<MibsPage />);
    expect(await screen.findByText('bundle-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Sources'}));
    expect(await screen.findByText('uploads/IF-MIB')).toBeInTheDocument();
    const source = screen.getByRole('checkbox', { name: 'Select uploads/IF-MIB' });
    fireEvent.click(source);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    expect(calls.some(c => c.path === '/api/mibs/delete-batch')).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Delete selected MIB source files?' })).toBeInTheDocument();
  });
});

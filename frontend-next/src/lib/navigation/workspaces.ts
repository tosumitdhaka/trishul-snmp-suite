export const workspaces = [
  { path: '/', label: 'Dashboard', description: 'Runtime status and activity', group: 'Overview', icon: 'layout' },
  { path: '/simulator', label: 'Simulator', description: 'Responder lifecycle and custom values', group: 'Operations', icon: 'server' },
  { path: '/walker', label: 'Walk & Parse', description: 'Execute walks and inspect OIDs', group: 'Operations', icon: 'route' },
  { path: '/traps', label: 'Traps', description: 'Send notifications and monitor events', group: 'Operations', icon: 'bell' },
  { path: '/browser', label: 'MIB Browser', description: 'Explore symbols and OID trees', group: 'MIB Workbench', icon: 'network' },
  { path: '/mibs', label: 'MIB Manager', description: 'Manage MIB files and bundles', group: 'MIB Workbench', icon: 'database' },
  { path: '/settings', label: 'Settings', description: 'Credentials and app preferences', group: 'Account', icon: 'settings' },
] as const;
export type Workspace = (typeof workspaces)[number];

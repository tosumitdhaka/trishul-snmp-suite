import type { QueryClient } from '@tanstack/react-query';

export const BROWSER_STATE_KEY = 'trishul_next_browser_state';
export const BROWSER_ROOT_OID = '1.3.6.1';
export const BROWSER_TYPES = [
  { value: '', label: 'All types' },
  { value: 'MibScalar', label: 'Scalars' },
  { value: 'MibTable', label: 'Tables' },
  { value: 'MibTableRow', label: 'Table rows' },
  { value: 'MibTableColumn', label: 'Table columns' },
  { value: 'NotificationType', label: 'Notifications' },
  { value: 'ObjectGroup', label: 'Object groups' },
  { value: 'ModuleCompliance', label: 'Compliance' },
  { value: 'ModuleIdentity', label: 'Module identity' },
];
export type BrowserMode = 'module' | 'oid';
export interface BrowserNode {
  name?: string;
  oid: string;
  full_name?: string;
  module?: string;
  type?: string;
  syntax?: string;
  access?: string;
  status?: string;
  units?: string;
  description?: string;
  has_children?: boolean;
  indexes?: string[];
  constraints?: { kind?: string; data?: unknown };
  enums?: Record<string, number | string>;
}
export interface BrowserModule extends BrowserNode {
  name: string;
  module: string;
  object_count: number;
  children: BrowserNode[];
}
export interface BrowserState {
  mode: BrowserMode;
  module: string;
  typeFilter: string;
  search: string;
  rootOid: string;
  selected: BrowserNode | null;
  expanded: string[];
}
export function browserNodeKey(oid: string, module: string): string {
  return module + '|' + oid;
}
export function readBrowserState(): BrowserState {
  const fallback: BrowserState = { mode: 'module', module: '', typeFilter: '', search: '',
    rootOid: BROWSER_ROOT_OID, selected: null, expanded: [] };
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(BROWSER_STATE_KEY) || 'null');
    if (!value || typeof value !== 'object') return fallback;
    const data = value as Partial<BrowserState>;
    return {
      mode: data.mode === 'oid' ? 'oid' : 'module',
      module: typeof data.module === 'string' ? data.module.slice(0, 100) : '',
      typeFilter: BROWSER_TYPES.some(t => t.value === data.typeFilter) ? data.typeFilter! : '',
      search: typeof data.search === 'string' ? data.search.slice(0, 250) : '',
      rootOid: typeof data.rootOid === 'string' && /^\d+(?:\.\d+)*$/.test(data.rootOid)
        ? data.rootOid.slice(0, 100) : BROWSER_ROOT_OID,
      selected: data.selected && typeof data.selected.oid === 'string' ? data.selected : null,
      expanded: Array.isArray(data.expanded) ? data.expanded.filter((s): s is string => typeof s === 'string').slice(0, 120) : [],
    };
  } catch { return fallback; }
}

/** Export the server-loaded *visible* module roots and descendants, never a fictitious full-catalog export. */
export function flatVisibleNodes(
  modules: BrowserModule[],
  expanded: Set<string>,
  cache: QueryClient,
  bundleId: number | null,
  typeFilter: string,
): BrowserNode[] {
  const found: BrowserNode[] = [];
  function walk(node: BrowserNode, module: string, depth: number) {
    if (depth > 20 || found.length >= 1500) return;
    found.push({ ...node, module: node.module || module });
    const key = browserNodeKey(node.oid, node.module || module);
    if (!expanded.has(key) || !node.has_children) return;
    const cached = cache.getQueryData<{ children?: BrowserNode[] }>([
      'browser', 'children', bundleId, node.oid, node.module || module, typeFilter,
    ]);
    for (const child of cached?.children || []) walk(child, module, depth + 1);
  }
  for (const mod of modules) {
    if (found.length >= 1500) break;
    found.push({ name: mod.name, module: mod.module, oid: mod.oid, type: 'Module' });
    if (expanded.has('module:' + mod.name) || modules.length === 1) {
      for (const node of mod.children || []) walk(node, mod.module, 0);
    }
  }
  return found;
}

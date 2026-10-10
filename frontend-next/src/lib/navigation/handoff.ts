/**
 * One-shot, same-tab navigation context between the seven React workspaces.
 * Never persist auth tokens, SNMP communities, or received trap payloads.
 * This is only a form-prefill hint; the destination/backend validates again.
 */
export interface BrowserHandoff {
  query?: string;
  module?: string;
  type?: string;
  mode?: 'module' | 'oid';
  rootOid?: string;
}
export interface WalkerHandoff {
  oid?: string;
  target?: string;
  port?: number;
}
export interface TrapMember {
  name: string;
  oid: string;
  input_type?: string;
}
export interface TrapHandoff {
  oid: string;
  full_name?: string;
  name?: string;
  objects?: TrapMember[];
}
type Destination = 'browser' | 'walker' | 'traps';
const PREFIX = 'trishul_next_handoff_';
const MAX_SIZE = 12_000;
function clean(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, max);
  return normalized || undefined;
}
function save(destination: Destination, input: unknown): boolean {
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length > MAX_SIZE) return false;
    sessionStorage.setItem(PREFIX + destination, serialized);
    return true;
  } catch { return false; }
}
function take(destination: Destination): unknown {
  try {
    const key = PREFIX + destination;
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return raw && raw.length <= MAX_SIZE ? JSON.parse(raw) as unknown : null;
  } catch { return null; }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
export function sendToBrowser(input: BrowserHandoff): boolean {
  const rawQuery = clean(input.query), module = clean(input.module, 100), type = clean(input.type, 60);
  const numericOid = /^\d+(?:\.\d+)*$/;
  const rootOid = clean(input.rootOid, 300) || (rawQuery && numericOid.test(rawQuery) ? rawQuery : undefined);
  const mode = (input.mode === 'oid' || (rootOid && numericOid.test(rootOid))) ? 'oid' : 'module';
  if (mode === 'oid' && (!rootOid || !numericOid.test(rootOid))) return false;
  if (mode === 'module' && !rawQuery && !module) return false;
  return save('browser', { query: mode === 'module' ? rawQuery : undefined, module, type, mode, rootOid });
}
export function takeBrowserHandoff(): BrowserHandoff | null {
  const data = record(take('browser'));
  if (!data) return null;
  const query = clean(data.query), module = clean(data.module, 100), type = clean(data.type, 60);
  const rootOid = clean(data.rootOid, 300);
  const mode = data.mode === 'oid' && rootOid && /^\d+(?:\.\d+)*$/.test(rootOid) ? 'oid' : 'module';
  return query || module || mode === 'oid' ? { query, module, type, rootOid, mode } : null;
}
export function sendToWalker(input: WalkerHandoff): boolean {
  const oid = clean(input.oid, 300), target = clean(input.target, 200);
  const port = typeof input.port === 'number' && Number.isInteger(input.port) &&
    input.port >= 1 && input.port <= 65535 ? input.port : undefined;
  if (!oid && !target && !port) return false;
  return save('walker', { oid, target, port });
}
export function takeWalkerHandoff(): WalkerHandoff | null {
  const data = record(take('walker'));
  if (!data) return null;
  const oid = clean(data.oid, 300), target = clean(data.target, 200);
  const port = typeof data.port === 'number' && Number.isInteger(data.port) &&
    data.port >= 1 && data.port <= 65535 ? data.port : undefined;
  return oid || target || port ? { oid, target, port } : null;
}
export function sendToTraps(input: TrapHandoff): boolean {
  const oid = clean(input.oid, 300);
  if (!oid) return false;
  const objects = Array.isArray(input.objects) ? input.objects.slice(0, 100)
    .map(item => ({ name: clean(item.name) || '', oid: clean(item.oid, 300) || '',
      input_type: clean(item.input_type, 60) }))
    .filter(item => item.oid) : [];
  return save('traps', { oid, full_name: clean(input.full_name, 300),
    name: clean(input.name), objects });
}
export function takeTrapHandoff(): TrapHandoff | null {
  const data = record(take('traps'));
  const oid = data && clean(data.oid, 300);
  if (!oid) return null;
  const objects = Array.isArray(data!.objects) ? data!.objects.slice(0, 100)
    .map(item => record(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map(item => ({ name: clean(item.name) || '', oid: clean(item.oid, 300) || '',
      input_type: clean(item.input_type, 60) }))
    .filter(item => item.oid) : [];
  return { oid, full_name: clean(data!.full_name, 300),
    name: clean(data!.name), objects };
}

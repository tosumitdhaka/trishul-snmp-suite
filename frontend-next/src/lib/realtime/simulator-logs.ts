export type SimulatorLogEntry = Record<string, unknown>;
export interface SimulatorLogData { items?: SimulatorLogEntry[]; total?: number; [key: string]: unknown }
export const MAX_SIMULATOR_LOG_ROWS = 200;
export function appendSimulatorLog(old: SimulatorLogData | undefined, entry: SimulatorLogEntry): SimulatorLogData {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return old ?? { items: [] };
  const previous = Array.isArray(old?.items) ? old.items : [];
  const signature = JSON.stringify(entry);
  if (previous.some(row => JSON.stringify(row) === signature)) return old ?? { items: previous };
  const items = [...previous, entry].slice(-MAX_SIMULATOR_LOG_ROWS);
  return { ...old, items, total: Math.max(old?.total ?? 0, items.length) };
}

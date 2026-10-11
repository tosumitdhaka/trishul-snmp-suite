/** One-time removal of legacy full-payload localStorage history (F01). */
export function purgeLegacyWalkHistory(storage?: Pick<Storage, 'removeItem'>): void {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    target?.removeItem('trishul_next_walk_history');
  } catch { /* Storage may be blocked; do not write any new sensitive data. */ }
}

import { describe, expect, it } from 'vitest';
import { formatCount, getActivityCounts, normalizeMibSummary, runtimeText } from '../src/features/dashboard/dashboard-model';

describe('dashboard API and WebSocket parity', () => {
  it('normalizes REST module and source group arrays', () => {
    expect(normalizeMibSummary({
      loaded: 2, mibs: [{ traps: 3 }, { traps: 4 }],
      source_groups: [{ file_count: 5 }, { file_count: 8 }],
    })).toMatchObject({ loaded: 2, traps_available: 7, source_files: 13 });
  });
  it('preserves already-normalized WebSocket summary', () => {
    expect(normalizeMibSummary({ loaded: 3, traps_available: 6, source_files: 9 }))
      .toMatchObject({ loaded: 3, traps_available: 6, source_files: 9 });
  });
  it('does not fabricate counts on missing fields and respects zero', () => {
    expect(normalizeMibSummary({ loaded: 0 }).traps_available).toBe(0);
    expect(normalizeMibSummary({ loaded: 8 }).traps_available).toBeUndefined();
    expect(normalizeMibSummary({ loaded: 1, mibs: [], source_groups: [] }))
      .toMatchObject({ traps_available: 0, source_files: 0 });
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(0)).toBe('0');
  });
  it('keeps missing status separate from a stopped responder', () => {
    expect(runtimeText(undefined, false, true)).toBe('Unavailable');
    expect(runtimeText({ running: false }, false, false)).toBe('Stopped');
    expect(runtimeText({ running: false }, false, true)).toBe('Last known: Stopped');
    expect(runtimeText({ running: true }, false, false)).toBe('Running');
  });
  it('includes every legacy activity counter in a stable order', () => {
    const metrics = getActivityCounts(
      {
        simulator: { snmp_requests_served: 9, oids_loaded: 10 },
        traps: { traps_received_total: 11, traps_sent_total: 12 },
        walker: { walks_executed: 13, oids_returned: 14 },
        mibs: { upload_count: 15, reload_count: 16 },
      },
      { source_files: 200 },
    );
    expect(metrics.map((metric) => metric.label)).toEqual([
      'SNMP requests', 'OIDs loaded', 'Traps received', 'Traps sent',
      'Walks executed', 'OIDs returned', 'MIB sources', 'MIB reloads',
    ]);
    expect(metrics.map((metric) => metric.value)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
  it('uses known source group counts when stats upload count is missing', () => {
    expect(getActivityCounts({ mibs: {} }, { source_files: 8 })[6].value).toBe(8);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { purgeLegacyWalkHistory, walkColumns, walkRows, walkTsv } from './walk-table';

describe('walk privacy and complete table export', () => {
  it('removes the former durable full-payload key without attempting a write', () => {
    const removeItem = vi.fn();
    purgeLegacyWalkHistory({ removeItem });
    expect(removeItem).toHaveBeenCalledWith('trishul_next_walk_history');
  });
  it('exports all rows and columns introduced after the first 100 rows', () => {
    const data = Array.from({ length: 2401 }, (_, index) => ({
      oid: '1.3.6.' + index, value: 'value-' + index, ...(index === 2200 ? { lateColumn: 'never-truncate' } : {}),
    }));
    const rows = walkRows(data), columns = walkColumns(rows);
    const tsv = walkTsv(rows, columns);
    expect(rows).toHaveLength(2401);
    expect(columns).toContain('lateColumn');
    expect(tsv.split('\n')).toHaveLength(2402);
    expect(tsv).toContain('never-truncate');
    expect(tsv).toContain('value-2400');
  });
  it('preserves object-shaped OID results and neutralizes spreadsheet-leading formula values', () => {
    const rows = walkRows({ '1.3.6.1': { metric: '=HYPERLINK("bad")' } });
    expect(rows).toEqual([{ oid: '1.3.6.1', metric: '=HYPERLINK("bad")' }]);
    expect(walkTsv(rows)).toContain("'=HYPERLINK");
  });
});

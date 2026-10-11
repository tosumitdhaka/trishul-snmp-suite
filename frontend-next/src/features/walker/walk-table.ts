/** Canonical, lossless tabular walk projection. Limit *only* DOM preview, never export. */
export function walkRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map(row =>
    row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : { value: row });
  if (data && typeof data === 'object' && !Array.isArray(data))
    return Object.entries(data).map(([oid, value]) =>
      value && typeof value === 'object' && !Array.isArray(value) ? { oid, ...value as Record<string, unknown> } : { oid, value });
  return [];
}
export function walkColumns(rows: readonly Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap(row => Object.keys(row)))];
}
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '—' :
    typeof value === 'object' ? JSON.stringify(value) : String(value);
}
/** Spreadsheet-safe text; JSON export retains exact source values. */
function tsvCell(value: unknown): string {
  const text = valueText(value).replace(/[\t\r\n]/g, ' ');
  return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
}
export function walkTsv(rows: readonly Record<string, unknown>[], columns = walkColumns(rows)): string {
  return [columns.map(key => tsvCell(key)).join('\t'),
    ...rows.map(row => columns.map(key => tsvCell(row[key])).join('\t'))].join('\n');
}
export { purgeLegacyWalkHistory } from '../../lib/privacy/walk-history';

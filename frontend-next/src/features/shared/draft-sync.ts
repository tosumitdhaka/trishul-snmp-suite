/** Poll results can update untouched fields, but cannot replace operator drafts. */
export function syncUntouched<T>(current: T, server: T, touched: boolean): T {
  return touched ? current : server;
}

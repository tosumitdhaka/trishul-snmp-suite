/** HTTP 2xx indicates transport completion, not necessarily a successful SNMP/MIB operation. */
export type ActionOutcome = { tone: 'success' | 'warning' | 'error'; detail?: string };
export function assessActionOutcome(path: string, payload: unknown): ActionOutcome {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { tone: 'success' };
  const data = payload as Record<string, unknown>;
  if (path.split('?')[0] === '/api/traps/send-inform') {
    const response = data.response && typeof data.response === 'object' ? data.response as Record<string, unknown> : {};
    if (typeof response.error_status_code === 'number' && response.error_status_code !== 0)
      return { tone: 'error', detail: 'SNMP Inform acknowledgment: ' + String(response.error_status || 'error status ' + response.error_status_code) };
  }
  if (typeof data.compile_error === 'string' && data.compile_error.trim())
    return { tone: 'warning', detail: 'Compile issues: ' + data.compile_error };
  const failed = Array.isArray(data.failed) ? data.failed : [];
  const results = Array.isArray(data.results) ? data.results as Record<string, unknown>[] : [];
  const problemRows = results.filter(item => ['failed', 'error', 'skipped'].includes(String(item.status || '').toLowerCase()));
  const warnings = Array.isArray(data.custom_data_warnings) ? data.custom_data_warnings : [];
  if (failed.length || problemRows.length || warnings.length) {
    const successes = ['downloaded','resolved','cached'].some(key => Array.isArray(data[key]) && (data[key] as unknown[]).length > 0)
      || results.some(item => ['loaded','success','ok','ready','uploaded'].includes(String(item.status || '').toLowerCase()));
    const partial = successes || warnings.length > 0;
    const detail = warnings.length ? warnings.map(String).join('; ') :
      failed.length ? failed.map(String).join(', ') + ' unresolved' :
      problemRows.length + ' item(s) failed or skipped';
    return { tone: partial ? 'warning' : 'error', detail };
  }
  return { tone: 'success' };
}

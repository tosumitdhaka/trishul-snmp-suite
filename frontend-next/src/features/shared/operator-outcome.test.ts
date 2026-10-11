import { describe, expect, it } from 'vitest';
import { assessActionOutcome } from './operator-outcome';
describe('SNMP operation notification outcomes', () => {
  it('does not call an Inform with a nonzero SNMP error successful', () => {
    expect(assessActionOutcome('/api/traps/send-inform', { response: { error_status_code: 5, error_status: 'genErr' } }))
      .toEqual({ tone: 'error', detail: 'SNMP Inform acknowledgment: genErr' });
  });
  it('distinguishes unresolved-only MIB fetch from partial results', () => {
    expect(assessActionOutcome('/api/mibs/fetch-dependencies', { failed: ['CERAGON-MIB'], downloaded: [] }).tone).toBe('error');
    expect(assessActionOutcome('/api/mibs/fetch-dependencies', { failed: ['CERAGON-MIB'], resolved: ['IF-MIB'] }).tone).toBe('warning');
  });
  it('recognizes simulator override warnings and complete successes', () => {
    expect(assessActionOutcome('/api/simulator/start', { custom_data_warnings: ['OID skipped'] }).tone).toBe('warning');
    expect(assessActionOutcome('/api/traps/send', { sent: true }).tone).toBe('success');
  });
});

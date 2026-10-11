import { describe, expect, it } from 'vitest';
import { syncUntouched } from './draft-sync';
describe('configuration draft reconciliation', () => {
  it('preserves edited ports and communities across repeated polls/reconnect', () => {
    expect(syncUntouched('1163', '1162', true)).toBe('1163');
    expect(syncUntouched('private-draft', 'old-server-value', true)).toBe('private-draft');
    expect(syncUntouched('1162', '1164', false)).toBe('1164');
  });
});

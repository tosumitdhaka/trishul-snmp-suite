// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { searchWorkspaces } from '../src/components/shell/WorkspaceSearch';

describe('workspace command search', () => {
  it('lists all seven destinations with no query', () => {
    expect(searchWorkspaces('').length).toBe(7);
  });
  it('matches an operational synonym without inventing routes', () => {
    expect(searchWorkspaces('inform').map((item) => item.path)).toEqual(['/traps']);
    expect(searchWorkspaces('snmpwalk').map((item) => item.path)).toEqual(['/walker']);
    expect(searchWorkspaces('mib bundle').map((item) => item.path)).toEqual(['/mibs']);
    expect(searchWorkspaces('does-not-exist')).toEqual([]);
  });
});

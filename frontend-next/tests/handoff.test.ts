// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sendToBrowser, takeBrowserHandoff, sendToWalker, takeWalkerHandoff,
  sendToTraps, takeTrapHandoff,
} from '../src/lib/navigation/handoff';

afterEach(() => sessionStorage.clear());

describe('one-shot cross-workspace navigation context', () => {
  it('routes numeric OIDs into the numeric tree rather than symbolic text search', () => {
    expect(sendToBrowser({ query: '1.3.6.1.2.1.2' })).toBe(true);
    expect(takeBrowserHandoff()).toEqual({
      query: undefined, module: undefined, type: undefined,
      mode: 'oid', rootOid: '1.3.6.1.2.1.2',
    });
    expect(takeBrowserHandoff()).toBeNull();
  });
  it('keeps symbolic names and module filters, consuming them once', () => {
    sendToBrowser({ query: 'IF-MIB::linkDown', module: 'IF-MIB', type: 'NotificationType' });
    expect(takeBrowserHandoff()).toEqual({
      query: 'IF-MIB::linkDown', module: 'IF-MIB',
      type: 'NotificationType', mode: 'module', rootOid: undefined,
    });
    sendToBrowser({ module: 'IF-MIB' });
    expect(takeBrowserHandoff()).toMatchObject({ mode: 'module', module: 'IF-MIB' });
  });
  it('transfers simulator network defaults but never SNMP communities', () => {
    expect(sendToWalker({ target: '127.0.0.1', port: 1061 })).toBe(true);
    const raw = sessionStorage.getItem('trishul_next_handoff_walker');
    expect(raw).not.toContain('public');
    expect(takeWalkerHandoff()).toEqual({ target: '127.0.0.1', port: 1061, oid: undefined });
    expect(takeWalkerHandoff()).toBeNull();
    expect(sendToWalker({ port: 80000 })).toBe(false);
  });
  it('only stores allowed trap definition fields, never unknown secret fields', () => {
    expect(sendToTraps({
      oid: '1.3.6.1.6.3.1.1.5.3', full_name: 'IF-MIB::linkDown',
      objects: [{ name: 'ifIndex', oid: '1.3.6.1.2.1.2.2.1.1', input_type: 'Integer' }],
      community: 'should-not-persist',
    } as Parameters<typeof sendToTraps>[0])).toBe(true);
    const raw = sessionStorage.getItem('trishul_next_handoff_traps');
    expect(raw).not.toContain('should-not-persist');
    expect(takeTrapHandoff()).toMatchObject({ oid: '1.3.6.1.6.3.1.1.5.3',
      objects: [{ name: 'ifIndex', oid: '1.3.6.1.2.1.2.2.1.1', input_type: 'Integer' }] });
    expect(takeTrapHandoff()).toBeNull();
  });
  it('fails closed for malformed stored context', () => {
    sessionStorage.setItem('trishul_next_handoff_traps', '{bad-json');
    expect(takeTrapHandoff()).toBeNull();
    sessionStorage.setItem('trishul_next_handoff_browser', JSON.stringify({mode:'oid',rootOid:'hello'}));
    expect(takeBrowserHandoff()).toBeNull();
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendBatchedSimulatorLog,
  countLogsByLevel,
  defaultValueForVarbind,
  filterPaletteItems,
  formatConstraintHint,
  formatEnrichedValue,
  formatUptime,
  inferSnmpVarbindType,
  normalizeConstraint,
  normalizeEnums,
  toCsv,
  toTsv,
  validateVarbindInput,
} from './workbench';

describe('frontend-next pure workbench helpers', () => {
  it('formats uptime across seconds, minutes, hours, and days', () => {
    assert.equal(formatUptime(null), '—');
    assert.equal(formatUptime(42), '42s');
    assert.equal(formatUptime(125), '2m 5s');
    assert.equal(formatUptime(3660), '1h 1m');
    assert.equal(formatUptime(90000), '1d 1h');
  });

  it('escapes and serializes CSV and TSV rows accurately', () => {
    const csv = toCsv(
      [
        { oid: '1.3.6.1.2.1.1.1.0', value: 'Linux "Trishul", Lab' },
        { oid: '1.3.6.1.2.1.1.3.0', value: '42000' },
      ],
      [
        { key: 'oid', label: 'OID' },
        { key: 'value', label: 'Value' },
      ]
    );
    assert.equal(
      csv,
      '"OID","Value"\n"1.3.6.1.2.1.1.1.0","Linux ""Trishul"", Lab"\n"1.3.6.1.2.1.1.3.0","42000"'
    );

    const tsv = toTsv(
      [{ oid: 'IF-MIB::ifDescr.1', value: 'eth0\tuplink\nline2' }],
      [
        { key: 'oid', label: 'OID' },
        { key: 'value', label: 'Value' },
      ]
    );
    assert.equal(tsv, 'OID\tValue\nIF-MIB::ifDescr.1\teth0 uplink line2');
  });

  it('normalizes enums from maps, tuple arrays, and object lists sorted by numeric value', () => {
    assert.deepEqual(normalizeEnums({ down: 2, up: 1, testing: 3 }), [
      { label: 'up', value: 1 },
      { label: 'down', value: 2 },
      { label: 'testing', value: 3 },
    ]);
    assert.deepEqual(
      normalizeEnums({
        kind: 'enum',
        data: [
          ['testing', 3],
          ['up', 1],
        ],
      }),
      [
        { label: 'up', value: 1 },
        { label: 'testing', value: 3 },
      ]
    );
  });

  it('formats enriched SNMP values with enum labels and units', () => {
    assert.equal(
      formatEnrichedValue('1', { enumLabel: 'up', units: 'bps' }),
      '1 up(1) bps'
    );
  });

  it('batches rapid GETNEXT simulator log bursts within 1200ms window and counts levels', () => {
    const t0 = '2026-11-21T10:00:00.000Z';
    const t1 = '2026-11-21T10:00:00.400Z';
    const t2 = '2026-11-21T10:00:05.000Z';

    let logs = appendBatchedSimulatorLog([], {
      level: 'info',
      request_type: 'GETNEXT',
      request_count: 1,
      oid_count: 1,
      first_requested_oid: '1.3.6.1.2.1.1',
      first_returned_oid: '1.3.6.1.2.1.1.1.0',
      timestamp: t0,
      message: 'GETNEXT 1.3.6.1.2.1.1',
    });
    logs = appendBatchedSimulatorLog(logs, {
      level: 'info',
      request_type: 'GETNEXT',
      request_count: 1,
      oid_count: 1,
      first_requested_oid: '1.3.6.1.2.1.1.1.0',
      first_returned_oid: '1.3.6.1.2.1.1.2.0',
      timestamp: t1,
      message: 'GETNEXT 1.3.6.1.2.1.1.1.0',
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].request_count, 2);
    assert.equal(logs[0].oid_count, 2);
    assert.ok(logs[0].message.includes('2 GETNEXT requests, 2 OIDs'));

    logs = appendBatchedSimulatorLog(logs, {
      level: 'success',
      timestamp: t2,
      message: 'Simulator started',
    });
    assert.equal(logs.length, 2);
    assert.deepEqual(countLogsByLevel(logs), {
      all: 2,
      info: 1,
      success: 1,
      warning: 0,
      error: 0,
    });
  });

  it('ranks command palette items by exact, prefix, substring, and keyword match', () => {
    const items = [
      { id: '1', label: 'Settings', group: 'Nav', keywords: ['auth', 'password'] },
      { id: '2', label: 'SNMP Simulator', group: 'Nav', keywords: ['agent', 'responder'] },
      { id: '3', label: 'Start Simulator', group: 'Actions', keywords: ['run'] },
    ];
    const ranked = filterPaletteItems(items, 'sim');
    assert.deepEqual(
      ranked.map((r) => r.id),
      ['2', '3']
    );
    const byKw = filterPaletteItems(items, 'password');
    assert.deepEqual(
      byKw.map((r) => r.id),
      ['1']
    );
  });

  it('infers SNMP varbind types, formats constraints, and auto-fills smart defaults', () => {
    assert.equal(inferSnmpVarbindType({ syntax: 'TimeStamp', name: 'sysORLastChange' }), 'TimeTicks');
    assert.equal(inferSnmpVarbindType({ syntax: 'Gauge32', name: 'ifSpeed' }), 'Gauge32');
    assert.equal(inferSnmpVarbindType({ syntax: 'Counter64', name: 'ifHCInOctets' }), 'Counter64');
    assert.equal(inferSnmpVarbindType({ name: 'peerIpAddress' }), 'IpAddress');

    const rangeConstraint = { type: 'range', ranges: [[1, 2147483647]] as Array<[number, number]> };
    assert.deepEqual(normalizeConstraint(rangeConstraint), { kind: 'range', ranges: [[1, 2147483647]] });
    assert.equal(formatConstraintHint(rangeConstraint, 'Integer'), 'Range: 1..2147483647');
    assert.equal(formatConstraintHint(rangeConstraint, 'String'), '');

    const sizeConstraint = { kind: 'size', data: [[0, 255]] as Array<[number, number]> };
    assert.equal(formatConstraintHint(sizeConstraint, 'String'), 'Length: 0..255 bytes');

    assert.equal(defaultValueForVarbind('Integer', [{ label: 'up', value: 1 }]), '1');
    assert.equal(defaultValueForVarbind('Integer', [], { type: 'range', ranges: [[10, 50]] }), '10');
    assert.equal(defaultValueForVarbind('IpAddress'), '127.0.0.1');
  });

  it('validates varbind values against types, enums, ranges, UTF-8 byte sizes, and IP/OID syntax', () => {
    assert.equal(
      validateVarbindInput({
        oid: 'IF-MIB::ifIndex',
        type: 'Integer',
        value: '0',
        constraint: { type: 'range', ranges: [[1, 2147483647]] },
      }),
      'Value outside Range: 1..2147483647.'
    );
    assert.equal(
      validateVarbindInput({
        oid: 'IF-MIB::ifAdminStatus',
        type: 'Integer',
        value: '9',
        enumValues: [
          { label: 'up', value: 1 },
          { label: 'down', value: 2 },
        ],
      }),
      'Select one of the declared MIB enum values.'
    );
    assert.equal(
      validateVarbindInput({
        oid: 'SNMPv2-MIB::sysName.0',
        type: 'String',
        value: 'abcdef',
        constraint: { type: 'size', ranges: [[1, 4]] },
      }),
      'Byte length (6) outside Length: 1..4 bytes.'
    );
    assert.equal(
      validateVarbindInput({ oid: '1.3.6.1.2.1.4.20', type: 'IpAddress', value: '999.1.1.1' }),
      'Enter a valid IPv4 address (e.g. 127.0.0.1).'
    );
    assert.equal(
      validateVarbindInput({ oid: '1.3.6.1.2.1.1.2.0', type: 'OID', value: '1.3.6.1.4.1.8072' }),
      null
    );
  });
});

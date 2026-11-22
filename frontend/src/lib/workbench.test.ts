import { describe, expect, it } from 'vitest';
import { formatApiErrorDetail } from './api';
import {
  appendBatchedSimulatorLog,
  compareOidNodes,
  countLogsByLevel,
  defaultValueForVarbind,
  evaluatePasswordStrength,
  filterPaletteItems,
  formatConstraintHint,
  formatEnrichedValue,
  formatSmiConstraints,
  formatUptime,
  inferSnmpVarbindType,
  isInformAcknowledged,
  isNumericOid,
  normalizeConstraint,
  normalizeEnums,
  normalizeWalkTableRows,
  toCsv,
  toTsv,
  validateRemoteSourceUrl,
  validateVarbindInput,
} from './workbench';

describe('frontend-next pure workbench helpers', () => {
  it('formats uptime across seconds, minutes, hours, and days', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(3660)).toBe('1h 1m');
    expect(formatUptime(90000)).toBe('1d 1h');
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
    expect(csv).toBe(
      '"OID","Value"\n"1.3.6.1.2.1.1.1.0","Linux ""Trishul"", Lab"\n"1.3.6.1.2.1.1.3.0","42000"'
    );

    const tsv = toTsv(
      [{ oid: 'IF-MIB::ifDescr.1', value: 'eth0\tuplink\nline2' }],
      [
        { key: 'oid', label: 'OID' },
        { key: 'value', label: 'Value' },
      ]
    );
    expect(tsv).toBe('OID\tValue\nIF-MIB::ifDescr.1\teth0 uplink line2');
  });

  it('normalizes enums from maps, tuple arrays, and object lists sorted by numeric value', () => {
    expect(normalizeEnums({ down: 2, up: 1, testing: 3 })).toEqual([
      { label: 'up', value: 1 },
      { label: 'down', value: 2 },
      { label: 'testing', value: 3 },
    ]);
    expect(
      normalizeEnums({
        kind: 'enum',
        data: [
          ['testing', 3],
          ['up', 1],
        ],
      })
    ).toEqual([
      { label: 'up', value: 1 },
      { label: 'testing', value: 3 },
    ]);
  });

  it('formats enriched SNMP values with enum labels and units', () => {
    expect(formatEnrichedValue('1', { enumLabel: 'up', units: 'bps' })).toBe('1 up(1) bps');
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
    expect(logs).toHaveLength(1);
    expect(logs[0].request_count).toBe(2);
    expect(logs[0].oid_count).toBe(2);
    expect(logs[0].message).toContain('2 GETNEXT requests, 2 OIDs');

    logs = appendBatchedSimulatorLog(logs, {
      level: 'success',
      timestamp: t2,
      message: 'Simulator started',
    });
    expect(logs).toHaveLength(2);
    expect(countLogsByLevel(logs)).toEqual({
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
    expect(filterPaletteItems(items, 'sim').map((r) => r.id)).toEqual(['2', '3']);
    expect(filterPaletteItems(items, 'password').map((r) => r.id)).toEqual(['1']);
  });

  it('infers SNMP varbind types, formats constraints, and defaults String safely', () => {
    expect(inferSnmpVarbindType({ syntax: 'TimeStamp', name: 'sysORLastChange' })).toBe('TimeTicks');
    expect(inferSnmpVarbindType({ syntax: 'Gauge32', name: 'ifSpeed' })).toBe('Gauge32');
    expect(inferSnmpVarbindType({ syntax: 'Counter64', name: 'ifHCInOctets' })).toBe('Counter64');
    expect(inferSnmpVarbindType({ name: 'peerIpAddress' })).toBe('IpAddress');

    const rangeConstraint = { type: 'range', ranges: [[1, 2147483647]] as Array<[number, number]> };
    expect(normalizeConstraint(rangeConstraint)).toEqual({
      kind: 'range',
      ranges: [[1, 2147483647]],
    });
    expect(formatConstraintHint(rangeConstraint, 'Integer')).toBe('Range: 1..2147483647');
    expect(formatConstraintHint(rangeConstraint, 'String')).toBe('');

    const sizeConstraint = { kind: 'size', data: [[0, 255]] as Array<[number, number]> };
    expect(formatConstraintHint(sizeConstraint, 'String')).toBe('Length: 0..255 bytes');

    expect(defaultValueForVarbind('Integer', [{ label: 'up', value: 1 }])).toBe('1');
    expect(defaultValueForVarbind('Integer', [], { type: 'range', ranges: [[10, 50]] })).toBe('10');
    expect(defaultValueForVarbind('IpAddress')).toBe('127.0.0.1');
    expect(defaultValueForVarbind('String')).toBe('test');
    expect(defaultValueForVarbind('String', [], { kind: 'size', ranges: [[6, 6]] })).toBe('aaaaaa');
    expect(
      validateVarbindInput({
        oid: 'SNMPv2-MIB::sysContact.0',
        type: 'String',
        value: defaultValueForVarbind('String', [], sizeConstraint),
        constraint: sizeConstraint,
      })
    ).toBeNull();
  });

  it('validates varbind values against types, enums, ranges, UTF-8 byte sizes, and IP/OID syntax', () => {
    expect(
      validateVarbindInput({
        oid: 'IF-MIB::ifIndex',
        type: 'Integer',
        value: '0',
        constraint: { type: 'range', ranges: [[1, 2147483647]] },
      })
    ).toBe('Value outside Range: 1..2147483647.');

    expect(
      validateVarbindInput({
        oid: 'IF-MIB::ifAdminStatus',
        type: 'Integer',
        value: '9',
        enumValues: [
          { label: 'up', value: 1 },
          { label: 'down', value: 2 },
        ],
      })
    ).toBe('Select one of the declared MIB enum values.');

    expect(
      validateVarbindInput({
        oid: 'SNMPv2-MIB::sysName.0',
        type: 'String',
        value: 'abcdef',
        constraint: { type: 'size', ranges: [[1, 4]] },
      })
    ).toBe('Byte length (6) outside Length: 1..4 bytes.');

    expect(
      validateVarbindInput({ oid: '1.3.6.1.2.1.4.20', type: 'IpAddress', value: '999.1.1.1' })
    ).toBe('Enter a valid IPv4 address (e.g. 127.0.0.1).');

    expect(
      validateVarbindInput({ oid: '1.3.6.1.2.1.1.2.0', type: 'OID', value: '1.3.6.1.4.1.8072' })
    ).toBeNull();
  });

  it('formats FastAPI 422 array errors and plain string details', () => {
    expect(
      formatApiErrorDetail(
        {
          detail: [
            { loc: ['body', 'timeout_ms'], msg: 'Input should be less than or equal to 10000' },
            { loc: ['body', 'retries'], msg: 'Input should be greater than or equal to 0' },
          ],
        },
        422
      )
    ).toBe(
      'timeout_ms: Input should be less than or equal to 10000; retries: Input should be greater than or equal to 0'
    );
    expect(formatApiErrorDetail({ detail: 'Invalid community' }, 400)).toBe('Invalid community');
    expect(formatApiErrorDetail(null, 502)).toBe('HTTP 502');
  });

  it('identifies numeric OIDs and sorts OID nodes numerically via oid_tuple', () => {
    expect(isNumericOid('1.3.6.1.2.1.1')).toBe(true);
    expect(isNumericOid('.1.3.6.1.2.1.2.2.1.8')).toBe(true);
    expect(isNumericOid('IF-MIB::ifDescr')).toBe(false);

    const nodes = [
      { oid: '1.3.6.1.2.1.10', oid_tuple: [1, 3, 6, 1, 2, 1, 10], name: 'transmission' },
      { oid: '1.3.6.1.2.1.2', oid_tuple: [1, 3, 6, 1, 2, 1, 2], name: 'interfaces' },
      { oid: '1.3.6.1.2.1.1', oid_tuple: [1, 3, 6, 1, 2, 1, 1], name: 'system' },
    ];
    expect(nodes.sort(compareOidNodes).map((n) => n.name)).toEqual([
      'system',
      'interfaces',
      'transmission',
    ]);
  });

  it('formats SMI constraints into readable badges and checks Inform ACKs accurately', () => {
    expect(
      formatSmiConstraints({
        kind: 'union',
        constraints: [
          { kind: 'size', ranges: [[0, 255]] },
          { kind: 'range', ranges: [[1, 100]] },
        ],
      })
    ).toEqual(['Size: 0..255 bytes', 'Range: 1..100']);

    expect(
      isInformAcknowledged({
        status: 'sent',
        response: { error_status_code: 0 },
      })
    ).toEqual({ ok: true, errorCode: 0 });

    expect(
      isInformAcknowledged({
        status: 'sent',
        response: { error_status_code: 2, error_status: 'noSuchName' },
      })
    ).toEqual({ ok: false, errorCode: 2, detail: 'noSuchName' });
  });

  it('normalizes flat, grouped, and raw walk results for table/CSV/TSV display', () => {
    const grouped = normalizeWalkTableRows({
      json_format: 'grouped',
      count: 1,
      data: [
        {
          metric_name: 'ifInOctets',
          value: 4096,
          mib_module: 'IF-MIB',
          metric_category: 'interface',
          labels: { ifIndex: 1 },
          numeric_oid: '1.3.6.1.2.1.2.2.1.10.1',
          units: 'octets',
        },
      ],
    });
    expect(grouped).toHaveLength(1);
    expect(grouped[0].symbolic).toBe('ifInOctets');
    expect(grouped[0].labelsText).toBe('ifIndex=1');
    expect(grouped[0].numericOid).toBe('1.3.6.1.2.1.2.2.1.10.1');

    const raw = normalizeWalkTableRows({
      mode: 'raw',
      json_format: 'flat',
      count: 1,
      rawLines: ['SNMPv2-MIB::sysName.0 = STRING: trishul-lab'],
      data: ['SNMPv2-MIB::sysName.0 = STRING: trishul-lab'],
    });
    expect(raw).toHaveLength(1);
    expect(raw[0].oid).toBe('SNMPv2-MIB::sysName.0');
    expect(raw[0].type).toBe('STRING');
    expect(raw[0].value).toBe('trishul-lab');
  });

  it('validates remote MIB source URLs and password strength', () => {
    expect(validateRemoteSourceUrl('https://mibs.pysnmp.com/asn1/@mib@')).toBeNull();
    expect(validateRemoteSourceUrl('https://example.com/mibs/')).toContain('@mib@');
    expect(validateRemoteSourceUrl('ftp://example.com/@mib@')).toContain('Unsupported URL scheme');

    expect(evaluatePasswordStrength('abc').validMinLength).toBe(false);
    expect(evaluatePasswordStrength('Trishul#2026').score).toBe(4);
  });
});

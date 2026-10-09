import { describe, expect, it } from 'vitest';
import {
  exportableStats, passwordStrength, preferencesDirty, toPreferencesDraft, validatePreferences,
  type AppPreferences,
} from '../src/features/settings/settings-model';

const current: AppPreferences = {
  auto_start_simulator: true,
  auto_start_trap_receiver: false,
  session_timeout: 3600,
  mib_auto_fetch: false,
  mib_remote_sources: ['https://example.invalid/@mib@'],
  restart_required: true,
};

describe('settings API adapters and guards', () => {
  it('hydrates from the complete server response and recognizes unchanged values', () => {
    const draft = toPreferencesDraft(current);
    expect(draft.session_timeout).toBe('3600');
    expect(draft.remote_sources).toBe('https://example.invalid/@mib@');
    expect(preferencesDirty(current, draft)).toBe(false);
    expect(validatePreferences(draft)).toEqual({
      valid: true,
      value: {
        auto_start_simulator: true,
        auto_start_trap_receiver: false,
        session_timeout: 3600,
        mib_auto_fetch: false,
        mib_remote_sources: ['https://example.invalid/@mib@'],
      },
    });
  });
  it('normalizes blank lines and whitespace but preserves remote source order', () => {
    const draft = { ...toPreferencesDraft(current),
      remote_sources: ' https://first.invalid/mibs/@mib@ \n\nhttp://second.invalid/@mib@.mib\n',
    };
    const result = validatePreferences(draft);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.mib_remote_sources).toEqual([
      'https://first.invalid/mibs/@mib@',
      'http://second.invalid/@mib@.mib',
    ]);
  });
  it('rejects malformed or fractional session timeouts and identifies remote source line numbers', () => {
    for (const value of ['1', '86401', '3.5', 'not a number', '']) {
      expect(validatePreferences({ ...toPreferencesDraft(current), session_timeout: value }).valid).toBe(false);
    }
    const bad = validatePreferences({
      ...toPreferencesDraft(current),
      remote_sources: 'https://valid.invalid/@mib@\nftp://invalid.invalid/@mib@\nhttps://missing.invalid/IF-MIB',
    });
    expect(bad.valid).toBe(false);
    if (!bad.valid) expect(bad.sourceErrors).toEqual([
      'Line 2: use an http(s) URL.',
      'Line 3: include the @mib@ placeholder.',
    ]);
  });
  it('does not treat a restart badge as a preference change', () => {
    expect(preferencesDirty({ ...current, restart_required: false }, toPreferencesDraft(current))).toBe(false);
    expect(preferencesDirty(current, { ...toPreferencesDraft(current), mib_auto_fetch: true })).toBe(true);
  });
  it('matches the legacy password strength labels', () => {
    expect(passwordStrength('')).toBe('');
    expect(passwordStrength('a')).toBe('Very weak');
    expect(passwordStrength('LongPass123!')).toBe('Strong');
  });
  it('strips runtime details from exported stats without mutating cached data', () => {
    const stats = { runtime: { snmp: 'sensitive' }, walker: { walks_executed: 3 } };
    expect(exportableStats(stats)).toEqual({ walker: { walks_executed: 3 } });
    expect(stats.runtime).toEqual({ snmp: 'sensitive' });
    expect(exportableStats(null)).toEqual({});
  });
});

export interface AppPreferences {
  auto_start_simulator: boolean;
  auto_start_trap_receiver: boolean;
  session_timeout: number;
  mib_auto_fetch: boolean;
  mib_remote_sources: string[];
  restart_required: boolean;
}

export type PreferencesWrite = Omit<AppPreferences, 'restart_required'>;

export interface PreferencesDraft {
  auto_start_simulator: boolean;
  auto_start_trap_receiver: boolean;
  session_timeout: string;
  mib_auto_fetch: boolean;
  remote_sources: string;
}

export interface MibBundleInfo {
  active_bundle_label?: string | null;
  producer_version?: string | null;
  loaded?: number;
  recompile_recommended?: boolean;
}

export interface AuthUpdateResult {
  status?: string;
  message?: string;
  reauth_required?: boolean;
}

export type ValidationResult =
  | { valid: true; value: PreferencesWrite }
  | { valid: false; timeoutError: string | null; sourceErrors: string[] };

export function toPreferencesDraft(settings: AppPreferences): PreferencesDraft {
  return {
    auto_start_simulator: settings.auto_start_simulator,
    auto_start_trap_receiver: settings.auto_start_trap_receiver,
    session_timeout: String(settings.session_timeout),
    mib_auto_fetch: settings.mib_auto_fetch,
    remote_sources: settings.mib_remote_sources.join('\n'),
  };
}

export function validatePreferences(draft: PreferencesDraft): ValidationResult {
  const number = Number(draft.session_timeout);
  const timeoutError = draft.session_timeout.trim() === '' || !Number.isInteger(number) ||
    number < 60 || number > 86_400
    ? 'Enter a whole number between 60 and 86400 seconds.' : null;
  const sources: string[] = [];
  const sourceErrors: string[] = [];
  draft.remote_sources.split(/\r?\n/).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    if (!value.includes('@mib@')) {
      sourceErrors.push('Line ' + (index + 1) + ': include the @mib@ placeholder.');
    } else if (!/^https?:\/\/[^/\s]+/i.test(value)) {
      sourceErrors.push('Line ' + (index + 1) + ': use an http(s) URL.');
    } else {
      sources.push(value);
    }
  });
  if (timeoutError || sourceErrors.length) return { valid: false, timeoutError, sourceErrors };
  return {
    valid: true,
    value: {
      auto_start_simulator: draft.auto_start_simulator,
      auto_start_trap_receiver: draft.auto_start_trap_receiver,
      session_timeout: number,
      mib_auto_fetch: draft.mib_auto_fetch,
      mib_remote_sources: sources,
    },
  };
}

export function preferencesDirty(base: AppPreferences, draft: PreferencesDraft): boolean {
  const validation = validatePreferences(draft);
  if (!validation.valid) return true;
  const original: PreferencesWrite = {
    auto_start_simulator: base.auto_start_simulator,
    auto_start_trap_receiver: base.auto_start_trap_receiver,
    session_timeout: base.session_timeout,
    mib_auto_fetch: base.mib_auto_fetch,
    mib_remote_sources: base.mib_remote_sources,
  };
  return JSON.stringify(original) !== JSON.stringify(validation.value);
}

export function passwordStrength(password: string): string {
  if (!password) return '';
  let score = 0;
  if (password.length >= 8) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  return ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score];
}

/** Match the legacy export contract: never include runtime status details. */
export function exportableStats(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const { runtime: _runtime, ...rest } = raw as Record<string, unknown>;
  void _runtime;
  return rest;
}

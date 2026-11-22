import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';
import { api } from '../lib/api';
import {
  downloadTextFile,
  evaluatePasswordStrength,
  validateRemoteSourceUrl,
} from '../lib/workbench';
import { SecretInput, StatusLabel } from '../components/UiPrimitives';

export const SettingsWorkspace: React.FC = () => {
  const { meta, username, notify, confirm, refreshLiveState, invalidateLocalSession, stats } =
    useWorkbench();

  // Credentials form
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingAuth, setSavingAuth] = useState(false);

  // App settings form
  const [loadingApp, setLoadingApp] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingApp, setSavingApp] = useState(false);
  const [autoStartSimulator, setAutoStartSimulator] = useState(false);
  const [autoStartTrapReceiver, setAutoStartTrapReceiver] = useState(false);
  const [sessionTimeoutSec, setSessionTimeoutSec] = useState(86400);
  const [mibAutoFetch, setMibAutoFetch] = useState(false);
  const [remoteSourcesText, setRemoteSourcesText] = useState('');
  const [restartRequired, setRestartRequired] = useState(false);
  const [resettingStats, setResettingStats] = useState(false);
  const [exportingStats, setExportingStats] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoadingApp(true);
    setLoadError(null);
    try {
      const cfg = await api.getAppSettings();
      setAutoStartSimulator(Boolean(cfg.auto_start_simulator));
      setAutoStartTrapReceiver(Boolean(cfg.auto_start_trap_receiver));
      setSessionTimeoutSec(Number(cfg.session_timeout || 86400));
      setMibAutoFetch(Boolean(cfg.mib_auto_fetch));
      setRemoteSourcesText((cfg.mib_remote_sources || []).join('\n'));
      setRestartRequired(Boolean(cfg.restart_required));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load application settings';
      setLoadError(msg);
      notify(msg, 'error');
    } finally {
      setLoadingApp(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const remoteSourceErrors = useMemo(() => {
    const lines = remoteSourcesText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.map((line) => validateRemoteSourceUrl(line)).filter((e): e is string => Boolean(e));
  }, [remoteSourcesText]);

  const passwordStrength = useMemo(
    () => evaluatePasswordStrength(nextPassword),
    [nextPassword]
  );

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword) {
      notify('Enter your current password to confirm credential changes', 'warning');
      return;
    }
    if (!nextPassword || nextPassword.length < 6) {
      notify('New password must be at least 6 characters long', 'warning');
      return;
    }
    if (nextPassword !== confirmPassword) {
      notify('New password and confirmation do not match', 'error');
      return;
    }

    setSavingAuth(true);
    try {
      const res = await api.updateCredentials({
        current_password: currentPassword,
        username,
        password: nextPassword,
      });
      notify(res.message || 'Credentials updated. Please sign in again.', 'success');
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      // Backend already invalidates all tokens and emits WS reauth_required; clear local session without redundant /logout
      invalidateLocalSession();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update credentials', 'error');
    } finally {
      setSavingAuth(false);
    }
  };

  const handleSaveAppSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loadError) return;
    if (sessionTimeoutSec < 60 || sessionTimeoutSec > 86400 || !Number.isFinite(sessionTimeoutSec)) {
      notify('Session timeout must be between 60 and 86400 seconds', 'warning');
      return;
    }
    if (remoteSourceErrors.length > 0) {
      notify(remoteSourceErrors[0], 'error');
      return;
    }

    setSavingApp(true);
    try {
      const sources = remoteSourcesText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await api.updateAppSettings({
        auto_start_simulator: autoStartSimulator,
        auto_start_trap_receiver: autoStartTrapReceiver,
        session_timeout: Math.round(sessionTimeoutSec),
        mib_auto_fetch: mibAutoFetch,
        mib_remote_sources: sources,
      });
      setAutoStartSimulator(Boolean(updated.auto_start_simulator));
      setAutoStartTrapReceiver(Boolean(updated.auto_start_trap_receiver));
      setSessionTimeoutSec(Number(updated.session_timeout || 86400));
      setMibAutoFetch(Boolean(updated.mib_auto_fetch));
      setRemoteSourcesText((updated.mib_remote_sources || []).join('\n'));
      setRestartRequired(Boolean(updated.restart_required));
      notify(
        updated.restart_required
          ? 'Settings saved — server restart required for session/autostart changes to apply cleanly'
          : 'Application settings saved',
        updated.restart_required ? 'warning' : 'success'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save application settings', 'error');
    } finally {
      setSavingApp(false);
    }
  };

  const handleExportStats = async () => {
    setExportingStats(true);
    try {
      const latest = stats || (await api.getStats());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadTextFile(
        `trishul-stats-${stamp}.json`,
        JSON.stringify({ exported_at: new Date().toISOString(), stats: latest }, null, 2),
        'application/json'
      );
      notify('Telemetry statistics exported to JSON', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to export statistics', 'error');
    } finally {
      setExportingStats(false);
    }
  };

  const handleResetStats = async () => {
    const ok = await confirm({
      title: 'Reset all runtime telemetry counters?',
      message:
        'This zeroes SNMP requests served, walks executed, traps sent/received totals, and MIB reload counters across the suite.',
      confirmLabel: 'Reset Counters',
      variant: 'danger',
    });
    if (!ok) return;
    setResettingStats(true);
    try {
      await api.resetStats();
      await refreshLiveState();
      notify('All activity counters reset to zero', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to reset counters', 'error');
    } finally {
      setResettingStats(false);
    }
  };

  const strengthColors: Record<number, string> = {
    0: 'bg-[var(--tui-border-default)]',
    1: 'bg-[var(--tui-danger)]',
    2: 'bg-[var(--tui-warning)]',
    3: 'bg-[var(--tui-info)]',
    4: 'bg-[var(--tui-success)]',
  };

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-6 py-6 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Runtime & MIB Preferences */}
        <section className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <SlidersHorizontal className="w-4 h-4 text-[var(--tui-brand)] shrink-0" />
              <div className="min-w-0">
                <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                  Runtime &amp; MIB Preferences
                </h2>
                <p className="text-[11px] text-[var(--tui-ink-muted)] truncate">
                  Autostart behavior, session expiration, and dependency sources
                </p>
              </div>
            </div>
            {restartRequired && <StatusLabel tone="warning" label="Restart required" />}
          </div>

          {loadingApp ? (
            <div className="py-12 flex items-center justify-center gap-2 text-xs text-[var(--tui-ink-muted)]">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
              Loading preferences...
            </div>
          ) : loadError ? (
            <div className="p-4 space-y-3">
              <div
                role="alert"
                className="p-3 rounded-lg bg-[var(--tui-danger-soft)] border border-[var(--tui-danger-border)] text-xs text-[var(--tui-danger-ink)] flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Unable to load application settings</div>
                  <div className="mt-0.5">{loadError}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadSettings()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry Loading Settings
              </button>
            </div>
          ) : (
            <form onSubmit={handleSaveAppSettings} className="p-4 space-y-4">
              <label className="flex items-start justify-between gap-4 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-[var(--tui-ink-primary)]">
                    Autostart SNMP Simulator
                  </div>
                  <div className="text-[11px] text-[var(--tui-ink-muted)]">
                    Start the UDP responder automatically when the server boots.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoStartSimulator}
                  onChange={(e) => setAutoStartSimulator(e.target.checked)}
                  className="mt-0.5 accent-[var(--tui-brand)]"
                />
              </label>

              <label className="flex items-start justify-between gap-4 cursor-pointer pt-3 border-t border-[var(--tui-border-subtle)]">
                <div>
                  <div className="text-xs font-medium text-[var(--tui-ink-primary)]">
                    Autostart Trap Receiver
                  </div>
                  <div className="text-[11px] text-[var(--tui-ink-muted)]">
                    Begin listening for incoming SNMPv2c Trap/Inform PDUs on boot.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoStartTrapReceiver}
                  onChange={(e) => setAutoStartTrapReceiver(e.target.checked)}
                  className="mt-0.5 accent-[var(--tui-brand)]"
                />
              </label>

              <div className="pt-3 border-t border-[var(--tui-border-subtle)]">
                <label
                  htmlFor="tui-session-timeout"
                  className="block text-xs font-medium text-[var(--tui-ink-primary)] mb-1"
                >
                  Session Timeout (seconds)
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    id="tui-session-timeout"
                    type="number"
                    min={60}
                    max={86400}
                    value={sessionTimeoutSec}
                    onChange={(e) => setSessionTimeoutSec(Number(e.target.value))}
                    className="w-40 px-3 py-1.5 text-xs font-mono rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] tabular-nums"
                  />
                  <span className="text-[11px] font-mono text-[var(--tui-ink-muted)]">
                    [60..86400s · ~{Math.max(1, Math.round((sessionTimeoutSec || 0) / 60))} min]
                  </span>
                </div>
              </div>

              <label className="flex items-start justify-between gap-4 cursor-pointer pt-3 border-t border-[var(--tui-border-subtle)]">
                <div>
                  <div className="text-xs font-medium text-[var(--tui-ink-primary)]">
                    Enable MIB Dependency Auto-Fetch
                  </div>
                  <div className="text-[11px] text-[var(--tui-ink-muted)]">
                    Allow pre-flight validation to reference configured remote MIB repositories.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={mibAutoFetch}
                  onChange={(e) => setMibAutoFetch(e.target.checked)}
                  className="mt-0.5 accent-[var(--tui-brand)]"
                />
              </label>

              <div>
                <label
                  htmlFor="tui-remote-sources"
                  className="block text-xs font-medium text-[var(--tui-ink-primary)] mb-1"
                >
                  Remote MIB Source URLs (one per line, include <code className="font-mono">@mib@</code>)
                </label>
                <textarea
                  id="tui-remote-sources"
                  rows={3}
                  value={remoteSourcesText}
                  onChange={(e) => setRemoteSourcesText(e.target.value)}
                  placeholder="https://mibs.pysnmp.com/asn1/@mib@"
                  className="w-full px-3 py-2 text-xs font-mono rounded-md bg-[var(--tui-bg-surface)] border border-[var(--tui-border-control)] text-[var(--tui-ink-primary)] focus-visible:border-[var(--tui-brand)]"
                />
                {remoteSourceErrors.length > 0 && (
                  <p role="alert" className="mt-1 text-[11px] text-[var(--tui-danger-ink)]">
                    {remoteSourceErrors[0]}
                  </p>
                )}
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={savingApp || Boolean(loadError) || remoteSourceErrors.length > 0}
                  className="tui-btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingApp ? 'Saving...' : 'Save Preferences'}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Access Credentials */}
        <section className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[var(--tui-brand)]" />
            <div>
              <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Access Credentials
              </h2>
              <p className="text-[11px] text-[var(--tui-ink-muted)]">
                Rotating passwords invalidates all active tokens and requires sign-in
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveCredentials} className="p-4 space-y-3.5">
            <div>
              <label
                htmlFor="tui-auth-current"
                className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
              >
                Current Password
              </label>
              <SecretInput
                id="tui-auth-current"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
                toggleLabel="current password"
                className="!font-sans"
              />
            </div>

            <div>
              <label
                htmlFor="tui-auth-user"
                className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
              >
                Operator Username (Read-only)
              </label>
              <input
                id="tui-auth-user"
                type="text"
                readOnly
                aria-readonly="true"
                autoComplete="username"
                value={username}
                className="w-full px-3 py-1.5 text-xs font-mono rounded-md bg-[var(--tui-bg-muted)] border border-[var(--tui-border-control)] text-[var(--tui-ink-muted)] cursor-not-allowed"
              />
              <p className="mt-1 text-[11px] text-[var(--tui-ink-muted)]">
                Username changes are disabled by server policy.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="tui-auth-new"
                  className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
                >
                  New Password
                </label>
                <SecretInput
                  id="tui-auth-new"
                  value={nextPassword}
                  onChange={setNextPassword}
                  autoComplete="new-password"
                  minLength={6}
                  toggleLabel="new password"
                  className="!font-sans"
                />
                {nextPassword && (
                  <div className="mt-1.5 space-y-1">
                    <div className="grid grid-cols-4 gap-1 h-1" aria-hidden="true">
                      {[1, 2, 3, 4].map((step) => (
                        <span
                          key={step}
                          className={`rounded-full ${
                            passwordStrength.score >= step
                              ? strengthColors[passwordStrength.score]
                              : 'bg-[var(--tui-border-default)]'
                          }`}
                        />
                      ))}
                    </div>
                    <div className="text-[11px] font-mono text-[var(--tui-ink-muted)]">
                      Strength: {passwordStrength.label}
                      {!passwordStrength.validMinLength && ' · Minimum 6 characters required'}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label
                  htmlFor="tui-auth-confirm"
                  className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
                >
                  Confirm Password
                </label>
                <SecretInput
                  id="tui-auth-confirm"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  autoComplete="new-password"
                  toggleLabel="confirm password"
                  className="!font-sans"
                />
                {confirmPassword && confirmPassword !== nextPassword && (
                  <p role="alert" className="mt-1 text-[11px] text-[var(--tui-danger-ink)]">
                    Passwords do not match.
                  </p>
                )}
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                disabled={savingAuth}
                className="tui-btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold disabled:opacity-50 cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                {savingAuth ? 'Updating...' : 'Update Credentials'}
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* Maintenance & Metadata */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
              Telemetry Statistics
            </h3>
            <p className="text-[11px] text-[var(--tui-ink-muted)] mt-0.5">
              Export current counters as JSON or reset all suite totals to zero.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              disabled={exportingStats}
              onClick={() => void handleExportStats()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] text-[var(--tui-ink-primary)] disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export Stats
            </button>
            <button
              type="button"
              disabled={resettingStats}
              onClick={() => void handleResetStats()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] hover:brightness-95 dark:hover:brightness-110 disabled:opacity-50 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Counters
            </button>
          </div>
        </section>

        <section className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl p-4 flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)] flex items-center justify-center text-[var(--tui-brand)] shrink-0">
            <Info className="w-4 h-4" />
          </div>
          <div className="min-w-0 text-xs space-y-1">
            <div className="font-semibold text-[var(--tui-ink-primary)]">
              {meta?.name || 'Trishul SNMP Suite'}{' '}
              <span className="font-mono text-[11px] text-[var(--tui-ink-muted)]">
                v{meta?.version || '2.0'}
              </span>
            </div>
            <p className="text-[11px] text-[var(--tui-ink-muted)] leading-relaxed">
              {meta?.description ||
                'Precision SNMP simulator, MIB compiler, OID walker, and trap operations workbench.'}
            </p>
            <div className="text-[11px] font-mono text-[var(--tui-ink-muted)] pt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              {meta?.author && <span>Author: {meta.author} ·</span>}
              <span>Shared Session &amp; Backend Contract ·</span>
              <a href="/" className="text-[var(--tui-brand-ink)] hover:underline">
                Switch to Classic UI
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

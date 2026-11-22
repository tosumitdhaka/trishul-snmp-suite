import React, { useCallback, useEffect, useState } from 'react';
import {
  Info,
  KeyRound,
  Loader2,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';
import { api } from '../lib/api';

export const SettingsWorkspace: React.FC = () => {
  const { meta, username, notify, confirm, refreshLiveState, logout } = useWorkbench();

  // Credentials form
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextUsername, setNextUsername] = useState(username);
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingAuth, setSavingAuth] = useState(false);

  // App settings form
  const [loadingApp, setLoadingApp] = useState(true);
  const [savingApp, setSavingApp] = useState(false);
  const [autostartSimulator, setAutostartSimulator] = useState(false);
  const [autostartTrapReceiver, setAutostartTrapReceiver] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState(1440);
  const [mibAutoFetch, setMibAutoFetch] = useState(false);
  const [remoteSourcesText, setRemoteSourcesText] = useState('');
  const [resettingStats, setResettingStats] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoadingApp(true);
    try {
      const cfg = await api.getAppSettings();
      setAutostartSimulator(Boolean(cfg.autostart_simulator));
      setAutostartTrapReceiver(Boolean(cfg.autostart_trap_receiver));
      setSessionTimeout(Number(cfg.session_timeout || 1440));
      setMibAutoFetch(Boolean(cfg.mib_auto_fetch));
      setRemoteSourcesText((cfg.mib_remote_sources || []).join('\n'));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to load application settings', 'error');
    } finally {
      setLoadingApp(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setNextUsername(username);
  }, [username]);

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword) {
      notify('Enter your current password to confirm credential changes', 'warning');
      return;
    }
    if (nextPassword && nextPassword !== confirmPassword) {
      notify('New password and confirmation do not match', 'error');
      return;
    }
    if (!nextPassword) {
      notify('Enter a new password (min 6 characters)', 'warning');
      return;
    }

    setSavingAuth(true);
    try {
      await api.updateCredentials({
        current_password: currentPassword,
        username: nextUsername.trim() || username,
        password: nextPassword,
      });
      notify('Credentials updated. Please sign in again.', 'success');
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      await logout();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update credentials', 'error');
    } finally {
      setSavingAuth(false);
    }
  };

  const handleSaveAppSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingApp(true);
    try {
      const sources = remoteSourcesText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await api.updateAppSettings({
        autostart_simulator: autostartSimulator,
        autostart_trap_receiver: autostartTrapReceiver,
        session_timeout: Math.max(5, Number(sessionTimeout) || 1440),
        mib_auto_fetch: mibAutoFetch,
        mib_remote_sources: sources,
      });
      setAutostartSimulator(Boolean(updated.autostart_simulator));
      setAutostartTrapReceiver(Boolean(updated.autostart_trap_receiver));
      setSessionTimeout(Number(updated.session_timeout || 1440));
      setMibAutoFetch(Boolean(updated.mib_auto_fetch));
      setRemoteSourcesText((updated.mib_remote_sources || []).join('\n'));
      notify('Application settings saved', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save application settings', 'error');
    } finally {
      setSavingApp(false);
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

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-6 py-6 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Runtime & MIB Preferences */}
        <section className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[var(--tui-brand)]" />
            <div>
              <h2 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
                Runtime & MIB Preferences
              </h2>
              <p className="text-[11px] text-[var(--tui-ink-muted)]">
                Autostart behavior, session expiration, and dependency sources
              </p>
            </div>
          </div>

          {loadingApp ? (
            <div className="py-12 flex items-center justify-center gap-2 text-xs text-[var(--tui-ink-muted)]">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
              Loading preferences...
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
                  checked={autostartSimulator}
                  onChange={(e) => setAutostartSimulator(e.target.checked)}
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
                  checked={autostartTrapReceiver}
                  onChange={(e) => setAutostartTrapReceiver(e.target.checked)}
                  className="mt-0.5 accent-[var(--tui-brand)]"
                />
              </label>

              <div className="pt-3 border-t border-[var(--tui-border-subtle)]">
                <label
                  htmlFor="tui-session-timeout"
                  className="block text-xs font-medium text-[var(--tui-ink-primary)] mb-1"
                >
                  Session Timeout (minutes)
                </label>
                <input
                  id="tui-session-timeout"
                  type="number"
                  min={5}
                  max={43200}
                  value={sessionTimeout}
                  onChange={(e) => setSessionTimeout(Number(e.target.value))}
                  className="w-40 px-3 py-1.5 text-xs font-mono rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] tabular-nums"
                />
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
                  Remote MIB Source URLs (one per line)
                </label>
                <textarea
                  id="tui-remote-sources"
                  rows={3}
                  value={remoteSourcesText}
                  onChange={(e) => setRemoteSourcesText(e.target.value)}
                  placeholder="https://mibs.pysnmp.com/asn1/@mib@"
                  className="w-full px-3 py-2 text-xs font-mono rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={savingApp}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-50"
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
                Rotating credentials invalidates all active tokens and requires sign-in
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
              <input
                id="tui-auth-current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-3 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>

            <div>
              <label
                htmlFor="tui-auth-user"
                className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
              >
                Operator Username
              </label>
              <input
                id="tui-auth-user"
                type="text"
                autoComplete="username"
                value={nextUsername}
                onChange={(e) => setNextUsername(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="tui-auth-new"
                  className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
                >
                  New Password
                </label>
                <input
                  id="tui-auth-new"
                  type="password"
                  autoComplete="new-password"
                  value={nextPassword}
                  onChange={(e) => setNextPassword(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>
              <div>
                <label
                  htmlFor="tui-auth-confirm"
                  className="block text-[11px] font-mono uppercase text-[var(--tui-ink-muted)] mb-1"
                >
                  Confirm Password
                </label>
                <input
                  id="tui-auth-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-md bg-[var(--tui-bg-subtle)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
                />
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                disabled={savingAuth}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] disabled:opacity-50"
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
        <section className="bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] rounded-xl p-4 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-xs font-semibold text-[var(--tui-ink-primary)]">
              Reset Telemetry Counters
            </h3>
            <p className="text-[11px] text-[var(--tui-ink-muted)] mt-0.5">
              Zero out simulator requests, walk counts, and trap sent/received counters.
            </p>
          </div>
          <button
            type="button"
            disabled={resettingStats}
            onClick={handleResetStats}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--tui-danger-border)] bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] hover:brightness-95 dark:hover:brightness-110 shrink-0 disabled:opacity-50 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Counters
          </button>
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
            <div className="text-[10px] font-mono text-[var(--tui-ink-soft)] pt-0.5">
              Workbench Next · Shared Session & Backend Contract ·{' '}
              <a href="/" className="text-[var(--tui-brand)] hover:underline">
                Switch to Classic UI
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, ArrowUpRight, Download, Info, KeyRound, RefreshCw, RotateCcw, Save, Settings2, Trash2, X } from 'lucide-react';
import { Link } from 'react-router';
import { apiRequest } from '../../lib/api/client';
import type { AppMeta } from '../../lib/api/types';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useNotifications } from '../../lib/notifications/NotificationProvider';
import {
  exportableStats, passwordStrength, preferencesDirty, toPreferencesDraft, validatePreferences,
  type AppPreferences, type AuthUpdateResult, type MibBundleInfo, type PreferencesDraft,
} from './settings-model';

type Confirmation = 'credentials' | 'reset' | null;
function Section({ id, title, description, icon, action, children }: {
  id: string; title: string; description: string; icon: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="panel flex h-full min-w-0 flex-col overflow-hidden">
      <div className="panel-heading">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 rounded-lg bg-[var(--accent-soft)] p-2 text-[var(--accent)]">{icon}</span>
          <div>
            <h2 id={id} className="text-base font-semibold sm:text-lg">{title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{description}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="panel-body space-y-5">{children}</div>
    </section>
  );
}

function ConfirmAction({ kind, pending, onCancel, onConfirm }: {
  kind: Confirmation; pending: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const credential = kind === 'credentials';
  const title = credential ? 'Update credentials and sign out?' : 'Reset every activity counter?';
  const message = credential
    ? 'Your new password will replace the current one. All existing sessions will be invalidated, including other open tabs. Sign in again with the new password.'
    : 'All activity counters will be reset to zero. This cannot be undone. It does not delete MIB files or stop the running services.';
  return <Dialog.Root open={kind !== null} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/60" />
      <Dialog.Content aria-describedby="settings-confirm-description" className="fixed left-1/2 top-1/2 z-70 w-[min(29rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-[var(--text)] shadow-2xl focus:outline-none">
        <div className="flex items-start justify-between gap-3">
          <span className="inline-flex rounded-xl bg-[var(--danger-soft)] p-2.5 text-[var(--danger)]"><AlertTriangle size={22} aria-hidden="true" /></span>
          <Dialog.Close disabled={pending} aria-label="Close confirmation" className="btn-secondary p-2"><X size={17} aria-hidden="true" /></Dialog.Close>
        </div>
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description id="settings-confirm-description" className="text-sm leading-relaxed text-[var(--muted)]">{message}</Dialog.Description>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="button" className={credential ? 'btn-primary' : 'btn-secondary border-[var(--danger)] text-[var(--danger)]'} disabled={pending} onClick={onConfirm}>
            {pending ? 'Applying…' : credential ? 'Update and sign out' : 'Reset counters'}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function PreferenceToggle({ id, label, checked, onChange, hint }: {
  id: string; label: string; checked: boolean; onChange: (value: boolean) => void; hint?: string;
}) {
  return <div className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
    <input type="checkbox" role="switch" id={id} checked={checked} onChange={(event) => onChange(event.target.checked)}
      className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]" />
    <div className="min-w-0">
      <label htmlFor={id} className="block cursor-pointer text-sm font-semibold">{label}</label>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  </div>;
}

export function SettingsPage() {
  const { auth, expire } = useAuth();
  const token = auth.state === 'authenticated' ? auth.token : null;
  const username = auth.state === 'authenticated' ? auth.username : '';
  const cache = useQueryClient();
  const { notify } = useNotifications();

  const [base, setBase] = useState<AppPreferences | null>(null);
  const [draft, setDraft] = useState<PreferencesDraft | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const settings = useQuery({
    queryKey: ['settings', 'app'],
    queryFn: ({ signal }) => apiRequest<AppPreferences>('/api/settings/app', token, { signal }),
    enabled: !!token,
  });
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => apiRequest<AppMeta>('/api/meta', null, { signal }),
    staleTime: 60_000,
  });
  const bundle = useQuery({
    queryKey: ['mibs', 'settings-about'],
    queryFn: ({ signal }) => apiRequest<MibBundleInfo>('/api/mibs/status', token, { signal }),
    enabled: !!token,
    staleTime: 60_000,
  });

  // Hydrate only after successful loading, never from default values.
  // Background refetch must not erase unsaved edits.
  useEffect(() => {
    if (settings.data && base === null) {
      setBase(settings.data);
      setDraft(toPreferencesDraft(settings.data));
    }
  }, [settings.data, base]);

  const saveSettings = useMutation({
    mutationFn: (value: ReturnType<typeof validatePreferences> & { valid: true }) =>
      apiRequest<AppPreferences>('/api/settings/app', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value.value),
      }),
    onSuccess: (saved) => {
      setBase(saved);
      setDraft(toPreferencesDraft(saved));
      cache.setQueryData(['settings', 'app'], saved);
      notify({ tone: 'success', title: 'Preferences saved', message: 'Application settings saved.' });
    },
    onError: (error: Error) => notify({ tone: 'error', title: 'Could not save preferences', message: error.message }),
  });
  const updateCredentials = useMutation({
    mutationFn: () => apiRequest<AuthUpdateResult>('/api/settings/auth', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, username, password: newPassword }),
    }),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setConfirmation(null);
      if (token) expire(token);
    },
    onError: (error: Error) => {
      setConfirmation(null);
      notify({ tone: 'error', title: 'Password change failed', message: error.message });
    },
  });
  const resetStats = useMutation({
    mutationFn: () => apiRequest<{ status: string }>('/api/stats/', token, { method: 'DELETE' }),
    onSuccess: () => {
      notify({ tone: 'success', title: 'Statistics reset', message: 'Activity counters reset.' });
      setConfirmation(null);
      void cache.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (error: Error) => {
      setConfirmation(null);
      notify({ tone: 'error', title: 'Could not reset statistics', message: error.message });
    },
  });

  const validation = draft ? validatePreferences(draft) : null;
  const dirty = !!base && !!draft && preferencesDirty(base, draft);
  const saveReady = base !== null && draft !== null && validation?.valid === true &&
    dirty && !settings.isError && !saveSettings.isPending;
  const credentialsError = !currentPassword ? 'Enter your current password.' :
    newPassword.length < 6 ? 'New password must be at least 6 characters.' :
    newPassword !== confirmPassword ? 'New passwords do not match.' : null;

  function changeDraft(patch: Partial<PreferencesDraft>) {
    setDraft((old) => old ? { ...old, ...patch } : null);

  }
  function submitPreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!base || !draft || settings.isError || !validation || !validation.valid || !dirty) return;
    saveSettings.mutate(validation);
  }
  function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (credentialsError || updateCredentials.isPending) {
      notify({ tone: 'error', title: 'Check password fields', message: credentialsError || 'Update already in progress.' });
      return;
    }
    setConfirmation('credentials');
  }
  async function exportStats() {
    if (!token || exporting) return;
    setExporting(true);

    try {
      // Fetch a fresh snapshot rather than exporting potentially stale query-cache data.
      const current = await apiRequest<Record<string, unknown>>('/api/stats/', token);
      const blob = new Blob([JSON.stringify(exportableStats(current), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = 'trishul-stats-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
      } finally {
        URL.revokeObjectURL(url);
      }
      notify({ tone: 'success', title: 'Statistics exported', message: 'Activity statistics exported.' });
    } catch (reason) {
      notify({ tone: 'error', title: 'Statistics export failed', message: reason instanceof Error ? reason.message : 'Export failed.' });
    } finally {
      setExporting(false);
    }
  }

  return <div className="workspace-page">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="eyebrow">Account and system configuration</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Manage credentials, startup preferences and operational diagnostics.</p>
      </div>
      <a className="btn-secondary" href="/#settings">Legacy Settings <ArrowUpRight size={16} aria-hidden="true" /></a>
    </div>

    <div className="workspace-grid workspace-grid--two">
      <Section id="settings-preferences" icon={<Settings2 size={20} aria-hidden="true" />} title="Application settings"
        description="Startup changes apply after a backend restart. Other options apply on save."
        action={base?.restart_required ? <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--warning)]">Restart required</span> : null}>
        {settings.isPending && !base && <p role="status" className="text-sm text-[var(--muted)]">Loading saved preferences…</p>}
        {settings.isError && <p role="alert" className="text-sm text-[var(--danger)]">Unable to load or refresh current settings. Saving is disabled to prevent overwriting real values.</p>}
        {settings.isError && <button type="button" className="btn-secondary" onClick={() => { void settings.refetch(); }}>
          <RefreshCw size={16} aria-hidden="true" /> Retry loading
        </button>}
        {draft && <form className="space-y-5" onSubmit={submitPreferences} noValidate>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">Auto-start on boot</legend>
            <PreferenceToggle id="settings-autostart-sim" label="Simulator" checked={draft.auto_start_simulator}
              onChange={(value) => changeDraft({ auto_start_simulator: value })} hint="Start the SNMP responder after a backend restart." />
            <PreferenceToggle id="settings-autostart-traps" label="Trap receiver" checked={draft.auto_start_trap_receiver}
              onChange={(value) => changeDraft({ auto_start_trap_receiver: value })} hint="Start the notification listener after a backend restart." />
          </fieldset>
          <div>
            <label htmlFor="settings-timeout" className="field-label">Session timeout (seconds)</label>
            <input id="settings-timeout" type="number" inputMode="numeric" step="1" min="60" max="86400"
              className="field-input" value={draft.session_timeout}
              onChange={(e) => changeDraft({ session_timeout: e.target.value })}
              aria-invalid={validation && !validation.valid && !!validation.timeoutError || undefined}
              aria-describedby="settings-timeout-hint settings-timeout-error" />
            <p id="settings-timeout-hint" className="mt-1 text-xs text-[var(--muted)]">60–86400 seconds; default 3600 seconds (one hour).</p>
            {validation && !validation.valid && validation.timeoutError &&
              <p id="settings-timeout-error" role="alert" className="mt-1 text-xs text-[var(--danger)]">{validation.timeoutError}</p>}
          </div>
          <div className="space-y-3">
            <PreferenceToggle id="settings-fetch" label="Auto-fetch missing MIB dependencies" checked={draft.mib_auto_fetch}
              onChange={(value) => changeDraft({ mib_auto_fetch: value })} hint="Applies to MIB upload/reload, not validation." />
            <div>
              <label htmlFor="settings-sources" className="field-label">Approved remote MIB sources</label>
              <textarea id="settings-sources" rows={4} spellCheck={false}
                placeholder="https://example.invalid/mibs/@mib@"
                className="field-input h-auto min-h-28 font-mono text-xs"
                value={draft.remote_sources} onChange={(e) => changeDraft({ remote_sources: e.target.value })}
                aria-invalid={validation && !validation.valid && validation.sourceErrors.length > 0 || undefined}
                aria-describedby="settings-sources-hint settings-sources-errors" />
              <p id="settings-sources-hint" className="mt-1 text-xs text-[var(--muted)]">
                Optional; one HTTP(S) URL per line containing <code>@mib@</code>. Order matters. Blank uses default sources.
              </p>
              {validation && !validation.valid && validation.sourceErrors.length > 0 &&
                <ul id="settings-sources-errors" role="alert" className="mt-2 space-y-1 text-xs text-[var(--danger)]">
                  {validation.sourceErrors.map((error) => <li key={error}>{error}</li>)}
                </ul>}
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary" type="submit" disabled={!saveReady}>
              <Save size={16} aria-hidden="true" /> {saveSettings.isPending ? 'Saving…' : 'Save settings'}
            </button>
            <button className="btn-secondary" type="button" disabled={!dirty || saveSettings.isPending}
              onClick={() => { if (base) { setDraft(toPreferencesDraft(base)); } }}>Discard edits</button>
            {dirty && <span className="text-xs text-[var(--muted)]">Unsaved changes</span>}
          </div>
        </form>}
      </Section>

      <Section id="settings-credentials" icon={<KeyRound size={20} aria-hidden="true" />} title="Authentication"
        description="Change the password for your existing account. Your username is fixed.">
        <form className="space-y-4" onSubmit={submitCredentials} noValidate>
          <div>
            <label htmlFor="settings-username" className="field-label">Username</label>
            <input id="settings-username" className="field-input bg-[var(--surface-muted)]" value={username} readOnly autoComplete="username" />
            <p className="mt-1 text-xs text-[var(--muted)]">The backend does not allow username changes.</p>
          </div>
          <div>
            <label htmlFor="settings-current-password" className="field-label">Current password</label>
            <input id="settings-current-password" className="field-input" type="password" autoComplete="current-password"
              required value={currentPassword} onChange={(e) => { setCurrentPassword(e.target.value); }} />
          </div>
          <div>
            <label htmlFor="settings-new-password" className="field-label">New password</label>
            <input id="settings-new-password" className="field-input" type="password" autoComplete="new-password"
              required minLength={6} value={newPassword} onChange={(e) => { setNewPassword(e.target.value); }}
              aria-describedby="settings-password-hint" />
            <p id="settings-password-hint" className="mt-1 text-xs text-[var(--muted)]">
              At least six characters. Mix uppercase, lowercase, numbers and symbols.
              {newPassword && <span className="ml-2 font-semibold text-[var(--text)]">Strength: {passwordStrength(newPassword)}</span>}
            </p>
          </div>
          <div>
            <label htmlFor="settings-confirm-password" className="field-label">Confirm new password</label>
            <input id="settings-confirm-password" className="field-input" type="password" autoComplete="new-password"
              required value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); }}
              aria-invalid={!!confirmPassword && confirmPassword !== newPassword || undefined}
              aria-describedby="settings-confirm-password-error" />
            {confirmPassword && confirmPassword !== newPassword &&
              <p id="settings-confirm-password-error" role="alert" className="mt-1 text-xs text-[var(--danger)]">Passwords do not match.</p>}
          </div>
          
          <p className="rounded-lg bg-[var(--surface-muted)] p-3 text-xs leading-relaxed text-[var(--muted)]">
            Updating credentials immediately invalidates all signed-in sessions, including this one.
          </p>
          <button type="submit" className="btn-primary" disabled={updateCredentials.isPending}>
            <KeyRound size={16} aria-hidden="true" /> Update credentials
          </button>
        </form>
      </Section>

      <Section id="settings-statistics" icon={<RotateCcw size={20} aria-hidden="true" />} title="Statistics"
        description="Export a fresh snapshot or reset activity counters across the application.">
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-secondary" onClick={() => void exportStats()} disabled={exporting || resetStats.isPending}>
            <Download size={16} aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export stats'}
          </button>
          <button type="button" className="btn-secondary border-[var(--danger)] text-[var(--danger)]"
            onClick={() => { setConfirmation('reset'); }} disabled={exporting || resetStats.isPending}>
            <Trash2 size={16} aria-hidden="true" /> Reset stats
          </button>
        </div>
        
      </Section>

      <Section id="settings-about" icon={<Info size={20} aria-hidden="true" />} title="About"
        description="Running backend and compiled MIB bundle information.">
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
          {([
            ['Application', meta.isError ? 'Unavailable' : meta.data?.name],
            ['Version', meta.isError ? 'Unavailable' : meta.data?.version],
            ['Author', meta.isError ? 'Unavailable' : meta.data?.author],
            ['Description', meta.isError ? 'Unavailable' : meta.data?.description],
            ['MIB bundle', bundle.isError ? 'Unavailable' : bundle.data?.active_bundle_label],
            ['Bundle producer', bundle.isError ? 'Unavailable' : bundle.data?.producer_version],
            ['Active modules', bundle.isError ? 'Unavailable' : typeof bundle.data?.loaded === 'number' ? String(bundle.data.loaded) : undefined],
          ] as [string, string | null | undefined][]).map(([label, value]) =>
            <div key={label} className="col-span-2 grid min-w-0 grid-cols-subgrid border-b border-[var(--border)] pb-2 last:border-b-0">
              <dt className="text-[var(--muted)]">{label}</dt>
              <dd className="min-w-0 break-words font-medium">{value || '—'}</dd>
            </div>)}
        </dl>
        {bundle.data?.recompile_recommended && <p className="rounded-lg bg-[var(--surface-muted)] p-3 text-xs text-[var(--warning)]">
          This bundle was compiled by an older compiler. <Link to="/mibs" className="link">Open MIB Manager</Link> to review it.
        </p>}
      </Section>
    </div>

    <ConfirmAction kind={confirmation} pending={updateCredentials.isPending || resetStats.isPending}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        if (confirmation === 'credentials') updateCredentials.mutate();
        if (confirmation === 'reset') resetStats.mutate();
      }} />
  </div>;
}

window.SettingsModule = {
    init: function() {
        // Password strength indicator
        const passInput = document.getElementById("set-auth-pass");
        if (passInput) {
            passInput.addEventListener('input', (e) => this.checkPasswordStrength(e.target.value));
        }
        // Prefill username from session
        const usernameEl = document.getElementById('set-auth-user');
        if (usernameEl) {
            const stored = sessionStorage.getItem('snmp_username');
            if (stored) usernameEl.value = stored;
        }
        // Phase 2A — load persisted settings + about info
        this.loadAppSettings();
        this.loadAbout();
    },

    // ------------------------------------------------------------------ //
    // Auth                                                                //
    // ------------------------------------------------------------------ //

    checkPasswordStrength: function(password) {
        const strengthEl = document.getElementById('password-strength');
        if (!strengthEl) return;

        let strength = 0;
        if (password.length >= 8) strength++;
        if (password.match(/[a-z]/) && password.match(/[A-Z]/)) strength++;
        if (password.match(/[0-9]/)) strength++;
        if (password.match(/[^a-zA-Z0-9]/)) strength++;

        const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
        const tones = ['danger', 'danger', 'warning', 'info', 'success'];

        TrishulUtils.setAppBadgeTone(strengthEl, tones[strength], labels[strength], 'ms-2');
        strengthEl.classList.toggle('d-none', password.length === 0);
    },

    updateAuth: async function(e) {
        e.preventDefault();

        const currentPass = document.getElementById("set-auth-current-pass").value;
        const user        = document.getElementById("set-auth-user").value;
        const pass        = document.getElementById("set-auth-pass").value;
        const confirmPass = document.getElementById("set-auth-pass-confirm").value;
        const msgBox      = document.getElementById("auth-msg");

        msgBox.classList.add("d-none");

        if (pass !== confirmPass) {
            TrishulUtils.setAlertState(msgBox, 'danger', 'New passwords do not match!');
            return;
        }
        if (pass.length < 6) {
            TrishulUtils.setAlertState(msgBox, 'danger', 'Password must be at least 6 characters!');
            return;
        }
        const confirmed = await TrishulUtils.confirmDialog({
            title: `Update credentials for user "${user}"?`,
            message: 'You will be logged out and need to log in again.',
            confirmLabel: 'Update',
            variant: 'primary',
        });
        if (!confirmed) return;

        const btn          = e.target.querySelector('button[type="submit"]');
        const originalText = btn.innerHTML;
        btn.disabled       = true;
        btn.innerHTML      = '<i class="fas fa-spinner fa-spin me-2"></i> Updating...';

        try {
            const res = await fetch('/api/settings/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_password: currentPass,
                    username: user,
                    password: pass
                })
            });
            const data = await res.json();
            if (res.ok) {
                TrishulUtils.setAlertState(msgBox, 'success', '\u2713 Credentials updated successfully. Logging out...');
                // Backend deletes every session on credential update and signals
                // reauth_required — log out immediately instead of racing the 2s timer.
                if (data && data.reauth_required) {
                    logout(false);
                } else {
                    setTimeout(() => logout(false), 2000);
                }
            } else {
                TrishulUtils.setAlertState(msgBox, 'danger', data.detail || 'Error updating credentials.');
                btn.disabled       = false;
                btn.innerHTML      = originalText;
            }
        } catch (err) {
            console.error(err);
            TrishulUtils.setAlertState(msgBox, 'danger', 'Connection error. Please try again.');
            btn.disabled       = false;
            btn.innerHTML      = originalText;
        }
    },

    // ------------------------------------------------------------------ //
    // App Settings (Phase 2A)                                            //
    // ------------------------------------------------------------------ //

    loadAppSettings: async function() {
        try {
            const res = await fetch('/api/settings/app');
            if (!res.ok) return;
            const data   = await res.json();
            const simEl  = document.getElementById('set-auto-start-sim');
            const trapEl = document.getElementById('set-auto-start-trap');
            const toEl   = document.getElementById('set-session-timeout');
            const fetchEl = document.getElementById('set-mib-auto-fetch');
            const sourcesEl = document.getElementById('set-mib-remote-sources');
            if (simEl)  simEl.checked = !!data.auto_start_simulator;
            if (trapEl) trapEl.checked = !!data.auto_start_trap_receiver;
            if (toEl)   toEl.value    = data.session_timeout ?? 3600;
            if (fetchEl) fetchEl.checked = !!data.mib_auto_fetch;
            if (sourcesEl) sourcesEl.value = Array.isArray(data.mib_remote_sources) ? data.mib_remote_sources.join('\n') : '';
        } catch (err) {
            console.error('Failed to load app settings', err);
        }
    },

    saveAppSettings: async function() {
        const simEl  = document.getElementById('set-auto-start-sim');
        const trapEl = document.getElementById('set-auto-start-trap');
        const toEl   = document.getElementById('set-session-timeout');
        const fetchEl = document.getElementById('set-mib-auto-fetch');
        const sourcesEl = document.getElementById('set-mib-remote-sources');
        const msgBox = document.getElementById('app-settings-msg');
        const badge  = document.getElementById('settings-restart-badge');

        const timeout = parseInt(toEl?.value, 10);
        const sources = (sourcesEl?.value || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        const autoFetchEnabled = fetchEl?.checked ?? false;
        if (isNaN(timeout) || timeout < 60 || timeout > 86400) {
            TrishulUtils.setAlertState(msgBox, 'danger', 'Session timeout must be between 60 and 86400 seconds.');
            return;
        }
        if (sources.some(source => !source.includes('@mib@'))) {
            TrishulUtils.setAlertState(msgBox, 'danger', 'Every remote source entry must include @mib@.');
            return;
        }

        msgBox.classList.add('d-none');

        try {
            const res = await fetch('/api/settings/app', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    auto_start_simulator:     simEl?.checked  ?? true,
                    auto_start_trap_receiver: trapEl?.checked ?? true,
                    session_timeout:          timeout,
                    mib_auto_fetch:           autoFetchEnabled,
                    mib_remote_sources:       sources
                })
            });
            const data = await res.json();
            if (res.ok) {
                TrishulUtils.setAlertState(msgBox, 'success', '\u2713 Settings saved.');
                if (badge) {
                    badge.classList.toggle('d-none', !data.restart_required);
                }
            } else {
                TrishulUtils.setAlertState(msgBox, 'danger', data.detail || 'Error saving settings.');
            }
        } catch (err) {
            console.error(err);
            TrishulUtils.setAlertState(msgBox, 'danger', 'Connection error. Please try again.');
        }
    },

    // ------------------------------------------------------------------ //
    // Stats Management (Phase 2A)                                        //
    // ------------------------------------------------------------------ //

    exportStats: async function() {
        try {
            const res = await fetch('/api/stats/');
            if (!res.ok) {
                TrishulUtils.showNotification('Failed to fetch stats', 'danger');
                return;
            }
            const data = await res.json();
            const exportData = data && typeof data === 'object' ? { ...data } : {};
            delete exportData.runtime;
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `trishul-stats-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            TrishulUtils.showNotification('Stats exported', 'success');
        } catch (err) {
            console.error(err);
            TrishulUtils.showNotification('Export failed', 'danger');
        }
    },

    resetStats: async function() {
        const confirmed = await TrishulUtils.confirmDialog({
            title: 'Reset all activity stats to zero?',
            message: 'This cannot be undone.',
            confirmLabel: 'Reset',
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            const res = await fetch('/api/stats/', { method: 'DELETE' });
            if (res.ok) {
                TrishulUtils.showNotification('All stats reset to zero', 'success');
            } else {
                TrishulUtils.showNotification('Failed to reset stats', 'danger');
            }
        } catch (err) {
            console.error(err);
            TrishulUtils.showNotification('Connection error', 'danger');
        }
    },

    // ------------------------------------------------------------------ //
    // About (Phase 2A)                                                   //
    // ------------------------------------------------------------------ //

    loadAbout: async function() {
        try {
            const res = await fetch('/api/meta');
            if (!res.ok) return;
            const data = await res.json();
            const set  = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val || '\u2014';
            };
            set('about-app-name',    data.name);
            set('about-app-version', data.version);
            set('about-app-author',  data.author);
            set('about-app-desc',    data.description);
        } catch (err) {
            console.error('Failed to load app meta', err);
        }
    }
};

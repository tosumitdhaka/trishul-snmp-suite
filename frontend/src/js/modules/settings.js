window.SettingsModule = {
    init: function() {
        // Password strength indicator
        const passInput = document.getElementById("set-auth-pass");
        if (passInput) {
            passInput.addEventListener('input', (e) => this.checkPasswordStrength(e.target.value));
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
        const colors = ['danger', 'danger', 'warning', 'info', 'success'];

        strengthEl.textContent = labels[strength];
        strengthEl.className   = `badge bg-${colors[strength]} ms-2`;
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
            msgBox.textContent = "New passwords do not match!";
            msgBox.className   = "alert alert-danger small py-2 mb-3";
            return;
        }
        if (pass.length < 6) {
            msgBox.textContent = "Password must be at least 6 characters!";
            msgBox.className   = "alert alert-danger small py-2 mb-3";
            return;
        }
        if (!confirm(`Update credentials for user "${user}"?\n\nYou will be logged out and need to log in again.`)) {
            return;
        }

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
                msgBox.textContent = "\u2713 Credentials updated successfully. Logging out...";
                msgBox.className   = "alert alert-success small py-2 mb-3";
                setTimeout(() => logout(), 2000);
            } else {
                msgBox.textContent = data.detail || "Error updating credentials.";
                msgBox.className   = "alert alert-danger small py-2 mb-3";
                btn.disabled       = false;
                btn.innerHTML      = originalText;
            }
        } catch (err) {
            console.error(err);
            msgBox.textContent = "Connection error. Please try again.";
            msgBox.className   = "alert alert-danger small py-2 mb-3";
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
        if (isNaN(timeout) || timeout < 60 || timeout > 86400) {
            msgBox.textContent = 'Session timeout must be between 60 and 86400 seconds.';
            msgBox.className   = 'alert alert-danger small py-2 mb-3';
            msgBox.classList.remove('d-none');
            return;
        }
        if (sources.length === 0 || sources.some(source => !source.includes('@mib@'))) {
            msgBox.textContent = 'Provide at least one approved remote source and include @mib@ in every entry.';
            msgBox.className   = 'alert alert-danger small py-2 mb-3';
            msgBox.classList.remove('d-none');
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
                    mib_auto_fetch:           fetchEl?.checked ?? false,
                    mib_remote_sources:       sources
                })
            });
            const data = await res.json();
            if (res.ok) {
                msgBox.textContent = '\u2713 Settings saved.';
                msgBox.className   = 'alert alert-success small py-2 mb-3';
                msgBox.classList.remove('d-none');
                if (badge) {
                    badge.classList.toggle('d-none', !data.restart_required);
                }
            } else {
                msgBox.textContent = data.detail || 'Error saving settings.';
                msgBox.className   = 'alert alert-danger small py-2 mb-3';
                msgBox.classList.remove('d-none');
            }
        } catch (err) {
            console.error(err);
            msgBox.textContent = 'Connection error. Please try again.';
            msgBox.className   = 'alert alert-danger small py-2 mb-3';
            msgBox.classList.remove('d-none');
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
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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
        if (!confirm('Reset all activity stats to zero?\n\nThis cannot be undone.')) return;
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

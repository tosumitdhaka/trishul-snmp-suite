window.SimulatorModule = {
    _listeners: [],
    lastSavedJson: '{}',
    filteredLogs: [],

    init: function() {
        this.destroy();

        if (!window.AppState) {
            window.AppState = {};
        }

        const storedLogs = Array.isArray(window.AppState.logs)
            ? window.AppState.logs
            : this.loadLogsFromStorage();
        window.AppState.logs = storedLogs
            .map(entry => this.normalizeLogEntry(entry))
            .filter(Boolean);

        this.renderLogs(window.AppState.logs, true);

        if (window.AppState.simulator) {
            this.updateUI(window.AppState.simulator);
        } else {
            this.setButtons(false);
        }

        this.loadCustomData();
        this.attachEditorEvents();
        this.updateLogStats();

        // Replace 10s setInterval with WS event listeners
        this._registerListeners();

        // REST seed: populates UI before the first WS push arrives
        this.fetchStatus();
    },

    destroy: function() {
        this._listeners.forEach(function(pair) {
            window.removeEventListener(pair[0], pair[1]);
        });
        this._listeners = [];
    },

    _on: function(type, fn) {
        window.addEventListener(type, fn);
        this._listeners.push([type, fn]);
    },

    _registerListeners: function() {
        var self = this;

        // Full simulator state pushed on every WS (re)connect
        this._on('trishul:ws:full_state', function(e) {
            if (e.detail && e.detail.simulator) {
                window.AppState.simulator = e.detail.simulator;
                self.updateUI(e.detail.simulator);
            }
        });

        // Lightweight push on start / stop / restart lifecycle changes
        this._on('trishul:ws:status', function(e) {
            if (e.detail && e.detail.simulator) {
                window.AppState.simulator = e.detail.simulator;
                self.updateUI(e.detail.simulator);
            }
        });

        // REST re-seed after WS reconnect
        this._on('trishul:ws:open', function() {
            self.fetchStatus();
        });
    },

    // ==================== Log Persistence ====================

    loadLogsFromStorage: function() {
        try {
            const stored = localStorage.getItem('trishul_simulator_logs');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    return parsed;
                }
            }
        } catch (e) {
            console.error('Failed to load logs from storage:', e);
        }
        return [];
    },

    saveLogsToStorage: function() {
        try {
            // Keep only last 500 logs in storage
            const logsToSave = window.AppState.logs.slice(-500);
            localStorage.setItem('trishul_simulator_logs', JSON.stringify(logsToSave));
        } catch (e) {
            console.error('Failed to save logs to storage:', e);
        }
    },

    clearStoredLogs: function() {
        try {
            localStorage.removeItem('trishul_simulator_logs');
        } catch (e) {
            console.error('Failed to clear logs from storage:', e);
        }
    },

    decodeLegacyHtml: function(value) {
        return String(value || '')
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    },

    stripHtmlTags: function(value) {
        return String(value || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },

    normalizeLogEntry: function(entry) {
        if (!entry) return null;

        if (typeof entry === 'object') {
            return {
                time: String(entry.time || new Date().toLocaleTimeString()),
                level: String(entry.level || 'info'),
                message: String(entry.message || ''),
            };
        }

        if (typeof entry === 'string') {
            const levelMatch = entry.match(/data-level="([^"]*)"/);
            const textMatch = entry.match(/data-text="([^"]*)"/);
            const timeMatch = entry.match(/\[([^\]]+)\]/);
            const fallbackText = this.stripHtmlTags(entry).replace(/^\[[^\]]+\]\s*/, '').trim();

            return {
                time: timeMatch ? this.decodeLegacyHtml(timeMatch[1]) : new Date().toLocaleTimeString(),
                level: this.decodeLegacyHtml(levelMatch ? levelMatch[1] : 'info'),
                message: this.decodeLegacyHtml(textMatch ? textMatch[1] : fallbackText),
            };
        }

        return null;
    },

    buildLogHtml: function(entry) {
        const esc = TrishulUtils.escapeHtml;
        const level = entry.level || 'info';
        const message = String(entry.message || '');
        const time = String(entry.time || '');

        let icon  = 'fa-info-circle';
        let color = 'text-muted';

        if (level === 'success') {
            icon  = 'fa-check-circle';
            color = 'text-success';
        } else if (level === 'error') {
            icon  = 'fa-exclamation-circle';
            color = 'text-danger';
        } else if (level === 'warning') {
            icon  = 'fa-exclamation-triangle';
            color = 'text-warning';
        }

        return `
            <div class="border-bottom py-2 px-2 log-entry" data-level="${esc(level)}" data-text="${esc(message)}">
                <span class="text-muted small">[${esc(time)}]</span>
                <i class="fas ${icon} ${color} ms-2"></i>
                <span class="ms-2">${esc(message)}</span>
            </div>
        `;
    },

    renderLogs: function(entries, scrollToBottom) {
        const area = document.getElementById('sim-log-area');
        if (!area) return;

        if (!Array.isArray(entries) || entries.length === 0) {
            area.innerHTML = '<div class="text-muted small p-2">Waiting for events...</div>';
            return;
        }

        area.innerHTML = entries.map(entry => this.buildLogHtml(entry)).join('');
        if (scrollToBottom) {
            area.scrollTop = area.scrollHeight;
        }
    },

    attachEditorEvents: function() {
        const editor = document.getElementById('custom-data-editor');
        const unsaved = document.getElementById('unsaved-indicator');
        const jsonError = document.getElementById('json-error-indicator');

        if (!editor) return;

        editor.addEventListener('input', () => {
            const current = editor.value;
            // Unsaved indicator
            if (current.trim() !== this.lastSavedJson.trim()) {
                unsaved && unsaved.classList.remove('d-none');
            } else {
                unsaved && unsaved.classList.add('d-none');
            }

            // JSON validation (soft)
            try {
                if (current.trim()) {
                    JSON.parse(current);
                    jsonError && jsonError.classList.add('d-none');
                    editor.classList.remove('is-invalid');
                } else {
                    jsonError && jsonError.classList.add('d-none');
                    editor.classList.remove('is-invalid');
                }
            } catch (e) {
                jsonError && jsonError.classList.remove('d-none');
                editor.classList.add('is-invalid');
            }
        });
    },

    beforeUnloadHandler: function(e) {
        const editor = document.getElementById('custom-data-editor');
        if (!editor) return;
        if (editor.value.trim() !== SimulatorModule.lastSavedJson.trim()) {
            e.preventDefault();
            e.returnValue = '';
        }
    },

    loadCustomData: async function() {
        const editor = document.getElementById('custom-data-editor');
        if (!editor) return;

        try {
            const res = await fetch('/api/simulator/data');
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            const pretty = JSON.stringify(data, null, 2);
            editor.value = pretty;
            this.lastSavedJson = pretty;
            window.addEventListener('beforeunload', this.beforeUnloadHandler);
        } catch (e) {
            console.error('Failed to load custom data:', e);
            const fallback = '{}';
            editor.value = fallback;
            this.lastSavedJson = fallback;
        }
    },

    saveCustomData: async function() {
        const editor = document.getElementById('custom-data-editor');
        const unsaved = document.getElementById('unsaved-indicator');
        const jsonError = document.getElementById('json-error-indicator');
        const content = editor.value;

        try {
            const json = JSON.parse(content);

            const res = await fetch('/api/simulator/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json)
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const data = await res.json();

            this.lastSavedJson = content;
            unsaved && unsaved.classList.add('d-none');
            jsonError && jsonError.classList.add('d-none');
            editor.classList.remove('is-invalid');

            this.log(`Custom data saved: ${data.message}`, 'success');
            this.showToast('Custom data saved successfully');
        } catch (e) {
            console.error('Save error:', e);
            this.log('Failed to save custom data: ' + e.message, 'error');
            this.showToast('Failed to save custom data: ' + e.message, 'error');
        }
    },

    formatJson: function() {
        const editor = document.getElementById('custom-data-editor');
        try {
            const current = editor.value;
            if (!current.trim()) return;
            const parsed = JSON.parse(current);
            const pretty = JSON.stringify(parsed, null, 2);
            editor.value = pretty;
            this.log('JSON formatted successfully', 'success');
        } catch (e) {
            this.showToast('Invalid JSON: ' + e.message, 'error');
        }
    },

    start: async function() {
        const port = document.getElementById('sim-config-port').value;
        const comm = document.getElementById('sim-config-comm').value;

        this.log(`Starting simulator on Port ${port}...`);

        try {
            const res = await fetch('/api/simulator/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port: parseInt(port), community: comm })
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const data = await res.json();
            
            if (data.status === 'started') {
                this.log(data.message || 'Simulator started successfully', 'success');
                this.showToast(data.message || 'Simulator started successfully', 'success');
            } else if (data.status === 'already_running') {
                this.log(data.message || 'Simulator is already running', 'warning');
                this.showToast(data.message || 'Simulator is already running', 'warning');
            }
            
            // WS status push will update the UI; this call is a fallback
            // for the rare case the WS message races with the REST response.
            this.fetchStatus();
        } catch (e) {
            console.error('Start error:', e);
            this.log('Failed to start simulator: ' + e.message, 'error');
            this.showToast('Failed to start simulator: ' + e.message, 'error');
        }
    },

    stop: async function() {
        this.log('Stopping simulator...');
        try {
            const res = await fetch('/api/simulator/stop', { method: 'POST' });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const data = await res.json();
            this.log(data.message || 'Simulator stopped successfully', 'success');
            this.showToast(data.message || 'Simulator stopped successfully', 'info');
            this.fetchStatus();
        } catch (e) {
            console.error('Stop error:', e);
            this.log('Failed to stop simulator: ' + e.message, 'error');
            this.showToast('Failed to stop simulator: ' + e.message, 'error');
        }
    },

    restart: async function() {
        this.log('Restarting simulator...');
        try {
            const res = await fetch('/api/simulator/restart', { method: 'POST' });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const data = await res.json();
            this.log(data.message || 'Simulator restarted successfully', 'success');
            this.showToast(data.message || 'Simulator restarted successfully', 'success');
            this.fetchStatus();
        } catch (e) {
            console.error('Restart error:', e);
            this.log('Failed to restart simulator: ' + e.message, 'error');
            this.showToast('Failed to restart simulator: ' + e.message, 'error');
        }
    },

    fetchStatus: async function() {
        try {
            const res = await fetch('/api/simulator/status');
            if (!res.ok) return;
            const data = await res.json();

            window.AppState.simulator = data;
            this.updateUI(data);
        } catch (e) {
            console.error('Sim status error', e);
            this.log('Error fetching simulator status: ' + e.message, 'error');
        }
    },

    updateUI: function(data) {
        const badge      = document.getElementById('sim-badge');
        const stateText  = document.getElementById('sim-state-text');
        const detailText = document.getElementById('sim-detail-text');
        const metrics    = document.getElementById('sim-metrics');
        const uptimeEl   = document.getElementById('sim-uptime');
        const reqEl      = document.getElementById('sim-requests');
        const lastActEl  = document.getElementById('sim-last-activity');
        const configHint = document.getElementById('config-hint');
        const configDisabledHint = document.getElementById('config-disabled-hint');
        const portInput  = document.getElementById('sim-config-port');
        const commInput  = document.getElementById('sim-config-comm');
        const esc = TrishulUtils.escapeHtml;

        if (!badge || !stateText || !detailText) return;

        if (data.running) {
            badge.className = 'badge bg-success';
            badge.textContent = 'RUNNING';
            stateText.textContent = 'Online';
            stateText.className = 'mb-0 text-success fw-bold';
            detailText.innerHTML = `Listening on <strong>UDP ${Number(data.port) || '--'}</strong> <br> Community: <code>${esc(data.community || '')}</code> <br> PID: ${Number(data.pid) || '--'}`;

            this.setButtons(true);

            if (portInput) {
                portInput.value = data.port;
                portInput.disabled = true;
            }
            if (commInput) {
                commInput.value = data.community;
                commInput.disabled = true;
            }

            configHint && configHint.classList.add('d-none');
            configDisabledHint && configDisabledHint.classList.remove('d-none');

            if (metrics && uptimeEl && reqEl && lastActEl) {
                metrics.classList.remove('d-none');
                // uptime_seconds (int) → compact human duration via TrishulUtils
                uptimeEl.textContent  = TrishulUtils.formatUptime(data.uptime_seconds);
                // requests: populated from stats_store.simulator.snmp_requests_served
                reqEl.textContent     = data.requests ?? 0;
                // last_activity: ISO ts from stats_store → relative time via TrishulUtils
                lastActEl.textContent = TrishulUtils.formatRelativeTime(data.last_activity);
            }
        } else {
            badge.className = 'badge bg-secondary';
            badge.textContent = 'STOPPED';
            stateText.textContent = 'Offline';
            stateText.className = 'mb-0 text-secondary fw-bold';
            detailText.textContent = 'Service is stopped.';

            this.setButtons(false);

            if (portInput) {
                portInput.disabled = false;
            }
            if (commInput) {
                commInput.disabled = false;
            }

            configDisabledHint && configDisabledHint.classList.add('d-none');
            if (portInput && commInput && (portInput.value || commInput.value)) {
                configHint && configHint.classList.add('d-none');
            }

            if (metrics) {
                metrics.classList.add('d-none');
            }
        }
    },

    setButtons: function(isRunning) {
        const btnStart   = document.getElementById('btn-start');
        const btnStop    = document.getElementById('btn-stop');
        const btnRestart = document.getElementById('btn-restart');

        if (!btnStart || !btnStop || !btnRestart) return;

        btnStart.disabled   = isRunning;
        btnStop.disabled    = !isRunning;
        btnRestart.disabled = !isRunning;
    },

    log: function(msg, type = 'info') {
        const entry = {
            time: new Date().toLocaleTimeString(),
            level: type,
            message: String(msg || ''),
        };

        window.AppState.logs.push(entry);
        if (window.AppState.logs.length > 500) window.AppState.logs.shift();

        this.saveLogsToStorage();
        this.renderLogs(window.AppState.logs, true);

        this.updateLogStats();
    },

    clearLog: function() {
        window.AppState.logs = [];
        this.clearStoredLogs();
        this.renderLogs([]);
        this.updateLogStats();
    },

    exportLog: function() {
        const blob = new Blob([this.getPlainLogText()], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `trishul-simulator-log-${new Date().toISOString()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    },

    getPlainLogText: function() {
        return (window.AppState.logs || []).map(entry => {
            const normalized = this.normalizeLogEntry(entry);
            return normalized ? `[${normalized.time}] ${normalized.message}` : '';
        }).filter(Boolean).join('\n');
    },

    filterLogs: function() {
        const searchInput  = document.getElementById('log-search');
        const filterSelect = document.getElementById('log-filter');
        const area         = document.getElementById('sim-log-area');

        if (!area) return;

        const searchTerm = (searchInput?.value || '').toLowerCase();
        const level      = filterSelect?.value || 'all';

        const filtered = (window.AppState.logs || []).map(entry => this.normalizeLogEntry(entry)).filter(entry => {
            if (!entry) return false;
            const matchesLevel  = level === 'all' || entry.level === level;
            const matchesSearch = !searchTerm || entry.message.toLowerCase().includes(searchTerm);
            return matchesLevel && matchesSearch;
        });

        this.renderLogs(filtered, true);
        if (filtered.length === 0) {
            area.innerHTML = '<div class="text-muted small p-2">No log entries match current filter.</div>';
        }
        this.updateLogStats(filtered.length);
    },

    updateLogStats: function(filteredCount) {
        const stats = document.getElementById('log-stats');
        const total   = window.AppState.logs ? window.AppState.logs.length : 0;
        const current = typeof filteredCount === 'number' ? filteredCount : total;

        if (stats) {
            stats.textContent = `${current} entries${current !== total ? ` (of ${total})` : ''}`;
        }
    },

    showToast: function(message, type = 'success') {
        TrishulUtils.showNotification(message, type, 4000);
    }
};

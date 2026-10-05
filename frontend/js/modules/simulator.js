window.SimulatorModule = {
    _listeners: [],
    lastSavedJson: '{}',
    filteredLogs: [],
    _statusPollTimer: null,
    _logPollTimer: null,
    _statusPollInFlight: false,
    _logPollInFlight: false,
    _lastLogSignature: '',
    _customDataWarningsDismissed: false,
    _uptimeTickerTimer: null,
    _uptimeBaseSeconds: 0,
    _uptimeAnchorMs: 0,
    _lastHash: '',
    _hashNavGuard: false,
    _logFollow: true,
    _logAreaScrollHandler: null,
    _renderedCount: 0,
    _lastRenderedArray: null,
    _renderedFirst: null,
    _lastStatusError: '',
    _savingCustomData: false,

    init: function() {
        this.destroy();
        this._lastHash = location.hash || '';

        if (!window.AppState) {
            window.AppState = {};
        }

        const currentStateLogs = Array.isArray(window.AppState.logs) ? window.AppState.logs : [];
        const storedLogs = currentStateLogs.length > 0
            ? currentStateLogs
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
        this.attachLogScrollTracking();

        // Replace 10s setInterval with WS event listeners
        this._registerListeners();

        // REST seed: populates UI before the first WS push arrives
        this.fetchStatus();
        this.loadLogs(true);
        this._startPollingFallback();
    },

    destroy: function() {
        const area = document.getElementById('sim-log-area');
        if (area && this._logAreaScrollHandler) {
            area.removeEventListener('scroll', this._logAreaScrollHandler);
        }
        this._logAreaScrollHandler = null;
        this._listeners.forEach(function(pair) {
            window.removeEventListener(pair[0], pair[1]);
        });
        this._listeners = [];
        this._stopPollingFallback();
        this._stopUptimeTicker();
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

        this._on('trishul:simulator-log-updated', function() {
            const hasActiveFilter = (document.getElementById('log-search')?.value || '').trim()
                || ((document.getElementById('log-filter')?.value || 'all') !== 'all');
            if (hasActiveFilter) {
                self.filterLogs();
                return;
            }
            self.renderLogs(window.AppState.logs || [], true);
            self.updateLogStats();
        });

        // Live request count from the stats push: the status payload only
        // changes on lifecycle events, so without this the Requests card
        // freezes while the WS is healthy.
        this._on('trishul:ws:stats', function(e) {
            const served = e.detail && e.detail.stats && e.detail.stats.simulator
                ? e.detail.stats.simulator.snmp_requests_served
                : undefined;
            if (typeof served === 'number') {
                self.updateRequestsCard(served);
            }
        });

        // REST re-seed after WS reconnect
        this._on('trishul:ws:open', function() {
            self._stopPollingFallback();
            self._setLogSourceIndicator('live');
            self.fetchStatus();
            self.loadLogs(true);
        });

        this._on('trishul:ws:close', function() {
            self._startPollingFallback();
        });

        // SPA hash navigation would silently discard unsaved custom-data edits
        // (beforeunload does not fire for hash changes).
        this._on('hashchange', function() {
            self._guardHashNav();
        });
    },

    _startPollingFallback: function() {
        var self = this;

        this._stopPollingFallback();
        if (window.WsClient && typeof window.WsClient.isConnected === 'function' && window.WsClient.isConnected()) {
            this._setLogSourceIndicator('live');
            return;
        }

        // SIM-21: the pane is being fed by the polling fallback, so the
        // "Live" indicator must reflect that instead of claiming WS liveness.
        this._setLogSourceIndicator('polling');

        this._statusPollTimer = window.setInterval(function() {
            if (self._statusPollInFlight) return;
            self._statusPollInFlight = true;
            Promise.resolve(self.fetchStatus()).finally(function() {
                self._statusPollInFlight = false;
            });
        }, 4000);

        this._logPollTimer = window.setInterval(function() {
            if (self._logPollInFlight) return;
            self._logPollInFlight = true;
            Promise.resolve(self.loadLogs(true)).finally(function() {
                self._logPollInFlight = false;
            });
        }, 1500);
    },

    _setLogSourceIndicator: function(source) {
        const el = document.getElementById('log-live-indicator');
        if (!el) return;
        if (source === 'live') {
            el.classList.remove('is-idle');
            el.classList.add('is-live');
            el.innerHTML = '<i class="fas fa-circle fa-xs me-1"></i> Live';
            el.title = 'Live updates via WebSocket';
        } else {
            el.classList.remove('is-live');
            el.classList.add('is-idle');
            el.innerHTML = '<i class="fas fa-sync fa-xs me-1"></i> Polling';
            el.title = 'Updates via polling (WebSocket unavailable)';
        }
    },

    _stopPollingFallback: function() {
        if (this._statusPollTimer) {
            clearInterval(this._statusPollTimer);
            this._statusPollTimer = null;
        }
        if (this._logPollTimer) {
            clearInterval(this._logPollTimer);
            this._logPollTimer = null;
        }
        this._statusPollInFlight = false;
        this._logPollInFlight = false;
    },

    updateRequestsCard: function(served) {
        const reqEl = document.getElementById('sim-requests');
        if (reqEl) reqEl.textContent = served;
    },

    _startUptimeTicker: function(uptimeSeconds) {
        this._uptimeBaseSeconds = Number(uptimeSeconds) || 0;
        this._uptimeAnchorMs = Date.now();
        if (this._uptimeTickerTimer) return;
        const self = this;
        this._uptimeTickerTimer = window.setInterval(function() {
            const uptimeEl = document.getElementById('sim-uptime');
            if (!uptimeEl) return;
            const elapsed = Math.floor((Date.now() - self._uptimeAnchorMs) / 1000);
            uptimeEl.textContent = TrishulUtils.formatUptime(self._uptimeBaseSeconds + elapsed);
        }, 1000);
    },

    _stopUptimeTicker: function() {
        if (this._uptimeTickerTimer) {
            clearInterval(this._uptimeTickerTimer);
            this._uptimeTickerTimer = null;
        }
    },

    _guardHashNav: function() {
        const editor = document.getElementById('custom-data-editor');
        if (!editor) return;
        if (this._hashNavGuard) {
            // Hash was restored after a declined navigation; no second prompt.
            this._hashNavGuard = false;
            this._lastHash = location.hash;
            return;
        }
        if (editor.value.trim() === this.lastSavedJson.trim()) {
            this._lastHash = location.hash;
            return;
        }
        const ok = window.confirm('You have unsaved custom data changes. Leave the Simulator page?');
        if (!ok) {
            this._hashNavGuard = true;
            location.hash = this._lastHash || '#/simulator';
            return;
        }
        this._lastHash = location.hash;
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

    decodeEscapedHtml: function(value) {
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
            const fallbackTime = String(entry.time || '');
            const normalized = {
                time: fallbackTime || new Date().toLocaleTimeString(),
                level: String(entry.level || 'info'),
                message: String(entry.message || ''),
            };

            if (entry.request_type) {
                normalized.request_type = String(entry.request_type).toUpperCase();
            }
            if (entry.first_requested_oid) {
                normalized.first_requested_oid = String(entry.first_requested_oid);
            }
            if (entry.first_returned_oid) {
                normalized.first_returned_oid = String(entry.first_returned_oid);
            }
            if (entry.timestamp) {
                normalized.timestamp = String(entry.timestamp);
            }
            if (entry.last_event_timestamp) {
                normalized.last_event_timestamp = String(entry.last_event_timestamp);
            }
            if (Array.isArray(entry.requested_oids)) {
                normalized.requested_oids = entry.requested_oids.map(item => String(item));
            }
            if (Array.isArray(entry.returned_oids)) {
                normalized.returned_oids = entry.returned_oids.map(item => String(item));
            }

            const oidCount = Number(entry.oid_count);
            if (Number.isFinite(oidCount) && oidCount >= 0) {
                normalized.oid_count = oidCount;
            }

            const requestCount = Number(entry.request_count);
            if (Number.isFinite(requestCount) && requestCount > 0) {
                normalized.request_count = requestCount;
            }

            if (window.TrishulUtils && typeof TrishulUtils.formatClockTime === 'function') {
                normalized.time = TrishulUtils.formatClockTime(
                    normalized.last_event_timestamp || normalized.timestamp || fallbackTime,
                    fallbackTime
                );
            }

            return normalized;
        }

        if (typeof entry === 'string') {
            const levelMatch = entry.match(/data-level="([^"]*)"/);
            const textMatch = entry.match(/data-text="([^"]*)"/);
            const timeMatch = entry.match(/\[([^\]]+)\]/);
            const fallbackText = this.stripHtmlTags(entry).replace(/^\[[^\]]+\]\s*/, '').trim();

            return {
                time: window.TrishulUtils && typeof TrishulUtils.formatClockTime === 'function'
                    ? TrishulUtils.formatClockTime(
                        timeMatch ? this.decodeEscapedHtml(timeMatch[1]) : '',
                        this.decodeEscapedHtml(timeMatch ? timeMatch[1] : '')
                    )
                    : (timeMatch ? this.decodeEscapedHtml(timeMatch[1]) : new Date().toLocaleTimeString()),
                level: this.decodeEscapedHtml(levelMatch ? levelMatch[1] : 'info'),
                message: this.decodeEscapedHtml(textMatch ? textMatch[1] : fallbackText),
            };
        }

        return null;
    },

    buildLogHtml: function(entry) {
        const esc = TrishulUtils.escapeHtml;
        const level = entry.level || 'info';
        const message = String(entry.message || '');
        const time = String(entry.time || '');
        const requestedOids = Array.isArray(entry.requested_oids) ? entry.requested_oids : [];
        const returnedOids = Array.isArray(entry.returned_oids) ? entry.returned_oids : [];
        const requestCount = Number(entry.request_count) || 0;

        let icon  = 'fa-info-circle';
        let color = 'app-header-icon is-neutral';

        if (level === 'success') {
            icon  = 'fa-check-circle';
            color = 'app-header-icon is-success';
        } else if (level === 'error') {
            icon  = 'fa-exclamation-circle';
            color = 'app-header-icon is-danger';
        } else if (level === 'warning') {
            icon  = 'fa-exclamation-triangle';
            color = 'app-header-icon is-warning';
        }

        const detailParts = [];
        if (requestCount <= 1 && requestedOids.length > 0) {
            const preview = requestedOids.slice(0, 2).join(', ');
            detailParts.push(`Requested: ${preview}${requestedOids.length > 2 ? ` (+${requestedOids.length - 2})` : ''}`);
        }
        if (requestCount <= 1 && returnedOids.length > 0) {
            const preview = returnedOids.slice(0, 2).join(', ');
            detailParts.push(`Returned: ${preview}${returnedOids.length > 2 ? ` (+${returnedOids.length - 2})` : ''}`);
        }

        return `
            <div class="border-bottom py-2 px-2 log-entry" data-level="${esc(level)}" data-text="${esc(message)}">
                <div>
                    <span class="text-muted small">[${esc(time)}]</span>
                    <i class="fas ${icon} ${color} ms-2"></i>
                    <span class="ms-2">${esc(message)}</span>
                </div>
                ${detailParts.length > 0 ? `
                    <div class="small text-muted mt-1 ms-4">${esc(detailParts.join(' | '))}</div>
                ` : ''}
            </div>
        `;
    },

    coalesceLogEntries: function(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return [];

        const canBatch = typeof window.shouldBatchSimulatorLog === 'function'
            && typeof window.batchSimulatorLogEntries === 'function';
        if (!canBatch) {
            return entries.slice();
        }

        return entries.reduce((acc, entry) => {
            const previous = acc.length > 0 ? acc[acc.length - 1] : null;
            if (previous && window.shouldBatchSimulatorLog(previous, entry)) {
                acc[acc.length - 1] = window.batchSimulatorLogEntries(previous, entry);
                return acc;
            }
            acc.push(entry);
            return acc;
        }, []);
    },

    // SIM-14: merge the backend log list with the current pane state instead
    // of replacing it, so locally-appended entries (lifecycle messages such
    // as "Starting simulator...") are not wiped by a backend refresh. Backend
    // entries always carry a timestamp; only local-only rows are preserved.
    mergeLogLists: function(existing, incoming) {
        const existingList = Array.isArray(existing) ? existing : [];
        const incomingList = Array.isArray(incoming) ? incoming : [];
        if (incomingList.length === 0) {
            return existingList.slice(-500);
        }
        const localOnly = existingList.filter(entry => {
            const n = this.normalizeLogEntry(entry);
            return Boolean(n) && !n.timestamp && !n.last_event_timestamp;
        });
        return this.coalesceLogEntries(incomingList.concat(localOnly)).slice(-500);
    },

    renderLogs: function(entries, scrollToBottom) {
        const area = document.getElementById('sim-log-area');
        if (!area) return;

        const userSelection = window.getSelection ? String(window.getSelection() || '').trim() : '';
        if (userSelection) {
            return;
        }

        if (!Array.isArray(entries) || entries.length === 0) {
            area.innerHTML = TrishulUtils.buildPanelPlaceholder({
                icon: 'fa-wave-square',
                title: 'Waiting for activity',
                copy: 'Live simulator requests and summaries will appear here.',
                compact: true,
            });
            this._renderedCount = 0;
            this._lastRenderedArray = null;
            this._renderedFirst = null;
            return;
        }

        // SIM-26: auto-scroll only while following; a paused viewport keeps
        // its position as new entries append below.
        const keepPosition = !this._logFollow && area.scrollTop > 0;
        const prevScrollTop = area.scrollTop;

        // SIM-22: the log pane grows incrementally. The common per-event path
        // appends only the new tail instead of rebuilding the whole list; a
        // full rebuild happens only when the list is replaced wholesale
        // (backend refresh, filter, clear).
        const sameArray = entries === this._lastRenderedArray;
        if (sameArray && this._renderedCount > 0) {
            if (this._renderedCount < entries.length) {
                // Grew in place: append only the new tail.
                const tail = entries.slice(this._renderedCount).map(entry => this.buildLogHtml(entry)).join('');
                if (tail) {
                    area.insertAdjacentHTML('beforeend', tail);
                }
            } else if (entries.length === this._renderedCount && entries[0] !== this._renderedFirst) {
                // The 500-entry cap dropped the head in place: slide the pane
                // by removing the first rendered row and appending the newest.
                if (area.firstElementChild) {
                    area.firstElementChild.remove();
                }
                const lastHtml = this.buildLogHtml(entries[entries.length - 1]);
                if (lastHtml) {
                    area.insertAdjacentHTML('beforeend', lastHtml);
                }
            } else {
                // Nothing new to render.
                return;
            }
            this._renderedCount = entries.length;
            this._renderedFirst = entries[0];
        } else {
            const html = entries.map(entry => this.buildLogHtml(entry)).join('');
            area.innerHTML = html;
            this._lastRenderedArray = entries;
            this._renderedCount = entries.length;
            this._renderedFirst = entries.length > 0 ? entries[0] : null;
        }

        if (keepPosition) {
            area.scrollTop = prevScrollTop;
        } else if (scrollToBottom && this._logFollow) {
            area.scrollTop = area.scrollHeight;
        }
    },

    getLogSignature: function(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return '';
        return JSON.stringify(entries.map(entry => ({
            time: entry.time || '',
            level: entry.level || '',
            message: entry.message || '',
            timestamp: entry.timestamp || '',
            last_event_timestamp: entry.last_event_timestamp || '',
            request_type: entry.request_type || '',
            request_count: entry.request_count || 0,
            oid_count: entry.oid_count || 0,
            first_requested_oid: entry.first_requested_oid || '',
            first_returned_oid: entry.first_returned_oid || '',
        })));
    },

    appendLogEntry: function(entry, scrollToBottom) {
        const normalized = this.normalizeLogEntry(entry);
        if (!normalized) return;

        window.AppState.logs.push(normalized);
        if (window.AppState.logs.length > 500) window.AppState.logs.shift();

        this.saveLogsToStorage();

        const hasActiveFilter = (document.getElementById('log-search')?.value || '').trim()
            || ((document.getElementById('log-filter')?.value || 'all') !== 'all');

        if (hasActiveFilter) {
            this.filterLogs();
            return;
        }

        this.renderLogs(window.AppState.logs, scrollToBottom);
        this.updateLogStats();
    },

    attachEditorEvents: function() {
        const editor = document.getElementById('custom-data-editor');
        const unsaved = document.getElementById('unsaved-indicator');
        const jsonError = document.getElementById('json-error-indicator');
        const jsonErrorBadge = document.getElementById('json-error-badge');
        const jsonErrorText = document.getElementById('json-error-text');

        if (!editor) return;

        // SIM-25: render the parse error (truncated) on the badge with the
        // full message as a tooltip, so "JSON Error" carries actionable detail.
        const setJsonError = function(message) {
            const full = String(message || 'Invalid JSON');
            const truncated = full.length > 80 ? full.slice(0, 77) + '...' : full;
            if (jsonErrorText) {
                jsonErrorText.textContent = 'JSON Error: ' + truncated;
            }
            if (jsonErrorBadge) {
                jsonErrorBadge.title = full;
            }
        };
        const clearJsonError = function() {
            if (jsonErrorText) {
                jsonErrorText.textContent = 'JSON Error';
            }
            if (jsonErrorBadge) {
                jsonErrorBadge.removeAttribute('title');
            }
        };

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
                    clearJsonError();
                } else {
                    jsonError && jsonError.classList.add('d-none');
                    editor.classList.remove('is-invalid');
                    clearJsonError();
                }
            } catch (e) {
                jsonError && jsonError.classList.remove('d-none');
                editor.classList.add('is-invalid');
                setJsonError(e && e.message ? e.message : 'Invalid JSON');
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
                throw new Error(await this.readErrorMessage(res, `HTTP ${res.status}`));
            }
            const data = await res.json();
            const pretty = JSON.stringify(data, null, 2);
            editor.value = pretty;
            this.lastSavedJson = pretty;
            this._on('beforeunload', this.beforeUnloadHandler);
        } catch (e) {
            console.error('Failed to load custom data:', e);
            const fallback = '{}';
            editor.value = fallback;
            this.lastSavedJson = fallback;
            this._on('beforeunload', this.beforeUnloadHandler);
        }
    },

    saveCustomData: async function() {
        const editor = document.getElementById('custom-data-editor');
        const unsaved = document.getElementById('unsaved-indicator');
        const jsonError = document.getElementById('json-error-indicator');
        const saveBtn = document.getElementById('btn-save-custom-data');
        const content = editor.value;

        // SIM-24: in-flight guard — a double-click must not double-submit.
        if (this._savingCustomData) return;
        this._savingCustomData = true;
        const originalBtnHtml = saveBtn ? saveBtn.innerHTML : '';
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.setAttribute('aria-busy', 'true');
            saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span> Saving...';
        }

        try {
            const json = JSON.parse(content);

            const res = await fetch('/api/simulator/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json)
            });

            if (!res.ok) {
                throw new Error(await this.readErrorMessage(res, `HTTP ${res.status}`));
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
        } finally {
            this._savingCustomData = false;
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.removeAttribute('aria-busy');
                saveBtn.innerHTML = originalBtnHtml;
            }
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
        const portInput = document.getElementById('sim-config-port');
        const commInput = document.getElementById('sim-config-comm');
        if (!portInput || !commInput) return;
        const port = portInput.value;
        const comm = commInput.value;
        const portNumber = Number(port);

        // Client-side validation so lifecycle errors are not just "HTTP 400/422".
        if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
            this.log('Cannot start: port must be an integer between 1 and 65535.', 'error');
            this.showToast('Invalid port: must be an integer between 1 and 65535.', 'error');
            return;
        }

        this.log(`Starting simulator on Port ${port}...`);

        try {
            const res = await fetch('/api/simulator/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port: portNumber, community: comm })
            });

            if (!res.ok) {
                throw new Error(await this.readErrorMessage(res, `HTTP ${res.status}`));
            }

            const data = await res.json();
            
            if (data.status === 'started') {
                this.log(data.message || 'Simulator started successfully', 'success');
                this.showToast(data.message || 'Simulator started successfully', 'success');
            }

            // 2.1.0 warn-and-skip contract: surface skipped/invalid custom-data
            // entries from the start response as an inline warning alert.
            this._customDataWarningsDismissed = false;
            this.renderCustomDataWarnings(data.custom_data_warnings);
            
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
                throw new Error(await this.readErrorMessage(res, `HTTP ${res.status}`));
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
                throw new Error(await this.readErrorMessage(res, `HTTP ${res.status}`));
            }

            const data = await res.json();
            this.log(data.message || 'Simulator restarted successfully', 'success');
            this.showToast(data.message || 'Simulator restarted successfully', 'success');

            // Restart delegates to start(), whose response carries the same
            // custom-data warnings contract — render them like the start path.
            this._customDataWarningsDismissed = false;
            this.renderCustomDataWarnings(data.custom_data_warnings);

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
            this._lastStatusError = '';
        } catch (e) {
            console.error('Sim status error', e);
            // SIM-20: the 4s polling fallback retries backend-down errors
            // continuously; collapse consecutive identical failures into a
            // single activity-log entry instead of spamming the pane.
            const message = 'Error fetching simulator status: ' + e.message;
            if (message !== this._lastStatusError) {
                this._lastStatusError = message;
                this.log(message, 'error');
            }
        }
    },

    loadLogs: async function(replaceExisting) {
        try {
            const res = await fetch('/api/simulator/logs?limit=200');
            if (!res.ok) return;
            const data = await res.json();
            const items = Array.isArray(data.items) ? data.items : [];
            const normalized = this.coalesceLogEntries(items
                .map(entry => this.normalizeLogEntry(entry))
                .filter(Boolean));
            const nextSignature = this.getLogSignature(normalized);

            if (replaceExisting) {
                if (nextSignature === this._lastLogSignature) {
                    return;
                }
                // SIM-14: merge instead of replace — locally-appended
                // entries (lifecycle messages from this page) must survive a
                // backend list refresh.
                window.AppState.logs = this.mergeLogLists(window.AppState.logs, normalized);
                this._lastLogSignature = nextSignature;
            } else {
                window.AppState.logs = this.coalesceLogEntries((window.AppState.logs || []).concat(normalized)).slice(-500);
                this._lastLogSignature = this.getLogSignature(window.AppState.logs);
            }

            this.saveLogsToStorage();

            const hasActiveFilter = (document.getElementById('log-search')?.value || '').trim()
                || ((document.getElementById('log-filter')?.value || 'all') !== 'all');
            if (hasActiveFilter) {
                this.filterLogs();
            } else {
                this.renderLogs(window.AppState.logs || [], true);
                this.updateLogStats();
            }
        } catch (e) {
            console.error('Failed to load simulator logs:', e);
        }
    },

    updateUI: function(data) {
        const badge      = document.getElementById('sim-badge');
        const stateText  = document.getElementById('sim-state-text');
        const detailText = document.getElementById('sim-detail-text');
        const iconWrapper = document.getElementById('sim-icon-wrapper');
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
            TrishulUtils.setStatusBadgeState(badge, 'running', 'RUNNING');
            TrishulUtils.setStatusTextState(stateText, 'online', 'Online', 'mb-0');
            if (iconWrapper) {
                TrishulUtils.setAccentBoxTone(iconWrapper, 'success', 'me-3');
            }
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

            configHint && configHint.classList.toggle('d-none', !data.restart_required);
            configDisabledHint && configDisabledHint.classList.remove('d-none');

            if (metrics && uptimeEl && reqEl && lastActEl) {
                metrics.classList.remove('d-none');
                // uptime_seconds (int) → compact human duration via TrishulUtils
                uptimeEl.textContent  = TrishulUtils.formatUptime(data.uptime_seconds);
                // requests: populated from stats_store.simulator.snmp_requests_served
                reqEl.textContent     = data.requests ?? 0;
                // last_activity: ISO ts from stats_store → relative time via TrishulUtils
                lastActEl.textContent = TrishulUtils.formatRelativeTime(data.last_activity);
                this._startUptimeTicker(data.uptime_seconds);
            }
        } else {
            TrishulUtils.setStatusBadgeState(badge, 'stopped', 'STOPPED');
            TrishulUtils.setStatusTextState(stateText, 'stopped', 'Offline', 'mb-0');
            if (iconWrapper) {
                TrishulUtils.setAccentBoxTone(iconWrapper, 'neutral', 'me-3');
            }
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
            this._stopUptimeTicker();
        }

        // Forward-compatible: status payloads may also carry custom_data_warnings
        // (the 2.1.0 warn-and-skip contract). Only act when the field is present,
        // so status refreshes never clear warnings shown by a start response.
        if (data.custom_data_warnings !== undefined) {
            this.renderCustomDataWarnings(data.custom_data_warnings);
        }
    },

    // ==================== Custom Data Warnings (2.1.0 warn-and-skip) ====================

    renderCustomDataWarnings: function(warnings) {
        const alertEl = document.getElementById('sim-custom-data-warnings');
        const listEl  = document.getElementById('sim-custom-data-warning-list');
        if (!alertEl || !listEl) return;

        const items = (Array.isArray(warnings) ? warnings : [warnings])
            .map(function(item) { return String(item || '').trim(); })
            .filter(Boolean);

        if (items.length === 0) {
            // No (or no more) warnings — clear the alert and the dismissal
            // flag so a future warning can be shown again.
            this._customDataWarningsDismissed = false;
            alertEl.classList.add('d-none');
            listEl.replaceChildren();
            return;
        }

        // Respect an explicit dismissal until the next start response.
        if (this._customDataWarningsDismissed) return;

        listEl.replaceChildren.apply(listEl, items.map(function(text) {
            const li = document.createElement('li');
            li.textContent = text;
            return li;
        }));
        alertEl.classList.remove('d-none');
    },

    dismissCustomDataWarnings: function() {
        this._customDataWarningsDismissed = true;
        const alertEl = document.getElementById('sim-custom-data-warnings');
        if (alertEl) alertEl.classList.add('d-none');
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

    log: function(msg, type = 'info', time) {
        this.appendLogEntry({
            time: time || new Date().toLocaleTimeString(),
            level: type,
            message: String(msg || ''),
        }, true);
    },

    clearLog: function() {
        if (!window.confirm('Clear all simulator log entries? This cannot be undone.')) {
            return;
        }
        fetch('/api/simulator/logs', { method: 'DELETE' })
            .catch((e) => console.error('Failed to clear backend simulator logs:', e))
            .finally(() => {
                window.AppState.logs = [];
                this._lastLogSignature = '';
                this.clearStoredLogs();
                this.renderLogs([]);
                this.updateLogStats();
            });
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

        const clearBtn = document.getElementById('btn-clear-log-search');
        if (clearBtn) {
            if ((searchInput?.value || '').length > 0) {
                clearBtn.classList.remove('d-none');
            } else {
                clearBtn.classList.add('d-none');
            }
        }

        const searchTerm = (searchInput?.value || '').toLowerCase();
        const level      = filterSelect?.value || 'all';

        const filtered = (window.AppState.logs || []).map(entry => this.normalizeLogEntry(entry)).filter(entry => {
            if (!entry) return false;
            const matchesLevel  = level === 'all' || entry.level === level;
            const matchesSearch = !searchTerm || entry.message.toLowerCase().includes(searchTerm);
            return matchesLevel && matchesSearch;
        });

        // SIM-23: single empty-state render. Previously the miss path called
        // renderLogs([]) (which paints the "Waiting for activity" placeholder)
        // and then overwrote it with a different inline style — two distinct
        // empty states flashed in sequence.
        if (filtered.length === 0) {
            area.innerHTML = TrishulUtils.buildPanelPlaceholder({
                icon: 'fa-filter',
                title: 'No matching entries',
                copy: 'No log entries match the current filter.',
                compact: true,
            });
            this._renderedCount = 0;
            this._lastRenderedArray = null;
            this._renderedFirst = null;
        } else {
            this.renderLogs(filtered, true);
        }
        this.updateLogStats(filtered.length);
    },

    clearLogSearch: function() {
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.value = '';
            const clearBtn = document.getElementById('btn-clear-log-search');
            if (clearBtn) clearBtn.classList.add('d-none');
            searchInput.focus();
        }
        this.filterLogs();
    },

    // ==================== Follow / Pause (SIM-26) ====================

    toggleLogFollow: function() {
        this.setLogFollow(!this._logFollow);
    },

    setLogFollow: function(following) {
        this._logFollow = !!following;
        const btn = document.getElementById('btn-log-follow');
        if (btn) {
            btn.setAttribute('aria-pressed', String(this._logFollow));
            btn.classList.toggle('btn-app-primary', this._logFollow);
            btn.classList.toggle('btn-app-secondary', !this._logFollow);
            btn.innerHTML = this._logFollow
                ? '<i class="fas fa-arrow-down me-1"></i> Follow'
                : '<i class="fas fa-pause me-1"></i> Paused';
            btn.title = this._logFollow
                ? 'Auto-scroll to the latest entries'
                : 'Auto-scroll is paused';
        }
        if (this._logFollow) {
            const area = document.getElementById('sim-log-area');
            if (area) area.scrollTop = area.scrollHeight;
        }
    },

    // Stick-to-bottom detection: scrolling away from the bottom pauses the
    // follow, returning to the bottom resumes it.
    attachLogScrollTracking: function() {
        const area = document.getElementById('sim-log-area');
        if (!area) return;
        if (this._logAreaScrollHandler) {
            area.removeEventListener('scroll', this._logAreaScrollHandler);
        }
        const self = this;
        const threshold = 40;
        this._logAreaScrollHandler = function() {
            const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < threshold;
            if (nearBottom && !self._logFollow) {
                self.setLogFollow(true);
            } else if (!nearBottom && self._logFollow) {
                self.setLogFollow(false);
            }
        };
        area.addEventListener('scroll', this._logAreaScrollHandler);
    },

    // ==================== Level-count chips (SIM-26) ====================

    renderLogLevelChips: function() {
        const container = document.getElementById('log-level-chips');
        if (!container) return;

        const logs = window.AppState.logs || [];
        const counts = { info: 0, success: 0, warning: 0, error: 0 };
        logs.forEach(entry => {
            const level = String(entry && entry.level || 'info').toLowerCase();
            if (counts.hasOwnProperty(level)) {
                counts[level]++;
            } else {
                counts.info++;
            }
        });

        const activeLevel = document.getElementById('log-filter')?.value || 'all';
        const levels = [
            { key: 'info',    label: 'Info',    tone: 'info' },
            { key: 'success', label: 'Success', tone: 'success' },
            { key: 'warning', label: 'Warning', tone: 'warning' },
            { key: 'error',   label: 'Error',   tone: 'danger' },
        ];

        const self = this;
        container.replaceChildren.apply(container, levels.map(level => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'badge app-badge app-log-chip is-neutral';
            btn.dataset.level = level.key;
            btn.setAttribute('aria-pressed', String(activeLevel === level.key));
            btn.title = `Filter by ${level.label} level`;
            btn.appendChild(document.createTextNode(level.label + ' '));
            const countSpan = document.createElement('span');
            countSpan.className = 'app-log-chip-count';
            countSpan.textContent = String(counts[level.key]);
            btn.appendChild(countSpan);
            btn.addEventListener('click', function() {
                self.toggleLogLevelFilter(level.key);
            });
            return btn;
        }));
    },

    toggleLogLevelFilter: function(level) {
        const select = document.getElementById('log-filter');
        if (!select) return;
        select.value = select.value === level ? 'all' : level;
        this.filterLogs();
    },

    updateLogStats: function(filteredCount) {
        const stats = document.getElementById('log-stats');
        const total   = window.AppState.logs ? window.AppState.logs.length : 0;
        const current = typeof filteredCount === 'number' ? filteredCount : total;

        if (stats) {
            stats.textContent = `${current} entries${current !== total ? ` (of ${total})` : ''}`;
        }

        this.renderLogLevelChips();
        this.updateLogSummary();
    },

    updateLogSummary: function() {
        const summary = document.getElementById('sim-log-summary');
        if (!summary) return;
        const total = window.AppState.logs ? window.AppState.logs.length : 0;
        summary.textContent = `${total} ${total === 1 ? 'request' : 'requests'} logged`;
    },

    readErrorMessage: async function(response, fallback) {
        try {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const payload = await response.json();
                if (payload && payload.detail) return String(payload.detail);
                if (payload && payload.message) return String(payload.message);
            } else {
                const text = (await response.text()).trim();
                if (text) return text;
            }
        } catch (e) {
            console.error('Failed to read simulator error response:', e);
        }
        return fallback;
    },

    showToast: function(message, type = 'success') {
        TrishulUtils.showNotification(message, type, 4000);
    }
};

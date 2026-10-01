window.WalkerModule = {
    lastData: null,
    lastDisplayMode: null,
    lastRawLines: null,
    lastJsonFormat: 'flat',
    walkHistory: [],
    MAX_HISTORY: 20,
    filteredData: null,
    EMPTY_OUTPUT_HTML: '<span class="fs-2 mb-3 d-block text-center empty-state-icon"><i class="fas fa-walking"></i></span><h3 class="h6 fw-semibold d-block text-center mb-1 empty-state-title lh-base">No results yet</h3><span class="d-block text-center empty-state-copy">Configure a target and run a walk.</span>',

    init: function() { 
        this.toggleOptions();
        this.loadRecentTargets();
        this.loadWalkHistory();
        this.renderHistory();
        
        // Check if OID was passed from browser
        const browserOid = sessionStorage.getItem('walkerOid');
        if (browserOid) {
            document.getElementById("walk-oid").value = browserOid;
            sessionStorage.removeItem('walkerOid');
            TrishulUtils.showNotification(`OID selected: ${browserOid}`, 'info');
        }
        
        // Restore last result if exists
        const lastResult = sessionStorage.getItem('walkerLastResult');
        if (lastResult) {
            const parsed = JSON.parse(lastResult);
            this.lastData = parsed.data;
            this.lastDisplayMode = parsed.mode;
            this.lastRawLines = parsed.rawLines;
            const parseToggle = document.getElementById('walk-parse-toggle');
            if (parseToggle) {
                parseToggle.checked = parsed.mode === 'parsed' || parsed.mode === 'label';
            }
            const useMibsToggle = document.getElementById('walk-use-mibs');
            if (useMibsToggle) {
                useMibsToggle.checked = parsed.use_mibs !== false;
            }
            const jsonLayoutSelect = document.getElementById('walk-json-layout');
            if (jsonLayoutSelect) {
                const jsonLayout = this.normalizeJsonLayout(parsed.json_format || 'flat');
                jsonLayoutSelect.value = jsonLayout;
                this.lastJsonFormat = jsonLayout;
            }
            this.toggleOptions();
            this.restoreLastResult();
        }
    },

    normalizeJsonLayout: function(value) {
        const raw = String(value || '').trim().toLowerCase();
        return raw === 'grouped' || raw === 'metrics' ? 'grouped' : 'flat';
    },

    // ==================== Recent Targets ====================

    loadRecentTargets: function() {
        try {
            const targets = JSON.parse(localStorage.getItem('trishul_walker_targets') || '[]');
            const datalist = document.getElementById('recent-targets');
            if (datalist && targets.length > 0) {
                datalist.replaceChildren(...targets.map(t => {
                    const option = document.createElement('option');
                    option.value = String(t || '');
                    return option;
                }));
            }
        } catch (e) {
            console.error('Failed to load recent targets:', e);
        }
    },

    saveRecentTarget: function(target) {
        try {
            let targets = JSON.parse(localStorage.getItem('trishul_walker_targets') || '[]');
            // Move to front if exists, otherwise add
            targets = targets.filter(t => t !== target);
            targets.unshift(target);
            if (targets.length > 10) targets = targets.slice(0, 10);
            localStorage.setItem('trishul_walker_targets', JSON.stringify(targets));
            this.loadRecentTargets();
        } catch (e) {
            console.error('Failed to save recent target:', e);
        }
    },

    clearTarget: function() {
        document.getElementById('walk-target').value = '';
        document.getElementById('walk-target').focus();
    },

    getOutputClass: function(state) {
        const base = 'm-0 p-3 border-0 font-monospace small overflow-auto app-result-pane app-fill-output walker-results-output';
        if (state === 'empty') return `${base} walk-empty`;
        if (state === 'loading') return `${base} text-muted`;
        if (state === 'error') return `${base} app-status-text is-error`;
        return base;
    },

    setOutputState: function(state, value) {
        this._outputState = state;
        const output = document.getElementById('walk-output');
        if (!output) return;

        output.className = this.getOutputClass(state);

        if (state === 'empty') {
            output.innerHTML = this.EMPTY_OUTPUT_HTML;
            return;
        }

        if (state === 'ready') {
            this.renderData();
            return;
        }

        output.textContent = String(value ?? '');
    },

    // ==================== Result Rendering ====================

    renderData: function() {
        const output = document.getElementById('walk-output');
        if (!output) return;

        output.className = this.getOutputClass('ready');
        output.innerHTML = this.buildResultHtml();
    },

    buildResultHtml: function() {
        const data = Array.isArray(this.filteredData) ? this.filteredData : this.lastData;

        if (Array.isArray(data)) {
            if (data.length === 0) {
                return Array.isArray(this.filteredData)
                    ? '<span class="d-block text-center text-muted py-3">No results match your search.</span>'
                    : '<span class="d-block text-center text-muted py-3">No results to display.</span>';
            }
            if (typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
                return this.buildObjectTable(data);
            }
            return this.buildRawLineTable(data);
        }

        const text = this.lastDisplayMode === 'parsed'
            ? JSON.stringify(data, null, 2)
            : String(data ?? '');
        return `<pre class="m-0">${TrishulUtils.escapeHtml(text)}</pre>`;
    },

    buildRawLineTable: function(lines) {
        const esc = TrishulUtils.escapeHtml;
        const rows = lines.map(line => {
            const text = String(line);
            const sep = text.indexOf(' = ');
            if (sep === -1) return { oid: text, value: '' };
            return { oid: text.slice(0, sep), value: text.slice(sep + 3) };
        });

        return `
            <table class="table table-sm table-hover mb-0 table-dense">
                <caption class="visually-hidden">Walk results</caption>
                <thead class="table-light sticky-top">
                    <tr>
                        <th scope="col">OID</th>
                        <th scope="col">Value</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `<tr><td>${esc(r.oid)}</td><td>${esc(r.value)}</td></tr>`).join('')}
                </tbody>
            </table>`;
    },

    buildObjectTable: function(rows) {
        const esc = TrishulUtils.escapeHtml;
        const first = rows[0];

        let columns;
        if (first && ('oid' in first || 'symbolic' in first)) {
            const hasType = rows.some(r => r.type != null && String(r.type) !== '');
            columns = [
                { label: 'OID', get: r => r.symbolic || r.oid },
                ...(hasType ? [{ label: 'Type', get: r => r.type }] : []),
                { label: 'Value', get: r => r.value },
            ];
        } else if (first && 'metric_name' in first) {
            columns = [
                { label: 'Metric', get: r => r.metric_name },
                { label: 'Value', get: r => r.value },
                { label: 'Module', get: r => r.mib_module },
                { label: 'Category', get: r => r.metric_category },
                { label: 'Agent', get: r => r.agent_host },
                { label: 'Timestamp', get: r => r.timestamp },
                { label: 'Labels', get: r => r.labels },
            ];
        } else {
            columns = Object.keys(first || {}).map(k => ({ label: k, get: r => r[k] }));
        }

        const cell = v => {
            if (v === null || v === undefined) return '';
            return esc(typeof v === 'object' ? JSON.stringify(v) : String(v));
        };

        return `
            <table class="table table-sm table-hover mb-0 table-dense">
                <caption class="visually-hidden">Walk results</caption>
                <thead class="table-light sticky-top">
                    <tr>
                        ${columns.map(c => `<th scope="col">${esc(c.label)}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `<tr>${columns.map(c => `<td>${cell(c.get(r))}</td>`).join('')}</tr>`).join('')}
                </tbody>
            </table>`;
    },

    getOutputText: function(data, mode) {
        if (data == null) return '';
        if (mode === 'parsed') return JSON.stringify(data, null, 2);
        return Array.isArray(data) ? data.join("\n") : String(data);
    },

    // ==================== Walk History ====================

    loadWalkHistory: function() {
        try {
            this.walkHistory = JSON.parse(localStorage.getItem('trishul_walker_history') || '[]');
        } catch (e) {
            this.walkHistory = [];
        }
    },

    saveWalkHistory: function(target, port, oid, result, mode, count, useMibs, jsonFormat) {
        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            target: target,
            port: port,
            oid: oid,
            result: result,
            mode: mode,
            count: count,
            use_mibs: useMibs !== false,
            json_format: this.normalizeJsonLayout(jsonFormat || 'flat')
        };
        
        this.walkHistory.unshift(entry);
        if (this.walkHistory.length > this.MAX_HISTORY) {
            this.walkHistory = this.walkHistory.slice(0, this.MAX_HISTORY);
        }
        
        try {
            localStorage.setItem('trishul_walker_history', JSON.stringify(this.walkHistory));
        } catch (e) {
            console.error('Failed to save walk history:', e);
        }
        
        this.renderHistory();
    },

    renderHistory: function() {
        const listEl = document.getElementById('walk-history-list');
        const emptyEl = document.getElementById('walk-history-empty');
        const countEl = document.getElementById('walk-history-count');
        const esc = TrishulUtils.escapeHtml;
        
        if (!listEl || !emptyEl) return;
        
        countEl.textContent = `${this.walkHistory.length} saved`;
        
        if (this.walkHistory.length === 0) {
            emptyEl.classList.remove('d-none');
            listEl.classList.add('d-none');
            return;
        }
        
        emptyEl.classList.add('d-none');
        listEl.classList.remove('d-none');
        
        listEl.innerHTML = this.walkHistory.map(item => {
            const itemId = Number(item.id) || 0;
            const timeAgo = TrishulUtils.formatRelativeTime(item.timestamp);
            const targetDisplay = `${item.target}:${item.port}`;
            const oidText = String(item.oid || '');
            const oidDisplay = oidText.length > 30 ? oidText.substring(0, 30) + '...' : oidText;
            const resultCount = Number(item.count) || 0;
            const isParsed = item.mode === 'parsed';
            const isLabelFallback = item.mode === 'label';
            const jsonLayout = this.normalizeJsonLayout(item.json_format || 'flat');
            const isGrouped = isParsed && jsonLayout === 'grouped';
            const modeBadgeClass = isLabelFallback
                ? 'app-badge is-warning'
                : (isGrouped ? 'app-badge is-info' : (isParsed ? 'app-badge is-success' : 'app-badge is-neutral'));
            const modeBadgeLabel = isLabelFallback
                ? 'Label View'
                : (isGrouped ? 'Grouped JSON' : (isParsed ? 'Flat JSON' : 'Raw'));
            
            return `
                <a href="#" class="list-group-item list-group-item-action py-2" 
                   onclick="WalkerModule.loadHistoryItem(${itemId}); return false;">
                    <div class="d-flex w-100 justify-content-between align-items-center">
                        <div class="flex-grow-1">
                            <div class="d-flex align-items-center gap-2 mb-1">
                                <span class="badge ${modeBadgeClass}">
                                    ${modeBadgeLabel}
                                </span>
                                <small class="text-muted">${esc(timeAgo)}</small>
                            </div>
                            <h6 class="mb-0 text-truncate app-max-w-300" title="${esc(targetDisplay)}">
                                <i class="fas fa-server text-muted me-1"></i> ${esc(targetDisplay)}
                            </h6>
                            <small class="text-muted text-truncate d-block app-max-w-300" title="${esc(oidText)}">
                                ${esc(oidDisplay)}
                            </small>
                        </div>
                        <div class="text-end ms-2">
                            <span class="badge app-badge is-info">${resultCount} items</span>
                            <!-- BUG FIX: was event.stopPropagation() only.
                                 stopPropagation() stops bubbling but does NOT cancel
                                 the parent <a href="#"> default navigation — the SPA
                                 router sees href="#" and routes to the dashboard.
                                 Must also call event.preventDefault() to cancel the
                                 anchor default before deleteHistoryItem() runs. -->
                            <button type="button" class="btn btn-sm btn-app-danger-outline mt-1" 
                                    onclick="event.stopPropagation(); event.preventDefault(); WalkerModule.deleteHistoryItem(${itemId})"
                                    title="Delete" aria-label="Delete history item">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>
                </a>
            `;
        }).join('');
    },

    loadHistoryItem: function(id) {
        const item = this.walkHistory.find(h => h.id === id);
        if (!item) return;
        
        // Restore form values
        document.getElementById('walk-target').value = item.target;
        document.getElementById('walk-port').value = item.port;
        document.getElementById('walk-oid').value = item.oid;
        document.getElementById('walk-parse-toggle').checked = item.mode === 'parsed' || item.mode === 'label';
        document.getElementById('walk-use-mibs').checked = item.use_mibs !== false;
        const jsonLayoutSelect = document.getElementById('walk-json-layout');
        if (jsonLayoutSelect) {
            jsonLayoutSelect.value = this.normalizeJsonLayout(item.json_format || 'flat');
        }
        this.toggleOptions();
        
        // Restore result
        this.lastData = item.result;
        this.lastDisplayMode = item.mode;
        this.lastJsonFormat = this.normalizeJsonLayout(item.json_format || 'flat');
        this.restoreLastResult();
        
        TrishulUtils.showNotification('Walk loaded from history', 'info');
    },

    deleteHistoryItem: function(id) {
        this.walkHistory = this.walkHistory.filter(h => h.id !== id);
        try {
            localStorage.setItem('trishul_walker_history', JSON.stringify(this.walkHistory));
        } catch (e) {
            console.error('Failed to save walk history:', e);
        }
        this.renderHistory();
    },

    clearHistory: function() {
        TrishulUtils.confirmDialog({
            title: 'Clear all walk history?',
            message: 'This cannot be undone.',
            confirmLabel: 'Clear',
            variant: 'danger',
        }).then((confirmed) => {
            if (!confirmed) return;
            
            this.walkHistory = [];
            try {
                localStorage.removeItem('trishul_walker_history');
            } catch (e) {
                console.error('Failed to clear walk history:', e);
            }
            this.renderHistory();
        });
    },

    // ==================== UI Functions ====================

    browseOid: function() {
        const currentOid = document.getElementById("walk-oid").value.trim();
        if (currentOid) {
            sessionStorage.setItem('browserSearchOid', currentOid);
        }
        window.location.hash = '#browser';
    },

    toggleOptions: function() {
        const parseEl = document.getElementById("walk-parse-toggle");
        const mibEl = document.getElementById("walk-use-mibs");
        const jsonLayoutEl = document.getElementById("walk-json-layout");
        const parseEnabled = Boolean(parseEl && parseEl.checked);
        const jsonLayout = this.normalizeJsonLayout(jsonLayoutEl && jsonLayoutEl.value ? jsonLayoutEl.value : 'flat');

        if (jsonLayoutEl) {
            jsonLayoutEl.disabled = !parseEnabled;
        }
        if (mibEl) {
            if (parseEnabled && jsonLayout === 'grouped') {
                mibEl.checked = true;
                mibEl.disabled = true;
            } else {
                mibEl.disabled = false;
            }
        }
    },

    // ==================== Walk Execution ====================

    execute: async function() {
        const btn = document.getElementById("btn-walk-run");
        const countBadge = document.getElementById("walk-count");
        const progressEl = document.getElementById("walk-progress");
        const progressBar = document.getElementById("walk-progress-bar");
        const progressText = document.getElementById("walk-progress-text");
        const progressCount = document.getElementById("walk-progress-count");
        const errorEl = document.getElementById("walk-error");
        const errorText = document.getElementById("walk-error-text");
        
        // Hide previous error
        errorEl.classList.add('d-none');
        
        // Get Inputs
        const target = document.getElementById("walk-target").value.trim();
        const port = parseInt(document.getElementById("walk-port").value) || 161;
        const community = document.getElementById("walk-comm").value.trim() || "public";
        const oid = document.getElementById("walk-oid").value.trim();
        const parse = document.getElementById("walk-parse-toggle").checked;
        const use_mibs = document.getElementById("walk-use-mibs").checked;
        const jsonLayoutEl = document.getElementById("walk-json-layout");
        const json_format = parse
            ? this.normalizeJsonLayout(jsonLayoutEl && jsonLayoutEl.value ? jsonLayoutEl.value : 'flat')
            : 'flat';

        // Validate OID
        if (!oid) {
            errorText.textContent = "Please enter an OID or MIB name";
            errorEl.classList.remove('d-none');
            return;
        }

        // Basic OID/MIB format validation
        const oidPattern = /^([0-9]+(\.[0-9]+)*|([A-Z][a-zA-Z0-9-]*)(::[a-zA-Z0-9-]+)*(\.[0-9]+)*)$/;
        if (!oidPattern.test(oid)) {
            errorText.textContent = "Invalid OID format. Use format like: 1.3.6.1 or IF-MIB::ifTable";
            errorEl.classList.remove('d-none');
            return;
        }

        // Save recent target
        this.saveRecentTarget(target);

        // UI Loading State
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Running...';
        btn.disabled = true;
        this.setOutputState('loading', '');
        
        // Show progress
        progressEl.classList.remove('d-none');
        progressBar.style.width = '50%';
        progressBar.setAttribute('aria-valuenow', '50');
        progressText.textContent = `Walking ${oid}...`;
        progressCount.textContent = "0 items";

        try {
            const res = await fetch('/api/walk/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target, port, community, oid, parse, use_mibs, json_format })
            });

            const data = await res.json();
            console.log("Walker API Response:", data);

            if (!res.ok) {
                throw new Error(data.detail || "Walk failed");
            }

            this.lastData = data.data;
            this.lastDisplayMode = data.mode;
            this.lastRawLines = data.rawLines || null;
            this.lastJsonFormat = this.normalizeJsonLayout(data.json_format || json_format);
            this.filteredData = null;
            
            countBadge.textContent = `${data.count} items`;
            progressCount.textContent = `${data.count} items`;
            progressBar.style.width = '100%';
            progressBar.setAttribute('aria-valuenow', '100');
            
            sessionStorage.setItem('walkerLastResult', JSON.stringify({
                data: data.data,
                mode: data.mode,
                rawLines: data.rawLines,
                use_mibs: use_mibs,
                json_format: this.normalizeJsonLayout(data.json_format || json_format)
            }));
            
            if (data.mode === 'parsed') {
                this.setOutputState('ready', JSON.stringify(data.data, null, 2));
            } else {
                if (Array.isArray(data.data)) {
                    this.setOutputState('ready', data.data.join("\n"));
                } else {
                    this.setOutputState('ready', String(data.data));
                }
            }

            this.saveWalkHistory(
                target,
                port,
                oid,
                data.data,
                data.mode,
                data.count,
                use_mibs,
                this.normalizeJsonLayout(data.json_format || json_format),
            );
            TrishulUtils.showNotification(`Walk completed: ${data.count} items`, 'success');

        } catch (e) {
            console.error("Walker Error:", e);
            errorText.textContent = this.formatErrorMessage(e.message);
            errorEl.classList.remove('d-none');
            this.setOutputState('error', `Error: ${e.message}`);
            countBadge.textContent = "0 items";
            this.lastData = null;
            this.lastDisplayMode = null;
            this.lastRawLines = null;
            this.lastJsonFormat = 'flat';
            TrishulUtils.showNotification(e.message, 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
            setTimeout(() => {
                progressEl.classList.add('d-none');
                progressBar.style.width = '0%';
                progressBar.setAttribute('aria-valuenow', '0');
            }, 500);
        }
    },

    formatErrorMessage: function(msg) {
        if (msg.includes("timeout") || msg.includes("timed out")) {
            return "Connection timed out. Check if target is reachable and SNMP is enabled.";
        }
        if (msg.includes("Failed to receive UDP datagram")) {
            return "Connection failed. No SNMP response was received; check that the target host and UDP port are listening and reachable.";
        }
        if (msg.includes("unreachable") || msg.includes("No route")) {
            return "Target is unreachable. Check network connectivity.";
        }
        if (msg.includes("authentication") || msg.includes("community")) {
            return "Authentication failed. Check community string.";
        }
        if (msg.includes("not found") || msg.includes("NoSuch")) {
            return "OID not found on target device.";
        }
        return msg;
    },

    // ==================== Result Display, Filtering & Clear ====================

    clearResults: function() {
        const countBadge = document.getElementById("walk-count");
        const searchInput = document.getElementById("walk-result-search");

        this.lastData = null;
        this.lastDisplayMode = null;
        this.lastRawLines = null;
        this.lastJsonFormat = 'flat';
        this.filteredData = null;

        sessionStorage.removeItem('walkerLastResult');

        this.setOutputState('empty');
        if (countBadge) countBadge.textContent = "0 items";
        if (searchInput) {
            searchInput.value = '';
            const clearBtn = document.getElementById("btn-clear-result-search");
            if (clearBtn) clearBtn.classList.add('d-none');
        }
    },

    filterResults: function() {
        const searchInput = document.getElementById("walk-result-search");
        const output = document.getElementById("walk-output");
        const searchTerm = searchInput.value.toLowerCase().trim();

        const clearBtn = document.getElementById("btn-clear-result-search");
        if (clearBtn) {
            if (searchInput.value.length > 0) {
                clearBtn.classList.remove('d-none');
            } else {
                clearBtn.classList.add('d-none');
            }
        }

        if (!this.lastData) return;

        if (!searchTerm) {
            this.filteredData = null;
            this.renderData();
            return;
        }

        if (Array.isArray(this.lastData)) {
            this.filteredData = this.lastData.filter(item => {
                // Raw walk lines are plain strings — match against the raw line
                // so searches containing quotes/backslashes work correctly.
                // Parsed/object rows still match against their JSON serialization.
                if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                    return JSON.stringify(item).toLowerCase().includes(searchTerm);
                }
                return String(item).toLowerCase().includes(searchTerm);
            });
            this.renderData();
        } else {
            const text = JSON.stringify(this.lastData).toLowerCase();
            if (text.includes(searchTerm)) {
                this.filteredData = null;
                this.renderData();
            } else {
                this.filteredData = null;
                output.className = this.getOutputClass('ready');
                output.textContent = "No results match your search.";
            }
        }
    },

    clearResultSearch: function() {
        const searchInput = document.getElementById("walk-result-search");
        if (searchInput) {
            searchInput.value = '';
            const clearBtn = document.getElementById("btn-clear-result-search");
            if (clearBtn) clearBtn.classList.add('d-none');
            searchInput.focus();
        }
        this.filterResults();
    },

    restoreLastResult: function() {
        const countBadge = document.getElementById("walk-count");
        
        if (!this.lastData) return;
        
        let count = 0;
        if (Array.isArray(this.lastData)) {
            count = this.lastData.length;
        } else if (typeof this.lastData === 'object') {
            count = Object.keys(this.lastData).length;
        }
        
        countBadge.textContent = `${count} items`;
        if (this.lastDisplayMode === 'parsed') {
            this.setOutputState('ready', JSON.stringify(this.lastData, null, 2));
        } else if (Array.isArray(this.lastData)) {
            this.setOutputState('ready', this.lastData.join("\n"));
        } else {
            this.setOutputState('ready', String(this.lastData));
        }
    },

    // ==================== Export & Copy ====================

    copyToClipboard: function() {
        const output = document.getElementById("walk-output");
        // Bail while a walk is in flight: the pane is in the loading state and
        // lastData still holds the previous (stale) walk.
        if (!output || output.classList.contains('walk-empty') || this._outputState === 'loading') {
            TrishulUtils.showNotification("No data to copy", "warning");
            return;
        }

        const data = Array.isArray(this.filteredData) ? this.filteredData : this.lastData;
        const text = this.getOutputText(data, this.lastDisplayMode);
        if (!text) {
            TrishulUtils.showNotification("No data to copy", "warning");
            return;
        }

        navigator.clipboard.writeText(text).then(() => {
            TrishulUtils.showNotification("Copied", "success");
        }).catch(() => {
            TrishulUtils.showNotification("Failed to copy", "error");
        });
    },
    
    download: function(format) {
        if (!this.lastData) {
            TrishulUtils.showNotification("No data to export", "warning");
            return;
        }

        const exportData = Array.isArray(this.filteredData) && this.filteredData.length > 0
            ? this.filteredData
            : this.lastData;
        let content = "";
        let mime = "text/plain";
        let ext = "txt";

        if (format === 'json') {
            content = JSON.stringify(exportData, null, 2);
            mime = "application/json";
            ext = "json";
        } else if (format === 'csv') {
            if (
                Array.isArray(exportData)
                && exportData.length > 0
                && typeof exportData[0] === 'object'
                && exportData[0] !== null
                && !Array.isArray(exportData[0])
            ) {
                const allKeys = new Set();
                exportData.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
                const keys = Array.from(allKeys);
                if (keys.length === 0) {
                    TrishulUtils.showNotification("CSV export is unavailable because the current walk result has no tabular fields.", "error");
                    return;
                }

                content = keys.join(",") + "\n";
                content += exportData.map(row => {
                    return keys.map(k => {
                        let val = row[k] === undefined ? "" : row[k];
                        if (typeof val === 'object') val = JSON.stringify(val).replace(/"/g, '""');
                        else val = String(val).replace(/"/g, '""');
                        return `"${val}"`;
                    }).join(",");
                }).join("\n");
            } else {
                TrishulUtils.showNotification("CSV export is only available for parsed JSON walk results.", "error");
                return;
            }
            mime = "text/csv";
            ext = "csv";
        } else {
            content = Array.isArray(exportData) ? exportData.join("\n") : String(exportData);
        }

        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `snmp_walk_${Date.now()}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
    },

    destroy: function() {
        // nothing special yet
    }
};

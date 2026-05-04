window.WalkerModule = {
    lastData: null,
    lastDisplayMode: null,
    lastRawLines: null,
    walkHistory: [],
    MAX_HISTORY: 20,
    filteredData: null,

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
            TrishulUtils.showNotification(`OID loaded from browser: ${browserOid}`, 'info');
        }
        
        // Restore last result if exists
        const lastResult = sessionStorage.getItem('walkerLastResult');
        if (lastResult) {
            const parsed = JSON.parse(lastResult);
            this.lastData = parsed.data;
            this.lastDisplayMode = parsed.mode;
            this.lastRawLines = parsed.rawLines;
            this.restoreLastResult();
        }
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

    // ==================== Walk History ====================

    loadWalkHistory: function() {
        try {
            this.walkHistory = JSON.parse(localStorage.getItem('trishul_walker_history') || '[]');
        } catch (e) {
            this.walkHistory = [];
        }
    },

    saveWalkHistory: function(target, port, oid, result, mode, count) {
        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            target: target,
            port: port,
            oid: oid,
            result: result,
            mode: mode,
            count: count
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
            
            return `
                <a href="#" class="list-group-item list-group-item-action py-2" 
                   onclick="WalkerModule.loadHistoryItem(${itemId}); return false;">
                    <div class="d-flex w-100 justify-content-between align-items-center">
                        <div class="flex-grow-1">
                            <div class="d-flex align-items-center gap-2 mb-1">
                                <span class="badge bg-${item.mode === 'parsed' ? 'success' : 'secondary'}">
                                    ${item.mode === 'parsed' ? 'JSON' : 'Raw'}
                                </span>
                                <small class="text-muted">${esc(timeAgo)}</small>
                            </div>
                            <h6 class="mb-0 text-truncate" style="max-width: 300px;" title="${esc(targetDisplay)}">
                                <i class="fas fa-server text-muted me-1"></i> ${esc(targetDisplay)}
                            </h6>
                            <small class="text-muted text-truncate d-block" style="max-width: 300px;" title="${esc(oidText)}">
                                ${esc(oidDisplay)}
                            </small>
                        </div>
                        <div class="text-end ms-2">
                            <span class="badge bg-info">${resultCount} items</span>
                            <!-- BUG FIX: was event.stopPropagation() only.
                                 stopPropagation() stops bubbling but does NOT cancel
                                 the parent <a href="#"> default navigation — the SPA
                                 router sees href="#" and routes to the dashboard.
                                 Must also call event.preventDefault() to cancel the
                                 anchor default before deleteHistoryItem() runs. -->
                            <button type="button" class="btn btn-sm btn-outline-danger mt-1" 
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
        document.getElementById('walk-parse-toggle').checked = item.mode === 'parsed';
        this.toggleOptions();
        
        // Restore result
        this.lastData = item.result;
        this.lastDisplayMode = item.mode;
        this.restoreLastResult();
        
        TrishulUtils.showNotification('Walk history loaded', 'info');
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
        if (!confirm('Clear all walk history? This cannot be undone.')) return;
        
        this.walkHistory = [];
        try {
            localStorage.removeItem('trishul_walker_history');
        } catch (e) {
            console.error('Failed to clear walk history:', e);
        }
        this.renderHistory();
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
        
        if (parseEl.checked) {
            mibEl.checked = true;
            mibEl.disabled = true;
        } else {
            mibEl.disabled = false;
        }
    },

    // ==================== Walk Execution ====================

    execute: async function() {
        const btn = document.getElementById("btn-walk-run");
        const output = document.getElementById("walk-output");
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
        output.textContent = "";
        output.className = "m-0 p-3 border-0 bg-light text-muted font-monospace small";
        
        // Show progress
        progressEl.classList.remove('d-none');
        progressBar.style.width = '50%';
        progressText.textContent = `Walking ${oid}...`;
        progressCount.textContent = "0 items";

        try {
            const res = await fetch('/api/walk/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target, port, community, oid, parse, use_mibs })
            });

            const data = await res.json();
            console.log("Walker API Response:", data);

            if (!res.ok) {
                throw new Error(data.detail || "Walk failed");
            }

            this.lastData = data.data;
            this.lastDisplayMode = data.mode;
            this.lastRawLines = data.rawLines || null;
            this.filteredData = null;
            
            countBadge.textContent = `${data.count} items`;
            progressCount.textContent = `${data.count} items`;
            progressBar.style.width = '100%';
            
            sessionStorage.setItem('walkerLastResult', JSON.stringify({
                data: data.data,
                mode: data.mode,
                rawLines: data.rawLines
            }));
            
            output.className = "m-0 p-3 border-0 bg-white text-dark font-monospace small";

            if (data.mode === 'parsed') {
                output.textContent = JSON.stringify(data.data, null, 2);
            } else {
                if (Array.isArray(data.data)) {
                    output.textContent = data.data.join("\n");
                } else {
                    output.textContent = String(data.data);
                }
            }

            this.saveWalkHistory(target, port, oid, data.data, data.mode, data.count);
            TrishulUtils.showNotification(`Walk complete: ${data.count} items found`, 'success');

        } catch (e) {
            console.error("Walker Error:", e);
            errorText.textContent = this.formatErrorMessage(e.message);
            errorEl.classList.remove('d-none');
            output.textContent = `Error: ${e.message}`;
            output.className = "m-0 p-3 border-0 bg-light text-danger fw-bold font-monospace small";
            countBadge.textContent = "0 items";
            this.lastData = null;
            this.lastDisplayMode = null;
            this.lastRawLines = null;
            TrishulUtils.showNotification(e.message, 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
            setTimeout(() => {
                progressEl.classList.add('d-none');
                progressBar.style.width = '0%';
            }, 500);
        }
    },

    formatErrorMessage: function(msg) {
        if (msg.includes("timeout") || msg.includes("timed out")) {
            return "Connection timed out. Check if target is reachable and SNMP is enabled.";
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
        const output = document.getElementById("walk-output");
        const countBadge = document.getElementById("walk-count");
        const searchInput = document.getElementById("walk-result-search");

        this.lastData = null;
        this.lastDisplayMode = null;
        this.lastRawLines = null;
        this.filteredData = null;

        sessionStorage.removeItem('walkerLastResult');

        if (output) {
            output.textContent = "No data yet. Run a walk to see results.";
            output.className = "m-0 p-3 border-0 bg-light text-muted font-monospace small";
        }
        if (countBadge) countBadge.textContent = "0 items";
        if (searchInput) searchInput.value = '';
    },

    filterResults: function() {
        const searchInput = document.getElementById("walk-result-search");
        const output = document.getElementById("walk-output");
        const searchTerm = searchInput.value.toLowerCase().trim();
        
        if (!this.lastData) return;
        
        if (!searchTerm) {
            this.filteredData = null;
            if (this.lastDisplayMode === 'parsed') {
                output.textContent = JSON.stringify(this.lastData, null, 2);
            } else {
                output.textContent = Array.isArray(this.lastData) ? this.lastData.join("\n") : String(this.lastData);
            }
            return;
        }
        
        if (this.lastDisplayMode === 'parsed' && Array.isArray(this.lastData)) {
            this.filteredData = this.lastData.filter(item => 
                JSON.stringify(item).toLowerCase().includes(searchTerm)
            );
            output.textContent = JSON.stringify(this.filteredData, null, 2);
        } else if (Array.isArray(this.lastData)) {
            this.filteredData = this.lastData.filter(line => 
                line.toLowerCase().includes(searchTerm)
            );
            output.textContent = this.filteredData.join("\n");
        } else {
            const text = JSON.stringify(this.lastData).toLowerCase();
            if (text.includes(searchTerm)) {
                output.textContent = this.lastDisplayMode === 'parsed' ? 
                    JSON.stringify(this.lastData, null, 2) : String(this.lastData);
            } else {
                output.textContent = "No results match your search.";
            }
        }
    },

    restoreLastResult: function() {
        const output = document.getElementById("walk-output");
        const countBadge = document.getElementById("walk-count");
        
        if (!this.lastData) return;
        
        let count = 0;
        if (Array.isArray(this.lastData)) {
            count = this.lastData.length;
        } else if (typeof this.lastData === 'object') {
            count = Object.keys(this.lastData).length;
        }
        
        countBadge.textContent = `${count} items`;
        output.className = "m-0 p-3 border-0 bg-white text-dark font-monospace small";
        
        if (this.lastDisplayMode === 'parsed') {
            output.textContent = JSON.stringify(this.lastData, null, 2);
        } else {
            if (Array.isArray(this.lastData)) {
                output.textContent = this.lastData.join("\n");
            } else {
                output.textContent = String(this.lastData);
            }
        }
    },

    // ==================== Export & Copy ====================

    copyToClipboard: function() {
        const text = document.getElementById("walk-output").textContent;
        if (text === "No data yet. Run a walk to see results." || text.startsWith("Error:")) {
            TrishulUtils.showNotification("No data to copy", "warning");
            return;
        }
        
        navigator.clipboard.writeText(text).then(() => {
            TrishulUtils.showNotification("Copied to clipboard", "success");
        }).catch(() => {
            TrishulUtils.showNotification("Failed to copy", "error");
        });
    },
    
    download: function(format) {
        if (!this.lastData) {
            TrishulUtils.showNotification("No data to export", "warning");
            return;
        }
        
        let content = "";
        let mime = "text/plain";
        let ext = "txt";

        if (format === 'json') {
            content = JSON.stringify(this.lastData, null, 2);
            mime = "application/json";
            ext = "json";
        } else if (format === 'csv') {
            if (Array.isArray(this.lastData) && this.lastData.length > 0 && typeof this.lastData[0] === 'object') {
                const allKeys = new Set();
                this.lastData.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
                const keys = Array.from(allKeys);

                content = keys.join(",") + "\n";
                content += this.lastData.map(row => {
                    return keys.map(k => {
                        let val = row[k] === undefined ? "" : row[k];
                        if (typeof val === 'object') val = JSON.stringify(val).replace(/"/g, '""');
                        else val = String(val).replace(/"/g, '""');
                        return `"${val}"`;
                    }).join(",");
                }).join("\n");
            } else {
                content = "No CSV compatible data\n";
            }
            mime = "text/csv";
            ext = "csv";
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

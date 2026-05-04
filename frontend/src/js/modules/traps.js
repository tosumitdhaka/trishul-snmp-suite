window.TrapsModule = {
    _listeners: [],
    vbCount: 0,
    allTraps: [],
    allObjects: [],
    receivedTraps: [],
    filteredTraps: [],
    _modalJson: {},          // keyed by modal id — avoids JSON-in-onclick-attr breakage
    _receiverUptime: null,   // uptime_seconds cached from last updateStatusUI call

    init: function() {
        this.loadPersistedTraps();

        // Replace 3s setInterval with WS event listeners
        this._registerListeners();

        // REST seed on first paint
        this.checkStatus();
        this.loadTraps();
        
        this.loadTrapList();
        
        // Check if trap data was passed from browser
        const browserTrapData = sessionStorage.getItem('selectedTrap');
        const browserTrapOid  = sessionStorage.getItem('trapOid');
        
        if (browserTrapData) {
            try {
                const trap = JSON.parse(browserTrapData);
                sessionStorage.removeItem('selectedTrap');
                
                document.getElementById('ts-oid').value = trap.full_name || trap.oid;
                document.getElementById('vb-container').innerHTML = 
                    '<div class="text-center text-muted small py-2 d-none" id="vb-empty"></div>';
                
                this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "12345");
                
                if (trap.objects && trap.objects.length > 0) {
                    trap.objects.forEach(obj => {
                        const type = this.guessVarBindType(obj.name);
                        this.addVarbind(obj.full_name, type, "");
                    });
                }
                
                this.showNotification(`Trap loaded from browser: ${trap.name}`, 'success');
            } catch (e) {
                console.error('Failed to load trap from browser:', e);
            }
        } else if (browserTrapOid) {
            document.getElementById('ts-oid').value = browserTrapOid;
            sessionStorage.removeItem('trapOid');
            this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "12345");
            this.showNotification(`Trap OID loaded from browser: ${browserTrapOid}`, 'info');
        } else {
            this.loadSelectedTrap();
        }
    },

    destroy: function() {
        this._listeners.forEach(function(pair) {
            window.removeEventListener(pair[0], pair[1]);
        });
        this._listeners = [];
        this.persistTraps();
    },

    _on: function(type, fn) {
        window.addEventListener(type, fn);
        this._listeners.push([type, fn]);
    },

    _registerListeners: function() {
        var self = this;

        // Receiver status from full state on WS (re)connect
        this._on('trishul:ws:full_state', function(e) {
            if (e.detail && e.detail.traps) {
                self.updateStatusUI(e.detail.traps);
            }
        });

        // Receiver start / stop lifecycle push
        this._on('trishul:ws:status', function(e) {
            if (e.detail && e.detail.traps) {
                self.updateStatusUI(e.detail.traps);
            }
        });

        // Live trap push from worker subprocess via UDP loopback -> WS broadcast
        this._on('trishul:ws:trap', function(e) {
            if (e.detail && e.detail.trap) {
                self._prependTrap(e.detail.trap);
            }
        });

        // REST re-seed after WS reconnect
        this._on('trishul:ws:open', function() {
            self.checkStatus();
            self.loadTraps();
        });
    },

    // Prepend a single live trap without doing a full REST reload.
    _prependTrap: function(trap) {
        // Deduplicate by timestamp
        if (this.receivedTraps.find(function(t) { return t.timestamp === trap.timestamp; })) return;
        this.receivedTraps.unshift(trap);
        if (this.receivedTraps.length > 100) this.receivedTraps.pop();
        this.persistTraps();
        this.renderTraps();
        this.updateMetrics();
    },

    // ==================== Persistence ====================

    loadPersistedTraps: function() {
        try {
            const stored = localStorage.getItem('trishul_received_traps');
            if (stored) {
                this.receivedTraps = JSON.parse(stored);
                this.renderTraps();
            }
        } catch (e) {
            console.error('Failed to load persisted traps:', e);
        }
    },

    persistTraps: function() {
        try {
            const toStore = this.receivedTraps.slice(0, 100);
            localStorage.setItem('trishul_received_traps', JSON.stringify(toStore));
        } catch (e) {
            console.error('Failed to persist traps:', e);
        }
    },

    // ==================== Trap Sender Validation ====================

    showSenderError: function(message) {
        const errorEl   = document.getElementById('ts-error');
        const errorText = document.getElementById('ts-error-text');
        if (errorEl && errorText) {
            errorText.textContent = message;
            errorEl.classList.remove('d-none');
        }
    },

    hideSenderError: function() {
        const errorEl = document.getElementById('ts-error');
        if (errorEl) {
            errorEl.classList.add('d-none');
        }
    },

    browseTraps: function() {
        const currentOid = document.getElementById("ts-oid").value.trim();
        if (currentOid) {
            sessionStorage.setItem('browserSearchOid', currentOid);
        }
        sessionStorage.setItem('browserFilterType', 'NotificationType');
        window.location.hash = '#browser';
    },

    // ==================== Trap List Management ====================

    loadTrapList: async function() {
        try {
            const res  = await fetch('/api/mibs/traps');
            const data = await res.json();
            
            this.allTraps = data.traps;
            
            const select = document.getElementById('ts-trap-select');
            if (!select) return;
            
            select.innerHTML = '<option value="">-- Select a trap --</option>';
            
            data.traps.forEach(trap => {
                const option       = document.createElement('option');
                option.value       = trap.full_name;
                option.textContent = `${trap.full_name} (${trap.objects.length} objects)`;
                option.dataset.trap = JSON.stringify(trap);
                select.appendChild(option);
            });
        } catch (e) {
            console.error('Failed to load trap list:', e);
        }
    },

    onTrapSelected: function() {
        const select         = document.getElementById('ts-trap-select');
        const selectedOption = select.options[select.selectedIndex];
        
        if (!selectedOption.value) return;
        
        try {
            const trap = JSON.parse(selectedOption.dataset.trap);
            this.populateTrapForm(trap);
        } catch (e) {
            console.error('Failed to parse trap data:', e);
        }
    },

    populateTrapForm: function(trap) {
        document.getElementById('ts-oid').value = trap.full_name;
        
        document.getElementById('vb-container').innerHTML = 
            '<div class="text-center text-muted small py-2 d-none" id="vb-empty"></div>';
        
        this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "12345");
        
        if (trap.objects && trap.objects.length > 0) {
            trap.objects.forEach(obj => {
                let type = this.guessVarBindType(obj.name);
                this.addVarbind(obj.full_name, type, "");
            });
        }
        
        this.showNotification(`Loaded trap: ${trap.name}`, 'success');
    },

    guessVarBindType: function(name) {
        const lowerName = name.toLowerCase();
        
        if (lowerName.includes('index') || lowerName.includes('count') || lowerName.includes('number')) {
            return "Integer";
        } else if (lowerName.includes('status') || lowerName.includes('state') || lowerName.includes('admin')) {
            return "Integer";
        } else if (lowerName.includes('addr') || lowerName.includes('address')) {
            return "IpAddress";
        } else if (lowerName.includes('time') || lowerName.includes('tick')) {
            return "TimeTicks";
        } else if (lowerName.includes('counter')) {
            return "Counter";
        } else if (lowerName.includes('gauge') || lowerName.includes('speed') || lowerName.includes('bandwidth')) {
            return "Gauge";
        } else if (lowerName.includes('oid') || lowerName.includes('object')) {
            return "OID";
        }
        
        return "String";
    },

    // ==================== VarBind Picker ====================

    showVarBindPicker: async function() {
        if (this.allObjects.length === 0) {
            try {
                const res  = await fetch('/api/mibs/objects');
                const data = await res.json();
                this.allObjects = data.objects;
            } catch (e) {
                this.showSenderError('Failed to load MIB objects');
                return;
            }
        }
        
        const modalHtml = `
            <div class="modal fade" id="varbindPickerModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Select VarBind from MIB</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <input type="text" id="vb-search" class="form-control mb-3" placeholder="Search objects...">
                            <div style="max-height: 400px; overflow-y: auto;">
                                <table class="table table-sm table-hover">
                                    <thead class="table-light sticky-top">
                                        <tr>
                                            <th>Object Name</th>
                                            <th>Module</th>
                                            <th>Type</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody id="vb-picker-body"></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        const existingModal = document.getElementById('varbindPickerModal');
        if (existingModal) existingModal.remove();
        
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        this.renderVarBindPicker(this.allObjects);
        
        document.getElementById('vb-search').addEventListener('input', (e) => {
            const query    = e.target.value.toLowerCase();
            const filtered = this.allObjects.filter(obj => 
                obj.name.toLowerCase().includes(query) || 
                obj.module.toLowerCase().includes(query)
            );
            this.renderVarBindPicker(filtered);
        });
        
        const modal = new bootstrap.Modal(document.getElementById('varbindPickerModal'));
        modal.show();
    },

    renderVarBindPicker: function(objects) {
        const tbody = document.getElementById('vb-picker-body');
        const esc = TrishulUtils.escapeHtml;
        
        if (objects.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No objects found</td></tr>';
            return;
        }
        
        tbody.innerHTML = objects.slice(0, 100).map(obj => `
            <tr>
                <td><code class="small">${esc(obj.name)}</code></td>
                <td><span class="badge bg-secondary small">${esc(obj.module)}</span></td>
                <td><span class="small">${esc(obj.syntax)}</span></td>
                <td>
                    <button type="button" class="btn btn-xs btn-primary"
                            onclick="TrapsModule.addVarbindFromPickerElement(this)"
                            data-full-name="${esc(obj.full_name)}"
                            data-syntax="${esc(obj.syntax)}">
                        <i class="fas fa-plus"></i>
                    </button>
                </td>
            </tr>
        `).join('');
        
        if (objects.length > 100) {
            tbody.innerHTML += `<tr><td colspan="4" class="text-center text-muted small">Showing first 100 results. Use search to narrow down.</td></tr>`;
        }
    },

    addVarbindFromPickerElement: function(button) {
        this.addVarbindFromPicker(button?.dataset?.fullName || '', button?.dataset?.syntax || '');
    },

    addVarbindFromPicker: function(fullName, syntax) {
        const type = this.syntaxToType(syntax);
        this.addVarbind(fullName, type, "");
        
        const modal = bootstrap.Modal.getInstance(document.getElementById('varbindPickerModal'));
        if (modal) modal.hide();
    },

    syntaxToType: function(syntax) {
        if (syntax.includes('Integer'))           return 'Integer';
        if (syntax.includes('Counter64'))         return 'Counter';
        if (syntax.includes('Counter'))           return 'Counter';
        if (syntax.includes('Gauge'))             return 'Gauge';
        if (syntax.includes('TimeTicks'))         return 'TimeTicks';
        if (syntax.includes('IpAddress'))         return 'IpAddress';
        if (syntax.includes('ObjectIdentifier'))  return 'OID';
        return 'String';
    },

    // ==================== Trap Form Management ====================

    loadSelectedTrap: function() {
        const trapData = sessionStorage.getItem('selectedTrap');
        if (!trapData) {
            this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "0");
            return;
        }

        try {
            const trap = JSON.parse(trapData);
            sessionStorage.removeItem('selectedTrap');
            
            const select = document.getElementById('ts-trap-select');
            if (select) {
                select.value = trap.full_name;
            }
            
            this.populateTrapForm(trap);
            
        } catch (e) {
            console.error('Failed to load selected trap:', e);
        }
    },

    addVarbind: function(oid="", type="String", val="") {
        const container = document.getElementById("vb-container");
        const emptyMsg  = document.getElementById("vb-empty");
        const esc = TrishulUtils.escapeHtml;
        if (emptyMsg) emptyMsg.classList.add('d-none');
        
        const id   = `vb-row-${this.vbCount++}`;
        const html = `
            <div class="card mb-2 border-secondary" id="${id}">
                <div class="card-body p-2">
                    <div class="input-group input-group-sm mb-1">
                        <span class="input-group-text bg-light">OID</span>
                        <input type="text" class="form-control vb-oid" value="${esc(oid)}" placeholder="1.3.6... or IF-MIB::ifIndex">
                        <button class="btn btn-outline-danger" type="button" onclick="document.getElementById('${id}').remove()">X</button>
                    </div>
                    <div class="input-group input-group-sm">
                        <select class="form-select vb-type" style="max-width: 120px;">
                            <option value="String"     ${type==='String'    ?'selected':''}>String</option>
                            <option value="Integer"    ${type==='Integer'   ?'selected':''}>Integer</option>
                            <option value="OID"        ${type==='OID'       ?'selected':''}>OID</option>
                            <option value="TimeTicks"  ${type==='TimeTicks' ?'selected':''}>TimeTicks</option>
                            <option value="IpAddress"  ${type==='IpAddress' ?'selected':''}>IpAddress</option>
                            <option value="Counter"    ${type==='Counter'   ?'selected':''}>Counter</option>
                            <option value="Gauge"      ${type==='Gauge'     ?'selected':''}>Gauge</option>
                        </select>
                        <input type="text" class="form-control vb-val" value="${esc(val)}" placeholder="Value">
                    </div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    },

    resetForm: function() {
        document.getElementById("vb-container").innerHTML =
            '<div class="text-center text-muted small py-2 d-none" id="vb-empty">No VarBinds added</div>';
        document.getElementById("ts-oid").value = "IF-MIB::linkDown";
        
        const select = document.getElementById("ts-trap-select");
        if (select) select.value = "";
        
        this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "0");
        this.hideSenderError();
    },

    // ==================== Trap Sending ====================

    sendTrap: async function(e) {
        e.preventDefault();
        this.hideSenderError();
        
        const trapOid = document.getElementById("ts-oid").value.trim();
        if (!trapOid) {
            this.showSenderError('Please enter a Trap OID or select a trap from the dropdown');
            return;
        }
        
        const varbindRows = document.querySelectorAll("#vb-container .card");
        if (varbindRows.length === 0) {
            this.showSenderError('Please add at least one VarBind');
            return;
        }
        
        let hasValidVarbind = false;
        for (const row of varbindRows) {
            const oid   = row.querySelector(".vb-oid").value.trim();
            const value = row.querySelector(".vb-val").value.trim();
            if (oid && value) {
                hasValidVarbind = true;
                break;
            }
        }
        
        if (!hasValidVarbind) {
            this.showSenderError('Please provide OID and value for at least one VarBind');
            return;
        }
        
        const btn          = document.getElementById('btn-send-trap');
        const originalText = btn.innerHTML;
        btn.disabled       = true;
        btn.innerHTML      = '<i class="fas fa-spinner fa-spin"></i> Sending...';

        try {
            let resolvedTrapOid = trapOid;
            
            if (trapOid.includes("::")) {
                const trapRes  = await fetch(`/api/mibs/resolve?oid=${encodeURIComponent(trapOid)}&mode=numeric`);
                const trapData = await trapRes.json();
                resolvedTrapOid = trapData.output;
            }

            const varbinds = [];
            
            for (const row of varbindRows) {
                const oid   = row.querySelector(".vb-oid").value.trim();
                const type  = row.querySelector(".vb-type").value;
                const value = row.querySelector(".vb-val").value.trim();
                
                if (!oid || !value) continue;
                
                let numericOid = oid;
                if (oid.includes("::")) {
                    const vbRes  = await fetch(`/api/mibs/resolve?oid=${encodeURIComponent(oid)}&mode=numeric`);
                    const vbData = await vbRes.json();
                    numericOid   = vbData.output;
                }
                
                varbinds.push({ oid: numericOid, type, value });
            }

            const payload = {
                target:    document.getElementById("ts-target").value,
                port:      parseInt(document.getElementById("ts-port").value),
                community: document.getElementById("ts-comm").value,
                oid:       resolvedTrapOid,
                varbinds:  varbinds
            };

            const res = await fetch('/api/traps/send', {
                method:  'POST',
                headers: {'Content-Type': 'application/json'},
                body:    JSON.stringify(payload)
            });
            
            if (res.ok) {
                const data = await res.json();
                this.showNotification(`✓ Trap sent to ${data.target}:${data.port}`, 'success');
                // WS trap push will update the table if target is local;
                // no manual setTimeout reload needed.
            } else {
                const errorData = await res.json();
                const errorMsg  = errorData.detail || 'Unknown error';
                this.showSenderError(`Trap send failed: ${errorMsg}`);
            }
        } catch (e) {
            console.error('[TRAP] Send error:', e);
            this.showSenderError(`Connection failed: ${e.message}`);
        } finally {
            btn.disabled  = false;
            btn.innerHTML = originalText;
        }
    },

    // ==================== Trap Receiver ====================

    checkStatus: async function() {
        try {
            const res  = await fetch('/api/traps/status');
            const data = await res.json();
            this.updateStatusUI(data);
        } catch(e) {
            console.error('Status check failed:', e);
        }
    },

    updateStatusUI: function(status) {
        const badge         = document.getElementById("tr-status-badge");
        const detail        = document.getElementById("tr-status-detail");
        const btnStart      = document.getElementById("btn-tr-start");
        const btnStop       = document.getElementById("btn-tr-stop");
        const metricsPanel  = document.getElementById("tr-metrics");
        const resolveToggle = document.getElementById("tr-resolve-toggle");
        
        if (!badge) return;
        
        if (status.running) {
            badge.className   = "badge bg-success";
            badge.textContent = "RUNNING";
            if (detail) {
                detail.textContent = `Port ${status.port || '--'} | ${status.resolve_mibs ? 'Resolved' : 'Raw'}`;
            }
            // Fix #26: sync the resolve toggle checkbox to the actual running state
            // so that any user opening the page sees the correct value, not the HTML default.
            if (resolveToggle && status.resolve_mibs != null) {
                resolveToggle.checked = status.resolve_mibs;
            }
            // Cache uptime_seconds for updateMetrics()
            this._receiverUptime = status.uptime_seconds != null ? status.uptime_seconds : null;
            if (metricsPanel) metricsPanel.classList.remove('d-none');
            btnStart.disabled = true;
            btnStop.disabled  = false;
        } else {
            badge.className   = "badge bg-secondary";
            badge.textContent = "STOPPED";
            if (detail) detail.textContent = "";
            // Fix #26: also sync toggle when stopped, using last known resolve_mibs
            // value returned by the backend (resolve_mibs is non-null even when stopped).
            if (resolveToggle && status.resolve_mibs != null) {
                resolveToggle.checked = status.resolve_mibs;
            }
            this._receiverUptime = null;
            if (metricsPanel) metricsPanel.classList.add('d-none');
            btnStart.disabled = false;
            btnStop.disabled  = true;
        }

        // Refresh uptime display whenever status changes
        this.updateMetrics();
    },

    startReceiver: async function() {
        const port      = parseInt(document.getElementById("tr-port").value);
        const community = document.getElementById("tr-community").value;
        const resolve   = document.getElementById("tr-resolve-toggle").checked;

        try {
            const res = await fetch('/api/traps/start', {
                method:  'POST',
                headers: {'Content-Type': 'application/json'},
                body:    JSON.stringify({
                    port:         port,
                    community:    community,
                    resolve_mibs: resolve
                })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || 'Trap receiver failed to start');
            }

            // WS status push from trap_manager will update the badge;
            // this call is a REST fallback for any timing gap.
            this.checkStatus();
            this.showNotification(data.status === 'already_running' ? 'Trap receiver is already running' : 'Trap receiver started', 'success');
        } catch (e) {
            console.error('Trap receiver start failed:', e);
            this.showNotification(`Trap receiver failed: ${e.message}`, 'error');
        }
    },

    stopReceiver: async function() {
        await fetch('/api/traps/stop', {method:'POST'});
        this.checkStatus();
        this.showNotification('Trap receiver stopped', 'info');
    },

    // ==================== Metrics ====================

    updateMetrics: function() {
        const totalEl   = document.getElementById('tr-metric-total');
        const lastEl    = document.getElementById('tr-metric-last');
        const sourceEl  = document.getElementById('tr-metric-source');
        const uptimeEl  = document.getElementById('tr-metric-uptime');
        
        if (!totalEl) return;
        
        totalEl.textContent = this.receivedTraps.length;
        
        if (this.receivedTraps.length > 0) {
            const latest = this.receivedTraps[0];
            // Use shared TrishulUtils for relative time (no local duplicate)
            lastEl.textContent = TrishulUtils.formatRelativeTime(latest.timestamp);
            
            const sourceCounts = {};
            this.receivedTraps.forEach(t => {
                sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
            });
            const topSource = Object.keys(sourceCounts).reduce((a, b) => 
                sourceCounts[a] > sourceCounts[b] ? a : b
            , '--');
            sourceEl.textContent = topSource;
            sourceEl.title       = `${sourceCounts[topSource]} traps`;
        } else {
            lastEl.textContent   = '--';
            sourceEl.textContent = '--';
        }

        // Uptime: use TrishulUtils.formatUptime with cached _receiverUptime
        if (uptimeEl) {
            uptimeEl.textContent = TrishulUtils.formatUptime(this._receiverUptime);
        }
    },

    // ==================== Received Traps Display ====================

    loadTraps: async function() {
        try {
            const res  = await fetch('/api/traps/');
            const json = await res.json();
            
            const newTraps = json.data || [];
            const existing = this.receivedTraps;
            const merged   = [...newTraps];
            
            existing.forEach(old => {
                if (!merged.find(t => t.timestamp === old.timestamp)) {
                    merged.push(old);
                }
            });
            
            this.receivedTraps = merged
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, 100);
            
            this.persistTraps();
            this.renderTraps();
            this.updateMetrics();
            
        } catch(e) {
            console.error('Failed to load traps:', e);
        }
    },

    filterTraps: function() {
        const searchInput = document.getElementById('tr-search');
        const searchTerm  = searchInput ? searchInput.value.toLowerCase().trim() : '';
        
        if (!searchTerm) {
            this.filteredTraps = [];
            this.renderTraps();
            return;
        }
        
        this.filteredTraps = this.receivedTraps.filter(trap => {
            const trapJson = JSON.stringify(trap).toLowerCase();
            return trapJson.includes(searchTerm);
        });
        
        this.renderTraps();
    },

    renderTraps: function() {
        const tbody      = document.getElementById("tr-table-body");
        const countBadge = document.getElementById("tr-count-badge");
        const esc = TrishulUtils.escapeHtml;
        
        if (!tbody) return;
        
        const trapsToShow = this.filteredTraps.length > 0 ? this.filteredTraps : this.receivedTraps;
        
        if (trapsToShow.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-3">No traps received.</td></tr>';
            if (countBadge) countBadge.textContent = '0';
            return;
        }
        
        if (countBadge) countBadge.textContent = trapsToShow.length;
        
        tbody.innerHTML = trapsToShow.map((t, idx) => {
            let trapBadgeClass = 'bg-secondary';
            const trapType     = t.trap_type || 'Unknown';
            
            if (trapType.toLowerCase().includes('up') || trapType.toLowerCase().includes('start')) {
                trapBadgeClass = 'bg-success';
            } else if (trapType.toLowerCase().includes('down')) {
                trapBadgeClass = 'bg-danger';
            } else if (trapType.toLowerCase().includes('auth') || trapType.toLowerCase().includes('fail')) {
                trapBadgeClass = 'bg-warning text-dark';
            }
            
            const simplifiedVarbinds = this.simplifyVarbinds(t.varbinds, t.resolved);
            const varbindsJson       = JSON.stringify(simplifiedVarbinds, null, 2);
            const varbindsPreview    = varbindsJson.length > 100 
                ? varbindsJson.substring(0, 100) + '...' 
                : varbindsJson;
            
            // NOTE: All buttons MUST have type="button" explicitly.
            // Default <button> type is "submit" which would trigger the Send Trap
            // <form onsubmit=...> and navigate the SPA back to the dashboard.
            return `
                <tr>
                    <td class="small text-muted">${esc(t.time_str)}</td>
                    <td><code class="small">${esc(t.source)}</code></td>
                    <td>
                        <span class="badge ${trapBadgeClass}">${esc(trapType)}</span>
                    </td>
                    <td>
                        <code class="small" style="cursor: pointer;"
                              onclick="TrapsModule.showTrapDetails(${idx})"
                              title="Click to view full JSON">
                            ${esc(varbindsPreview)}
                        </code>
                    </td>
                    <td class="text-center">
                        <button type="button" class="btn btn-sm btn-outline-primary py-0 px-1 me-1"
                                onclick="TrapsModule.copyTrap(${idx})" title="Copy JSON">
                            <i class="fas fa-copy"></i>
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-success py-0 px-1"
                                onclick="TrapsModule.downloadTrap(${idx})" title="Download">
                            <i class="fas fa-download"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    simplifyVarbinds: function(varbinds, resolved) {
        const simplified = {};
        
        if (Array.isArray(varbinds)) {
            varbinds.forEach(vb => {
                if (vb.oid && vb.oid.includes('1.3.6.1.6.3.1.1.4.1.0')) return;
                if (vb.name && vb.name.includes('snmpTrapOID'))           return;
                
                let key = vb.oid;
                if (resolved && vb.resolved && vb.name && vb.name !== vb.oid) {
                    key = vb.name;
                }
                
                simplified[key] = vb.value;
            });
        } else if (typeof varbinds === 'object') {
            return varbinds;
        }
        
        return simplified;
    },

    // ==================== Trap Detail Modal ====================

    copyModalJson: function(modalId) {
        const json = this._modalJson[modalId];
        if (!json) return;
        navigator.clipboard.writeText(json)
            .then(()  => this.showNotification('Copied!', 'success'))
            .catch(()  => this.showNotification('Copy failed', 'error'));
    },

    showTrapDetails: function(idx) {
        const trapsToShow        = this.filteredTraps.length > 0 ? this.filteredTraps : this.receivedTraps;
        const trap               = trapsToShow[idx];
        const simplifiedVarbinds = this.simplifyVarbinds(trap.varbinds, trap.resolved);
        
        const displayTrap = {
            timestamp: trap.timestamp,
            time:      trap.time_str,
            source:    trap.source,
            trap_type: trap.trap_type,
            varbinds:  simplifiedVarbinds,
            resolved:  trap.resolved
        };
        
        const json    = JSON.stringify(displayTrap, null, 2);
        const modalId = `trap-detail-modal-${Date.now()}`;
        this._modalJson[modalId] = json;
        
        const modal   = document.createElement('div');
        modal.className = 'modal fade';
        modal.id        = modalId;
        const escapedJson = TrishulUtils.escapeHtml(json);
        modal.innerHTML = `
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Trap Details</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <pre class="bg-dark text-light p-3 rounded"
                             style="max-height: 500px; overflow-y: auto;">${escapedJson}</pre>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-primary py-1 px-2"
                                onclick="TrapsModule.copyModalJson('${modalId}')">
                            <i class="fas fa-copy"></i> Copy
                        </button>
                        <button type="button" class="btn btn-sm btn-secondary py-1 px-2"
                                data-bs-dismiss="modal">Close</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => {
            delete this._modalJson[modalId];
            modal.remove();
        });
    },

    copyTrap: function(idx) {
        const trapsToShow        = this.filteredTraps.length > 0 ? this.filteredTraps : this.receivedTraps;
        const trap               = trapsToShow[idx];
        const simplifiedVarbinds = this.simplifyVarbinds(trap.varbinds, trap.resolved);
        
        const displayTrap = {
            timestamp: trap.timestamp,
            time:      trap.time_str,
            source:    trap.source,
            trap_type: trap.trap_type,
            varbinds:  simplifiedVarbinds,
            resolved:  trap.resolved
        };
        
        const json = JSON.stringify(displayTrap, null, 2);
        navigator.clipboard.writeText(json)
            .then(()  => this.showNotification('Trap copied to clipboard', 'success'))
            .catch(()  => this.showNotification('Copy failed — check clipboard permissions', 'error'));
    },

    downloadTrap: function(idx) {
        const trapsToShow        = this.filteredTraps.length > 0 ? this.filteredTraps : this.receivedTraps;
        const trap               = trapsToShow[idx];
        const simplifiedVarbinds = this.simplifyVarbinds(trap.varbinds, trap.resolved);
        
        const displayTrap = {
            timestamp: trap.timestamp,
            time:      trap.time_str,
            source:    trap.source,
            trap_type: trap.trap_type,
            varbinds:  simplifiedVarbinds,
            resolved:  trap.resolved
        };
        
        const json = JSON.stringify(displayTrap, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `trap_${trap.timestamp}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    downloadAllTraps: function() {
        if (!this.receivedTraps || this.receivedTraps.length === 0) {
            this.showNotification('No traps to download', 'warning');
            return;
        }
        
        const simplifiedTraps = this.receivedTraps.map(trap => ({
            timestamp: trap.timestamp,
            time:      trap.time_str,
            source:    trap.source,
            trap_type: trap.trap_type,
            varbinds:  this.simplifyVarbinds(trap.varbinds, trap.resolved),
            resolved:  trap.resolved
        }));
        
        const json = JSON.stringify(simplifiedTraps, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `all_traps_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    clearTraps: async function() {
        if (!confirm('Clear all received traps? This will also clear persisted data.')) return;
        
        await fetch('/api/traps/', {method:'DELETE'});
        this.receivedTraps = [];
        this.filteredTraps = [];
        this.persistTraps();
        this.renderTraps();
        this.updateMetrics();
        this.showNotification('All traps cleared', 'info');
    },

    // ==================== Utilities ====================

    showNotification: function(message, type = 'info') {
        TrishulUtils.showNotification(message, type);
    }
};

window.TrapsModule = {
    _listeners: [],
    vbCount: 0,
    allTraps: [],
    trapMap: {},
    allObjects: [],
    receivedTraps: [],
    filteredTraps: [],
    _trapSortKey: 'time',
    _trapSortDir: 'desc',
    _modalJson: {},          // keyed by modal id — avoids JSON-in-onclick-attr breakage
    _lastStatus: null,
    _receiverUptime: null,   // uptime_seconds cached from last updateStatusUI call
    _trapPollTimer: null,
    _statusPollTimer: null,
    _trapPollInFlight: false,
    _statusPollInFlight: false,
    _trapFetchSeq: 0,
    _statusFetchSeq: 0,

    init: function() {
        this._updateTrapSortHeaders();
        this.loadPersistedTraps();

        // WS updates are best-effort; keep the REST refresh loop active so the
        // receiver table stays live even if a push event is missed.
        this._registerListeners();

        // REST seed on first paint
        this.checkStatus();
        this.loadTraps();
        this._startPollingFallback();
        
        this.loadTrapList();
        
        // Check if trap data was passed from browser
        const browserTrapData = sessionStorage.getItem('selectedTrap');
        const browserTrapOid  = sessionStorage.getItem('trapOid');
        
        if (browserTrapData) {
            try {
                const trap = JSON.parse(browserTrapData);
                sessionStorage.removeItem('selectedTrap');
                const trapInput = document.getElementById('ts-trap-select');
                if (trapInput) {
                    trapInput.value = trap.full_name || trap.oid || '';
                }
                this.populateTrapForm(trap);
            } catch (e) {
                console.error('Failed to load trap from browser:', e);
            }
        } else if (browserTrapOid) {
            document.getElementById('ts-oid').value = browserTrapOid;
            sessionStorage.removeItem('trapOid');
            this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "12345");
            this.showNotification(`Notification selected: ${browserTrapOid}`, 'info');
        } else {
            this.loadSelectedTrap();
        }
    },

    destroy: function() {
        this._listeners.forEach(function(pair) {
            window.removeEventListener(pair[0], pair[1]);
        });
        this._listeners = [];
        this._stopPollingFallback();
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

        this._on('trishul:ws:close', function() {
            self._startPollingFallback();
        });

        // Resolve MIBs toggle — applies live without receiver restart
        const resolveToggleEl = document.getElementById('tr-resolve-toggle');
        if (resolveToggleEl) {
            resolveToggleEl.addEventListener('change', function() {
                const requestedResolve = resolveToggleEl.checked;
                const previousResolve = !!(self._lastStatus && self._lastStatus.resolve_mibs);
                fetch('/api/traps/resolve-mibs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ resolve_mibs: requestedResolve }),
                }).then(async function(res) {
                    const data = await res.json().catch(function() { return {}; });
                    if (!res.ok) {
                        throw new Error(data.detail || 'Failed to update OID resolution');
                    }
                    self.updateStatusUI(Object.assign({}, self._lastStatus || {}, {
                        resolve_mibs: !!data.resolve_mibs,
                    }));
                }).catch(function(e) {
                    console.error('Failed to update resolve_mibs:', e);
                    resolveToggleEl.checked = previousResolve;
                    if (self._lastStatus) {
                        self.updateStatusUI(Object.assign({}, self._lastStatus, {
                            resolve_mibs: previousResolve,
                        }));
                    }
                    self.showNotification(`Trap receiver settings update failed: ${e.message}`, 'error');
                });
            });
        }
    },

    _startPollingFallback: function() {
        var self = this;

        this._stopPollingFallback();

        this._trapPollTimer = window.setInterval(function() {
            if (self._trapPollInFlight) return;
            self._trapPollInFlight = true;
            Promise.resolve(self.loadTraps()).finally(function() {
                self._trapPollInFlight = false;
            });
        }, 1000);

        this._statusPollTimer = window.setInterval(function() {
            if (self._statusPollInFlight) return;
            self._statusPollInFlight = true;
            Promise.resolve(self.checkStatus()).finally(function() {
                self._statusPollInFlight = false;
            });
        }, 4000);
    },

    _stopPollingFallback: function() {
        if (this._trapPollTimer) {
            clearInterval(this._trapPollTimer);
            this._trapPollTimer = null;
        }
        if (this._statusPollTimer) {
            clearInterval(this._statusPollTimer);
            this._statusPollTimer = null;
        }
        this._trapPollInFlight = false;
        this._statusPollInFlight = false;
    },

    hasActiveTrapFilter: function() {
        const searchInput = document.getElementById('tr-search');
        return Boolean(searchInput && searchInput.value.trim());
    },

    getVisibleTraps: function() {
        const list = this.hasActiveTrapFilter() ? this.filteredTraps : this.receivedTraps;
        return this.sortTraps(list);
    },

    sortTraps: function(traps) {
        const list = Array.isArray(traps) ? traps : [];
        const key  = this._trapSortKey;
        const dir  = this._trapSortDir === 'asc' ? 1 : -1;
        return list.slice().sort((a, b) => {
            let cmp = 0;
            if (key === 'source') {
                cmp = String(a.source || '').localeCompare(String(b.source || ''), undefined, { numeric: true, sensitivity: 'base' });
            } else {
                cmp = (new Date(a.timestamp).getTime() || 0) - (new Date(b.timestamp).getTime() || 0);
            }
            return cmp * dir;
        });
    },

    toggleTrapSort: function(key) {
        if (this._trapSortKey === key) {
            this._trapSortDir = this._trapSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this._trapSortKey = key;
            this._trapSortDir = key === 'time' ? 'desc' : 'asc';
        }
        this._updateTrapSortHeaders();
        this.renderTraps();
    },

    _updateTrapSortHeaders: function() {
        const configs = [
            { key: 'time',   thId: 'tr-th-time' },
            { key: 'source', thId: 'tr-th-source' },
        ];
        configs.forEach(config => {
            const th = document.getElementById(config.thId);
            if (!th) return;
            const active = this._trapSortKey === config.key;
            th.setAttribute('aria-sort', active ? (this._trapSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
            const icon = th.querySelector('.th-sort-icon');
            if (icon) {
                icon.className = 'fas th-sort-icon ' + (active ? (this._trapSortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down') : 'fa-sort');
            }
        });
    },

    getTrapKey: function(trap) {
        if (!trap || typeof trap !== 'object') return '';
        const id = trap.id != null ? String(trap.id) : '';
        if (id) return id;
        const composite = [
            String(trap.timestamp || ''),
            String(trap.source || ''),
            String(trap.trap_type || '')
        ].join('|');
        return composite !== '||' ? composite : JSON.stringify(trap);
    },

    // Prepend a single live trap without doing a full REST reload.
    _prependTrap: function(trap) {
        const trapKey = this.getTrapKey(trap);
        if (trapKey && this.receivedTraps.find(t => this.getTrapKey(t) === trapKey)) return;
        this.receivedTraps.unshift(trap);
        if (this.receivedTraps.length > 100) this.receivedTraps.pop();
        this.persistTraps();
        if (this.hasActiveTrapFilter()) {
            this.filterTraps();
        } else {
            this.renderTraps();
        }
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
            const res = await fetch('/api/mibs/traps');
            const data = await res.json();

            this.allTraps = Array.isArray(data.traps) ? data.traps : [];
            this.trapMap = {};

            const input = document.getElementById('ts-trap-select');
            const datalist = document.getElementById('ts-trap-options');
            if (!input || !datalist) return;

            datalist.innerHTML = '';

            this.allTraps.forEach(trap => {
                if (!trap || !trap.full_name) return;
                this.trapMap[trap.full_name] = trap;
                const option = document.createElement('option');
                option.value = trap.full_name;
                option.label = `${trap.module || 'MIB'} · ${(trap.objects || []).length} objects`;
                datalist.appendChild(option);
            });
        } catch (e) {
            console.error('Failed to load trap list:', e);
        }
    },

    findTrapSelection: function(value) {
        const query = String(value || '').trim();
        if (!query) return null;
        if (this.trapMap[query]) return this.trapMap[query];

        const lowered = query.toLowerCase();
        const exactFullName = this.allTraps.find(trap =>
            String(trap && trap.full_name ? trap.full_name : '').toLowerCase() === lowered
        );
        if (exactFullName) return exactFullName;

        const nameMatches = this.allTraps.filter(trap =>
            String(trap && trap.name ? trap.name : '').toLowerCase() === lowered
        );
        return nameMatches.length === 1 ? nameMatches[0] : null;
    },

    onTrapSelected: function() {
        const input = document.getElementById('ts-trap-select');
        if (!input) return;

        const trap = this.findTrapSelection(input.value);
        if (!trap) return;

        input.value = trap.full_name || input.value;
        this.populateTrapForm(trap);
    },

    populateTrapForm: function(trap) {
        const trapInput = document.getElementById('ts-trap-select');
        if (trapInput && trap && trap.full_name) {
            trapInput.value = trap.full_name;
        }

        document.getElementById('ts-oid').value = trap.full_name || trap.oid || '';

        document.getElementById('vb-container').innerHTML =
            '<div class="text-center text-muted small py-2 d-none" id="vb-empty"></div>';

        this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "12345");

        if (trap.objects && trap.objects.length > 0) {
            trap.objects.forEach(obj => {
                this.addVarbind(obj);
            });
        }

        this.showNotification(`Trap loaded: ${trap.name}`, 'success');
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

    inferVarbindType: function(obj) {
        const providedType = String(obj && obj.input_type ? obj.input_type : '').trim();
        if (providedType) {
            const normalizedProvidedType = this.syntaxToType(providedType);
            if (normalizedProvidedType) return normalizedProvidedType;
        }
        const syntax = String(obj && obj.syntax ? obj.syntax : '').trim();
        if (syntax) {
            const mapped = this.syntaxToType(syntax);
            if (mapped) return mapped;
        }
        return this.guessVarBindType(String(obj && obj.name ? obj.name : ''));
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
            <div class="modal fade" id="varbindPickerModal" tabindex="-1" aria-labelledby="varbind-picker-title">
                <div class="modal-dialog modal-lg modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="varbind-picker-title">Select VarBind from MIB</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body">
                            <input type="text" id="vb-search" class="form-control mb-3" placeholder="Search objects..." aria-label="Search MIB objects">
                            <div class="app-scroll-panel app-max-h-400">
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
                <td><span class="badge app-badge is-neutral small">${esc(obj.module)}</span></td>
                <td><span class="small">${esc(obj.syntax)}</span></td>
                <td>
                    <button type="button" class="btn btn-xs btn-app-secondary btn-icon"
                            onclick="TrapsModule.addVarbindFromPickerElement(this)"
                            aria-label="Add varbind"
                            data-object="${esc(TrishulUtils.encodeDataAttr(obj))}">
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
        const objectMeta = TrishulUtils.decodeDataAttr(button?.dataset?.object || '', null);
        this.addVarbindFromPicker(objectMeta || button?.dataset?.fullName || '', button?.dataset?.syntax || '');
    },

    addVarbindFromPicker: function(fullNameOrMeta, syntax) {
        if (fullNameOrMeta && typeof fullNameOrMeta === 'object' && !Array.isArray(fullNameOrMeta)) {
            this.addVarbind(fullNameOrMeta);
        } else {
            const type = this.syntaxToType(syntax);
            this.addVarbind(fullNameOrMeta, type, "");
        }
        
        const modal = bootstrap.Modal.getInstance(document.getElementById('varbindPickerModal'));
        if (modal) modal.hide();
    },

    syntaxToType: function(syntax) {
        const normalized = String(syntax || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');

        if (!normalized) return 'String';
        if (
            normalized.includes('integer')
            || normalized === 'interfaceindex'
            || normalized === 'truthvalue'
            || normalized === 'rowstatus'
        ) {
            return 'Integer';
        }
        if (normalized.includes('counter')) {
            return 'Counter';
        }
        if (normalized.includes('gauge') || normalized.includes('unsigned')) {
            return 'Gauge';
        }
        if (normalized.includes('timeticks') || normalized.includes('timestamp')) {
            return 'TimeTicks';
        }
        if (normalized.includes('ipaddress') || normalized.includes('inetaddress')) {
            return 'IpAddress';
        }
        if (normalized.includes('objectidentifier') || normalized.includes('autonomoustype')) {
            return 'OID';
        }
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
            
            const trapInput = document.getElementById('ts-trap-select');
            if (trapInput) {
                trapInput.value = trap.full_name || trap.oid || '';
            }
            
            this.populateTrapForm(trap);
            
        } catch (e) {
            console.error('Failed to load selected trap:', e);
        }
    },

    enumValuesForRow: function(row) {
        return TrishulUtils.normalizeEnumValues(TrishulUtils.decodeDataAttr(row?.dataset?.enumValues || '', []));
    },

    constraintForRow: function(row) {
        return TrishulUtils.decodeDataAttr(row?.dataset?.constraint || '', null);
    },

    formatConstraintHint: function(constraint) {
        const data = Array.isArray(constraint?.data) ? constraint.data : [];
        const parts = data
            .map(pair => Array.isArray(pair) && pair.length >= 2 ? `${pair[0]}..${pair[1]}` : '')
            .filter(Boolean);
        return parts.join(', ');
    },

    isIntegerInRange: function(value, constraint) {
        const intValue = parseInt(value, 10);
        if (Number.isNaN(intValue)) return false;
        return (Array.isArray(constraint?.data) ? constraint.data : []).some(pair =>
            Array.isArray(pair) && pair.length >= 2 && intValue >= pair[0] && intValue <= pair[1]
        );
    },

    isStringWithinSize: function(value, constraint) {
        const text = String(value ?? '');
        // Count UTF-8 bytes so non-ASCII strings fail pre-submit consistently
        // with the backend's byte-based size validation.
        const length = new TextEncoder().encode(text).length;
        return (Array.isArray(constraint?.data) ? constraint.data : []).some(pair =>
            Array.isArray(pair) && pair.length >= 2 && length >= pair[0] && length <= pair[1]
        );
    },

    shouldUseEnumValueControl: function(type, enumValues) {
        return String(type || '').trim() === 'Integer' && Array.isArray(enumValues) && enumValues.length > 0;
    },

    buildVarbindValueControl: function(type, value, enumValues, constraint) {
        const currentValue = value == null ? '' : String(value);

        if (!this.shouldUseEnumValueControl(type, enumValues)) {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'form-control vb-val';
            input.value = currentValue;
            input.placeholder = 'Value';
            input.setAttribute('aria-label', 'VarBind value');
            return input;
        }

        const select = document.createElement('select');
        select.className = 'form-select vb-val';
        select.setAttribute('aria-label', 'Value');

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select value';
        select.appendChild(placeholder);

        let matched = false;
        enumValues.forEach(item => {
            const option = document.createElement('option');
            const optionValue = String(item.value);
            option.value = optionValue;
            option.textContent = `${item.label} (${optionValue})`;
            if (optionValue === currentValue) {
                option.selected = true;
                matched = true;
            }
            select.appendChild(option);
        });

        if (currentValue && !matched) {
            const customOption = document.createElement('option');
            customOption.value = currentValue;
            customOption.textContent = currentValue;
            customOption.selected = true;
            select.appendChild(customOption);
        }

        return select;
    },

    renderConstraintHint: function(row, type, constraint) {
        row.querySelectorAll('.vb-constraint-hint').forEach(el => el.remove());
        const applicable = constraint && (
            (type === 'Integer' && constraint.kind === 'range')
            || (type === 'String' && constraint.kind === 'size')
        );
        const hint = applicable ? this.formatConstraintHint(constraint) : '';
        if (!hint) return;
        const hintEl = document.createElement('div');
        hintEl.className = 'small text-muted mt-1 vb-constraint-hint';
        hintEl.textContent = type === 'Integer' ? `Range: ${hint}` : `Length: ${hint}`;
        const valueInput = row.querySelector('.vb-val');
        const inputGroup = valueInput ? valueInput.closest('.input-group') : null;
        if (inputGroup) {
            inputGroup.insertAdjacentElement('afterend', hintEl);
        } else if (valueInput) {
            valueInput.insertAdjacentElement('afterend', hintEl);
        }
    },

    attachVarbindFieldListeners: function(row) {
        if (!row) return;
        const validate = () => this.validateVarbindRow(row);

        const oidInput = row.querySelector('.vb-oid');
        if (oidInput && !oidInput.dataset.bound) {
            oidInput.addEventListener('input', validate);
            oidInput.addEventListener('change', validate);
            oidInput.dataset.bound = '1';
        }

        const typeInput = row.querySelector('.vb-type');
        if (typeInput && !typeInput.dataset.bound) {
            typeInput.addEventListener('change', () => {
                this.syncVarbindValueControl(row);
                this.validateVarbindRow(row);
            });
            typeInput.dataset.bound = '1';
        }

        const valueInput = row.querySelector('.vb-val');
        if (valueInput && !valueInput.dataset.bound) {
            valueInput.addEventListener('input', validate);
            valueInput.addEventListener('change', validate);
            valueInput.dataset.bound = '1';
        }
    },

    syncVarbindValueControl: function(row, options = {}) {
        if (!row) return;
        const valueControl = row.querySelector('.vb-val');
        const typeInput = row.querySelector('.vb-type');
        if (!typeInput) return;

        const nextValue = options.value != null
            ? String(options.value)
            : String(valueControl && options.preserveValue !== false ? valueControl.value || '' : '');
        const nextControl = this.buildVarbindValueControl(
            typeInput.value,
            nextValue,
            this.enumValuesForRow(row),
            this.constraintForRow(row)
        );

        if (valueControl) {
            valueControl.replaceWith(nextControl);
        } else {
            typeInput.insertAdjacentElement('afterend', nextControl);
        }

        this.renderConstraintHint(row, typeInput.value, this.constraintForRow(row));
        this.attachVarbindFieldListeners(row);
    },

    addVarbind: function(oid="", type, val="") {
        const container = document.getElementById("vb-container");
        const emptyMsg  = document.getElementById("vb-empty");
        const esc = TrishulUtils.escapeHtml;
        if (emptyMsg) emptyMsg.classList.add('d-none');

        let targetOid = String(oid || '').trim();
        let value = val == null ? '' : String(val);
        let resolvedType = String(type || '').trim();
        let enumValues = [];
        let constraint = null;

        if (oid && typeof oid === 'object' && !Array.isArray(oid)) {
            targetOid = String(oid.full_name || oid.oid || '').trim();
            if (!resolvedType) {
                resolvedType = this.inferVarbindType(oid);
            }
            if (val == null && oid.value != null) {
                value = String(oid.value);
            }
            enumValues = TrishulUtils.normalizeEnumValues(oid.enum_values);
            constraint = oid.constraint || null;
        }

        if (!resolvedType) {
            resolvedType = 'String';
        }
        
        const id   = `vb-row-${this.vbCount++}`;
        const html = `
            <div class="card mb-2" id="${id}" data-enum-values="${esc(TrishulUtils.encodeDataAttr(enumValues))}" data-constraint="${esc(TrishulUtils.encodeDataAttr(constraint))}">
                <div class="card-body p-2">
                    <div class="input-group input-group-sm mb-1">
                        <span class="input-group-text app-input-group-text">OID</span>
                        <input type="text" class="form-control vb-oid" value="${esc(targetOid)}" placeholder="1.3.6... or IF-MIB::ifIndex" aria-label="VarBind OID">
                        <button class="btn btn-app-danger-outline" type="button" aria-label="Remove varbind" onclick="TrapsModule.removeVarbind('${id}')">X</button>
                    </div>
                    <div class="input-group input-group-sm">
                        <select class="form-select vb-type app-max-w-120" aria-label="VarBind type">
                            <option value="String"     ${resolvedType==='String'    ?'selected':''}>String</option>
                            <option value="Integer"    ${resolvedType==='Integer'   ?'selected':''}>Integer</option>
                            <option value="OID"        ${resolvedType==='OID'       ?'selected':''}>OID</option>
                            <option value="TimeTicks"  ${resolvedType==='TimeTicks' ?'selected':''}>TimeTicks</option>
                            <option value="IpAddress"  ${resolvedType==='IpAddress' ?'selected':''}>IpAddress</option>
                            <option value="Counter"    ${resolvedType==='Counter'   ?'selected':''}>Counter</option>
                            <option value="Gauge"      ${resolvedType==='Gauge'     ?'selected':''}>Gauge</option>
                        </select>
                        <input type="text" class="form-control vb-val" value="${esc(value)}" placeholder="Value" aria-label="VarBind value">
                    </div>
                    <div class="small app-status-text is-error mt-1 d-none vb-feedback"></div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
        const row = document.getElementById(id);
        if (row) {
            this.attachVarbindFieldListeners(row);
            this.syncVarbindValueControl(row, { preserveValue: false, value });
            this.validateVarbindRow(row);
        }
    },

    removeVarbind: function(rowId) {
        const row = document.getElementById(rowId);
        if (row) row.remove();
        const container = document.getElementById("vb-container");
        const emptyMsg = document.getElementById("vb-empty");
        if (container && emptyMsg && container.querySelectorAll('.card').length === 0) {
            emptyMsg.classList.remove('d-none');
        }
    },

    isNumericOid: function(value) {
        const text = String(value || '').trim().replace(/^\./, '');
        if (!text) return false;
        const parts = text.split('.');
        return parts.length >= 2 && parts.every(part => /^\d+$/.test(part));
    },

    isSymbolicOid: function(value) {
        return /^[A-Za-z][A-Za-z0-9-]*::[A-Za-z][A-Za-z0-9-]*(\.[0-9]+)*$/.test(String(value || '').trim());
    },

    isOidReference: function(value) {
        return this.isNumericOid(value) || this.isSymbolicOid(value);
    },

    validateVarbindRow: function(row, options = {}) {
        if (!row) return { valid: true, empty: true, message: '' };

        const requireComplete = options.requireComplete === true;
        const oidInput = row.querySelector(".vb-oid");
        const typeInput = row.querySelector(".vb-type");
        const valueInput = row.querySelector(".vb-val");
        const feedback = row.querySelector(".vb-feedback");

        const oid = oidInput ? oidInput.value.trim() : '';
        const type = typeInput ? typeInput.value : 'String';
        const value = valueInput ? valueInput.value.trim() : '';
        const constraint = this.constraintForRow(row);
        const hasAnyContent = Boolean(oid || value);

        let message = '';

        if (!hasAnyContent && !requireComplete) {
            message = '';
        } else if (!requireComplete && oid && !value) {
            message = this.isOidReference(oid) ? '' : 'OID target must be dotted numeric or MODULE::symbol.';
        } else if (!oid) {
            message = 'OID target is required.';
        } else if (!this.isOidReference(oid)) {
            message = 'OID target must be dotted numeric or MODULE::symbol.';
        } else if (!value) {
            message = 'VarBind value is required.';
        } else if (type === 'Integer' && !/^-?\d+$/.test(value)) {
            message = 'Integer values must be whole numbers.';
        } else if ((type === 'Counter' || type === 'Gauge' || type === 'TimeTicks') && !/^\d+$/.test(value)) {
            message = `${type} values must be zero or greater integers.`;
        } else if (type === 'OID' && !this.isOidReference(value)) {
            message = 'OID values must be dotted numeric with at least two arcs or MODULE::symbol.';
        } else if (type === 'IpAddress' && !/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value)) {
            message = 'IP address values must be valid IPv4 addresses.';
        } else if (type === 'Integer' && constraint && constraint.kind === 'range' && !this.isIntegerInRange(value, constraint)) {
            message = `Integer values must be within range: ${this.formatConstraintHint(constraint)}.`;
        } else if (type === 'String' && constraint && constraint.kind === 'size' && !this.isStringWithinSize(value, constraint)) {
            message = `String length must be within: ${this.formatConstraintHint(constraint)}.`;
        }

        const invalid = Boolean(message);
        if (oidInput) oidInput.classList.toggle('is-invalid', invalid);
        if (valueInput) valueInput.classList.toggle('is-invalid', invalid);
        if (feedback) {
            feedback.textContent = message;
            feedback.classList.toggle('d-none', !invalid);
        }

        return {
            valid: !invalid,
            empty: !hasAnyContent,
            message: message,
            oid: oid,
            type: type,
            value: value
        };
    },

    resetForm: function() {
        document.getElementById("vb-container").innerHTML =
            '<div class="text-center text-muted small py-2 d-none" id="vb-empty">No VarBinds added</div>';
        document.getElementById("ts-oid").value = "IF-MIB::linkDown";
        
        const trapInput = document.getElementById("ts-trap-select");
        if (trapInput) trapInput.value = "";
        
        this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "0");
        this.hideSenderError();
    },

    // ==================== Trap Sending ====================

    sendTrap: async function(e) {
        e.preventDefault();
        this.hideSenderError();
        
        const trapOid = document.getElementById("ts-oid").value.trim();
        if (!trapOid) {
            this.showSenderError('Please enter a notification OID or select one from the trap library');
            return;
        }
        
        const varbindRows = document.querySelectorAll("#vb-container .card");
        if (varbindRows.length === 0) {
            this.showSenderError('Please add at least one VarBind');
            return;
        }

        const validatedRows = Array.from(varbindRows).map(row => this.validateVarbindRow(row));
        const completeRows = validatedRows.filter(entry => entry.oid && entry.value);
        if (completeRows.length === 0) {
            this.showSenderError('Please provide OID and value for at least one VarBind');
            return;
        }

        const invalidRow = completeRows.find(entry => !entry.valid);
        if (invalidRow) {
            this.showSenderError(`Trap send failed: ${invalidRow.message}`);
            return;
        }

        const skippedRows = validatedRows.filter(entry => (entry.oid && !entry.value) || (!entry.oid && entry.value) || entry.empty).length;
        
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

            for (const item of completeRows) {
                const oid = item.oid;
                const type = item.type;
                const value = item.value;
                let numericOid = oid;
                if (oid.includes("::")) {
                    const vbRes  = await fetch(`/api/mibs/resolve?oid=${encodeURIComponent(oid)}&mode=numeric`);
                    const vbData = await vbRes.json();
                    numericOid   = vbData && vbData.output ? vbData.output : oid;
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
                const skippedSuffix = skippedRows > 0 ? ` (${skippedRows} blank/incomplete VarBind row${skippedRows === 1 ? '' : 's'} skipped)` : '';
                this.showNotification(`Trap sent to ${data.target}:${data.port}${skippedSuffix}`, 'success');
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
        const requestSeq = ++this._statusFetchSeq;
        try {
            const res  = await fetch('/api/traps/status');
            const data = await res.json();
            if (requestSeq !== this._statusFetchSeq) return;
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
        const portInput     = document.getElementById("tr-port");
        const communityInput = document.getElementById("tr-community");
        this._lastStatus = Object.assign({}, status || {});
        
        if (!badge) return;
        
        if (status.running) {
            TrishulUtils.setStatusBadgeState(badge, 'running', 'RUNNING');
            if (detail) {
                detail.textContent = `Listening on ${status.port || '--'} · ${status.resolve_mibs ? 'OID resolution on' : 'OID resolution off'}`;
            }
            // Fix #26: sync the resolve toggle checkbox to the actual running state
            // so that any user opening the page sees the correct value, not the HTML default.
            if (resolveToggle && status.resolve_mibs != null) {
                resolveToggle.checked = status.resolve_mibs;
            }
            if (portInput) {
                portInput.value = status.port || portInput.value;
                portInput.disabled = true;
            }
            if (communityInput) {
                communityInput.value = status.community || communityInput.value;
                communityInput.disabled = true;
            }
            // resolve_mibs toggle stays enabled while running — backend applies it live
            // Cache uptime_seconds for updateMetrics()
            this._receiverUptime = status.uptime_seconds != null ? status.uptime_seconds : null;
            if (metricsPanel) metricsPanel.classList.remove('d-none');
            btnStart.disabled = true;
            btnStop.disabled  = false;
        } else {
            TrishulUtils.setStatusBadgeState(badge, 'stopped', 'STOPPED');
            if (detail) {
                detail.textContent = `Receiver stopped · ${status.resolve_mibs ? 'OID resolution on' : 'OID resolution off'}`;
            }
            // Fix #26: also sync toggle when stopped, using last known resolve_mibs
            // value returned by the backend (resolve_mibs is non-null even when stopped).
            if (resolveToggle && status.resolve_mibs != null) {
                resolveToggle.checked = status.resolve_mibs;
            }
            if (portInput) {
                portInput.disabled = false;
            }
            if (communityInput) {
                communityInput.disabled = false;
            }
            if (resolveToggle) {
                resolveToggle.disabled = false;
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

            this.updateStatusUI({
                running: true,
                port: port,
                community: community,
                resolve_mibs: resolve,
                uptime_seconds: 0
            });
            await this.checkStatus();
            this.showNotification('Trap receiver started', 'success');
        } catch (e) {
            console.error('Trap receiver start failed:', e);
            this.showNotification(`Trap receiver failed: ${e.message}`, 'error');
        }
    },

    stopReceiver: async function() {
        await fetch('/api/traps/stop', {method:'POST'});
        this.updateStatusUI({
            running: false,
            resolve_mibs: document.getElementById("tr-resolve-toggle")?.checked,
        });
        await this.checkStatus();
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
        const requestSeq = ++this._trapFetchSeq;
        try {
            const res  = await fetch('/api/traps/');
            const json = await res.json();
            if (requestSeq !== this._trapFetchSeq) return;
            
            const newTraps = json.data || [];
            const merged = new Map();

            newTraps.forEach(trap => {
                merged.set(this.getTrapKey(trap), trap);
            });
            this.receivedTraps.forEach(trap => {
                const key = this.getTrapKey(trap);
                if (!merged.has(key)) {
                    merged.set(key, trap);
                }
            });

            this.receivedTraps = Array.from(merged.values())
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, 100);
            
            this.persistTraps();
            if (this.hasActiveTrapFilter()) {
                this.filterTraps();
            } else {
                this.renderTraps();
            }
            this.updateMetrics();
            
        } catch(e) {
            console.error('Failed to load traps:', e);
        }
    },

    filterTraps: function() {
        const searchInput = document.getElementById('tr-search');
        const searchTerm  = searchInput ? searchInput.value.toLowerCase().trim() : '';

        const clearBtn = document.getElementById('btn-clear-tr-search');
        if (clearBtn) {
            if (searchInput && searchInput.value.length > 0) {
                clearBtn.classList.remove('d-none');
            } else {
                clearBtn.classList.add('d-none');
            }
        }

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

    clearTrapSearch: function() {
        const searchInput = document.getElementById('tr-search');
        if (searchInput) {
            searchInput.value = '';
            const clearBtn = document.getElementById('btn-clear-tr-search');
            if (clearBtn) clearBtn.classList.add('d-none');
            searchInput.focus();
        }
        this.filterTraps();
    },

    // Visually hidden live region for assistive tech: announces each trap
    // arrival without re-reading the whole table. Only writes when the text
    // actually changes so 1s polling cycles don't re-announce the same value.
    _updateLiveStatus: function() {
        const statusEl = document.getElementById('tr-live-status');
        if (!statusEl) return;
        let nextText;
        if (this.receivedTraps.length === 0) {
            nextText = 'No traps received';
        } else {
            const latest = this.receivedTraps[0];
            const name   = latest.trap_type || 'unknown';
            const source = latest.source || 'unknown';
            nextText = this.receivedTraps.length === 1
                ? `1 trap received, latest: ${name} from ${source}`
                : `${this.receivedTraps.length} traps received, latest: ${name} from ${source}`;
        }
        if (statusEl.textContent !== nextText) {
            statusEl.textContent = nextText;
        }
    },

    renderTraps: function() {
        const tbody      = document.getElementById("tr-table-body");
        const countBadge = document.getElementById("tr-count-badge");
        const esc = TrishulUtils.escapeHtml;
        
        if (!tbody) return;
        
        this._updateLiveStatus();
        
        const trapsToShow = this.getVisibleTraps();
        
        if (trapsToShow.length === 0) {
            const placeholder = this.hasActiveTrapFilter()
                ? TrishulUtils.buildPanelPlaceholder({
                    title: 'No matching traps',
                    copy: 'Adjust the search or wait for new receiver activity.',
                    icon: 'fa-search',
                    compact: true,
                })
                : TrishulUtils.buildPanelPlaceholder({
                    title: 'No traps received',
                    copy: 'Start the receiver to capture live notifications.',
                    icon: 'fa-bell-slash',
                    compact: true,
                });
            tbody.innerHTML = `<tr><td colspan="5" class="p-0 border-0">${placeholder}</td></tr>`;
            if (countBadge && countBadge.textContent !== '0') countBadge.textContent = '0';
            return;
        }
        
        const countText = String(trapsToShow.length);
        if (countBadge && countBadge.textContent !== countText) countBadge.textContent = countText;
        
        tbody.innerHTML = trapsToShow.map((t, idx) => {
            let trapBadgeClass = 'app-badge is-neutral';
            const trapType     = t.trap_type || 'Unknown';
            
            if (trapType.toLowerCase().includes('up') || trapType.toLowerCase().includes('start')) {
                trapBadgeClass = 'app-badge is-success';
            } else if (trapType.toLowerCase().includes('down')) {
                trapBadgeClass = 'app-badge is-danger';
            } else if (trapType.toLowerCase().includes('auth') || trapType.toLowerCase().includes('fail')) {
                trapBadgeClass = 'app-badge is-warning';
            }
            
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
                        <div class="cursor-pointer"
                              onclick="TrapsModule.showTrapDetails(${idx})"
                              title="Click to view full details">
                            ${this.renderVarbindRows(t.varbinds, t.resolved)}
                        </div>
                    </td>
                    <td class="text-center">
                        <div class="trap-action-buttons">
                            <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-1"
                                    onclick="TrapsModule.copyTrap(${idx})" title="Copy JSON" aria-label="Copy JSON">
                                <i class="fas fa-copy"></i>
                            </button>
                            <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-1"
                                    onclick="TrapsModule.downloadTrap(${idx})" title="Download" aria-label="Download trap">
                                <i class="fas fa-download"></i>
                            </button>
                        </div>
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

    renderVarbindRows: function(varbinds, resolved) {
        const esc = TrishulUtils.escapeHtml;
        const rows = Array.isArray(varbinds) ? varbinds : [];
        const visible = rows.filter(vb => {
            if (vb.oid && vb.oid.includes('1.3.6.1.6.3.1.1.4.1.0')) return false;
            if (vb.name && vb.name.includes('snmpTrapOID')) return false;
            return true;
        });
        if (visible.length === 0) {
            return '<span class="text-muted">--</span>';
        }
        return `<div class="app-trap-varbinds">${visible.map(vb => {
            const key = (resolved && vb.resolved && vb.name && vb.name !== vb.oid)
                ? vb.name
                : (vb.name || vb.oid || '');
            const enumLabel = String(vb.enum_label || '').trim();
            const units = String(vb.units || '').trim();
            // Title carries the full text (enum label + units included) so the
            // truncated line never silently loses them; the line itself is a
            // flex row — the value text ellipsizes, the badge does not clip (TRP-13).
            const fullText = `${key} = ${TrishulUtils.formatValueText(vb.value, { enumLabel, units })}`;
            return `<div class="app-trap-varbind-row" title="${esc(fullText)}">` +
                `<span class="app-trap-varbind-text">${esc(key)} = ${esc(vb.value == null ? '' : String(vb.value))}</span>` +
                (enumLabel ? `<span class="badge app-badge is-info app-value-enum-badge">${esc(enumLabel)}</span>` : '') +
                (units ? `<span class="app-value-units">${esc(units)}</span>` : '') +
                `</div>`;
        }).join('')}</div>`;
    },

    renderDetailVarbindTable: function(varbinds, resolved) {
        const esc = TrishulUtils.escapeHtml;
        const rows = Array.isArray(varbinds) ? varbinds : [];
        if (rows.length === 0) {
            return '<div class="text-muted small">No varbinds recorded.</div>';
        }
        return `
            <div class="mb-2">
                <div class="text-muted fw-bold small mb-2">VarBinds</div>
                <table class="table table-sm table-hover mb-0 small">
                    <thead class="table-light">
                        <tr><th scope="col">Name</th><th scope="col">Value</th></tr>
                    </thead>
                    <tbody>
                        ${rows.map(vb => {
                            const key = (resolved && vb.resolved && vb.name && vb.name !== vb.oid)
                                ? vb.name
                                : (vb.name || vb.oid || '');
                            const valueHtml = TrishulUtils.formatValue(vb.value, {
                                enumLabel: vb.enum_label,
                                units: vb.units,
                            });
                            return `<tr><td><code class="small">${esc(key)}</code></td><td>${valueHtml}</td></tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
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
        const trapsToShow        = this.getVisibleTraps();
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
        const titleId   = `${modalId}-title`;
        modal.setAttribute('aria-labelledby', titleId);
        const escapedJson = TrishulUtils.escapeHtml(json);
        modal.innerHTML = `
            <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="${titleId}">Trap Details</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        ${this.renderDetailVarbindTable(trap.varbinds, trap.resolved)}
                        <hr>
                        <pre class="app-code-pane app-scroll-panel p-3 rounded app-max-h-500">${escapedJson}</pre>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-app-secondary"
                                onclick="TrapsModule.copyModalJson('${modalId}')">
                            <i class="fas fa-copy"></i> Copy
                        </button>
                        <button type="button" class="btn btn-sm btn-app-secondary-solid"
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
        const trapsToShow        = this.getVisibleTraps();
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
        const trapsToShow        = this.getVisibleTraps();
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
        const confirmed = await TrishulUtils.confirmDialog({
            title: 'Clear all received traps?',
            message: 'This will also clear persisted data.',
            confirmLabel: 'Clear',
            variant: 'danger',
        });
        if (!confirmed) return;
        
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

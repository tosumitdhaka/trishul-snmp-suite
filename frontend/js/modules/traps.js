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
    _receiverUptimeBase: 0,  // RCV-07: uptime ticks locally between status payloads
    _receiverUptimeAnchorMs: 0,
    _uptimeTickerTimer: null,
    _trapPollTimer: null,
    _statusPollTimer: null,
    _trapPollInFlight: false,
    _statusPollInFlight: false,
    _trapFetchSeq: 0,
    _statusFetchSeq: 0,
    _trapListFetchSeq: 0,   // invalidates in-flight trap-library loads on MIB broadcasts
    _lastLoadedTrapName: '',
    _lastLoadedSignature: '',
    _livePaused: false,     // TRP-21: pause live prepend/poll churn while inspecting
    _trapLimit: 100,        // RCV-05: page size, aligned with the backend cap
    _trapOffset: 0,
    _trapTotal: null,       // RCV-11: persisted total from the pager payload; null until first fetch
    _replayTargetKey: null, // trap key being replayed (delegated modal submit)
    COMMUNITY_MASK: '••••••', // RCV-15: list payloads carry a mask, never the community string

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
        this._stopUptimeTicker();
        this.persistTraps();
    },

    _on: function(type, fn) {
        window.addEventListener(type, fn);
        this._listeners.push([type, fn]);
    },

    _registerListeners: function() {
        var self = this;

        // Delegated row actions: trap keys flow through data-* attributes, so
        // arbitrary key content cannot corrupt an inline onclick handler (RCV-10).
        this._on('click', function(event) {
            self._handleTrapRowAction(event);
        });

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
            self._stopPollingFallback();
            self.checkStatus();
            self.loadTraps();
        });

        this._on('trishul:ws:close', function() {
            self._startPollingFallback();
        });

        // MIB reload / bundle activation invalidates the trap-library and
        // var-bind-picker caches; drop them so the next load re-fetches fresh
        // metadata instead of serving stale objects (TRP-12). The picker
        // refetches lazily on its next open (allObjects is empty here).
        this._on('trishul:ws:mibs', function() {
            self._trapListFetchSeq++;      // discard any in-flight library load
            self.allTraps = [];
            self.trapMap = {};
            self.allObjects = [];
            self.loadTrapList();
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
                    // NEW-1: re-fetch and re-render immediately — varbind
                    // display fields change with the toggle even though
                    // ids/timestamps do not.
                    self.loadTraps();
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

        // RCV-02: the 1s REST poll is a WS-down fallback, mirroring the
        // simulator's strategy — while the WS is healthy the trap push and
        // status broadcasts keep the page live, so polling is unnecessary.
        if (window.WsClient && typeof window.WsClient.isConnected === 'function' && window.WsClient.isConnected()) {
            return;
        }

        this._trapPollTimer = window.setInterval(function() {
            if (self._trapPollInFlight) return;
            if (self._livePaused) return;   // TRP-21: paused view is manually refreshed
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

    // RCV-07: uptime_seconds arrives only on status payloads (lifecycle events
    // or the WS-down poll); tick the display locally between them so the
    // receiver uptime keeps counting up instead of freezing.
    _startUptimeTicker: function(uptimeSeconds) {
        this._receiverUptimeBase = Number(uptimeSeconds) || 0;
        this._receiverUptimeAnchorMs = Date.now();
        if (this._uptimeTickerTimer) return;
        var self = this;
        this._uptimeTickerTimer = window.setInterval(function() {
            const uptimeEl = document.getElementById('tr-metric-uptime');
            if (!uptimeEl) return;
            const elapsed = Math.floor((Date.now() - self._receiverUptimeAnchorMs) / 1000);
            uptimeEl.textContent = TrishulUtils.formatUptime(self._receiverUptimeBase + elapsed);
        }, 1000);
    },

    _stopUptimeTicker: function() {
        if (this._uptimeTickerTimer) {
            clearInterval(this._uptimeTickerTimer);
            this._uptimeTickerTimer = null;
        }
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

    // RCV-02: stable signature of a trap list — ids + timestamps in order —
    // used to skip re-rendering when a fetch returned the same page.
    _trapsSignature: function(traps) {
        // Salted with the resolve state: toggling resolution (or a bundle
        // switch) changes varbind display fields without changing ids or
        // timestamps, so the unsalted list would wrongly suppress the
        // re-render (RCV-02 residual).
        const resolve = (document.getElementById('tr-resolve-toggle') && document.getElementById('tr-resolve-toggle').checked) ? '1' : '0';
        return resolve + '|' + (Array.isArray(traps) ? traps : []).map(t =>
            `${this.getTrapKey(t)}@${t.timestamp || ''}`
        ).join('\n');
    },

    // RCV-15: the API masks the community string in list payloads; the replay
    // route applies the recorded value server-side when the override is blank.
    _isMaskedCommunity: function(value) {
        return String(value || '').trim() === this.COMMUNITY_MASK;
    },

    // Prepend a single live trap without doing a full REST reload. Skipped
    // while the view is paused or paged past page 1 — those traps arrive on the
    // next poll/manual refresh of page 1 (TRP-21, RCV-05).
    _prependTrap: function(trap) {
        if (this._livePaused || this._trapOffset > 0) return;
        const trapKey = this.getTrapKey(trap);
        if (trapKey && this.receivedTraps.find(t => this.getTrapKey(t) === trapKey)) return;
        this.receivedTraps.unshift(trap);
        if (this.receivedTraps.length > this._trapLimit) this.receivedTraps.pop();
        if (this._trapTotal != null) this._trapTotal += 1;
        this.persistTraps();
        if (this.hasActiveTrapFilter()) {
            this.filterTraps();
        } else {
            this.renderTraps();
        }
        this.updateMetrics();
        this.updatePager();
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

    // Result area for successful sends / inform acknowledgements (TRP-06):
    // acked informs get a green confirmation; ack failures use the error area.
    showSenderResult: function(message) {
        const resultEl   = document.getElementById('ts-result');
        const resultText = document.getElementById('ts-result-text');
        if (resultEl && resultText) {
            resultText.textContent = message;
            resultEl.classList.remove('d-none');
        }
    },

    hideSenderResult: function() {
        const resultEl = document.getElementById('ts-result');
        if (resultEl) {
            resultEl.classList.add('d-none');
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
        const requestSeq = ++this._trapListFetchSeq;
        try {
            const res = await fetch('/api/mibs/traps');
            if (!res.ok) throw new Error(`Trap library request failed: HTTP ${res.status}`);
            const data = await res.json();
            if (requestSeq !== this._trapListFetchSeq) return;

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

        const fullName = trap.full_name || input.value;

        // TRP-16: a single selection can surface repeated change events
        // (datalist pick + blur). Skip the rebuild when the same trap is
        // already loaded and the form is untouched; manual edits produce a
        // different signature, so an explicit re-selection still reloads.
        if (this._lastLoadedTrapName === fullName
            && this._lastLoadedSignature === this._trapFormSignature()) {
            return;
        }

        input.value = fullName;
        this.populateTrapForm(trap);
    },

    // Fingerprint of the current varbind rows (OID/type/value), used to tell
    // "same trap, form untouched" (duplicate event) from "same trap, edited".
    _trapFormSignature: function() {
        return Array.from(document.querySelectorAll('#vb-container .card')).map(card => {
            const oid  = card.querySelector('.vb-oid')?.value || '';
            const type = card.querySelector('.vb-type')?.value || '';
            const val  = card.querySelector('.vb-val')?.value || '';
            return `${oid}|${type}|${val}`;
        }).join('\n');
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

        this._lastLoadedTrapName   = trap.full_name || trap.oid || '';
        this._lastLoadedSignature  = this._trapFormSignature();

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
        if (normalized.includes('counter64')) {
            return 'Counter64';
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
        if (normalized.includes('objectidentifier') || normalized.includes('autonomoustype') || normalized === 'oid') {
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

    // TRP-19: which varbind types are bound by which constraint kind. Counter,
    // Gauge, TimeTicks and Counter64 are numeric like Integer (range bounds);
    // OID values are strings of arcs (size bounds) — not just Integer/String.
    _isNumericVarbindType: function(type) {
        return ['Integer', 'Counter', 'Counter64', 'Gauge', 'TimeTicks'].indexOf(String(type || '').trim()) !== -1;
    },

    _isSizedVarbindType: function(type) {
        return ['String', 'OID'].indexOf(String(type || '').trim()) !== -1;
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

        // TRP-05: no free-form "custom" option — enum rows must hold a declared
        // member. A non-member value (e.g. restored from a stale send) falls
        // back to the placeholder and fails the required-value validation.
        if (currentValue && !matched) {
            select.value = '';
        }

        return select;
    },

    renderConstraintHint: function(row, type, constraint) {
        row.querySelectorAll('.vb-constraint-hint').forEach(el => el.remove());
        const applicable = constraint && (
            (this._isNumericVarbindType(type) && constraint.kind === 'range')
            || (this._isSizedVarbindType(type) && constraint.kind === 'size')
        );
        const hint = applicable ? this.formatConstraintHint(constraint) : '';
        if (!hint) return;
        const hintEl = document.createElement('div');
        hintEl.className = 'small text-muted mt-1 vb-constraint-hint';
        hintEl.textContent = this._isNumericVarbindType(type) ? `Range: ${hint}` : `Length: ${hint}`;
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
                        <button class="btn btn-app-danger-outline btn-icon" type="button" aria-label="Remove varbind" onclick="TrapsModule.removeVarbind('${id}')"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="input-group input-group-sm">
                        <select class="form-select vb-type app-max-w-120" aria-label="VarBind type">
                            <option value="String"     ${resolvedType==='String'    ?'selected':''}>String</option>
                            <option value="Integer"    ${resolvedType==='Integer'   ?'selected':''}>Integer</option>
                            <option value="OID"        ${resolvedType==='OID'       ?'selected':''}>OID</option>
                            <option value="TimeTicks"  ${resolvedType==='TimeTicks' ?'selected':''}>TimeTicks</option>
                            <option value="IpAddress"  ${resolvedType==='IpAddress' ?'selected':''}>IpAddress</option>
                            <option value="Counter"    ${resolvedType==='Counter'    ?'selected':''}>Counter</option>
                            <option value="Counter64"  ${resolvedType==='Counter64'  ?'selected':''}>Counter64</option>
                            <option value="Gauge"      ${resolvedType==='Gauge'      ?'selected':''}>Gauge</option>
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
        const enumValues = this.enumValuesForRow(row);
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
        } else if (type === 'Integer' && Array.isArray(enumValues) && enumValues.length > 0
                   && !enumValues.some(ev => String(ev.value) === value)) {
            // TRP-05: enum rows only accept declared members.
            message = 'Value must be one of the declared enum values.';
        } else if ((type === 'Counter' || type === 'Counter64' || type === 'Gauge' || type === 'TimeTicks') && !/^\d+$/.test(value)) {
            message = `${type} values must be zero or greater integers.`;
        } else if (type === 'OID' && !this.isOidReference(value)) {
            message = 'OID values must be dotted numeric with at least two arcs or MODULE::symbol.';
        } else if (type === 'IpAddress' && !/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value)) {
            message = 'IP address values must be valid IPv4 addresses.';
        } else if (this._isNumericVarbindType(type) && constraint && constraint.kind === 'range' && !this.isIntegerInRange(value, constraint)) {
            message = `${type} values must be within range: ${this.formatConstraintHint(constraint)}.`;
        } else if (this._isSizedVarbindType(type) && constraint && constraint.kind === 'size' && !this.isStringWithinSize(value, constraint)) {
            message = `${type} length must be within: ${this.formatConstraintHint(constraint)}.`;
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

        this._lastLoadedTrapName  = '';
        this._lastLoadedSignature = '';
        
        this.addVarbind("SNMPv2-MIB::sysUpTime.0", "TimeTicks", "0");
        this.hideSenderError();
        this.hideSenderResult();
    },

    // ==================== Trap Sending ====================

    // Readable error text from a failed API response: handles FastAPI's 422
    // validation detail (a list of {loc,msg,type}) and plain detail strings so
    // errors never render as "[object Object]" (TRP-03).
    _extractApiError: async function(res) {
        try {
            const data = await res.json();
            const detail = data && data.detail;
            if (typeof detail === 'string' && detail) return detail;
            if (Array.isArray(detail)) {
                const msgs = detail
                    .map(entry => (entry && typeof entry.msg === 'string') ? entry.msg : '')
                    .filter(Boolean);
                if (msgs.length) return msgs.join('; ');
            }
        } catch (_) {
            // fall through to status fallback
        }
        return `Request failed (HTTP ${res.status})`;
    },

    sendTrap: async function(e) {
        e.preventDefault();
        this.hideSenderError();
        this.hideSenderResult();
        
        const trapOid = document.getElementById("ts-oid").value.trim();
        if (!trapOid) {
            this.showSenderError('Please enter a notification OID or select one from the trap library');
            return;
        }

        // TRP-06: "Send as Inform" waits for the receiver's acknowledgement.
        const asInform = Boolean(document.getElementById('ts-inform-toggle')?.checked);
        
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

        // TRP-18: scroll the first invalid row into view inside the scrollable
        // varbind panel, and pull the error banner (now above the panel) into
        // view, so a long varbind list can't hide the failure.
        const invalidIndex = validatedRows.findIndex(entry => (entry.oid && entry.value) && !entry.valid);
        if (invalidIndex !== -1) {
            const invalidRowEl = varbindRows[invalidIndex];
            if (invalidRowEl && typeof invalidRowEl.scrollIntoView === 'function') {
                invalidRowEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
            this.showSenderError(`Trap send failed: ${validatedRows[invalidIndex].message}`);
            const errorEl = document.getElementById('ts-error');
            if (errorEl && typeof errorEl.scrollIntoView === 'function') {
                errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
            return;
        }

        const skippedRows = validatedRows.filter(entry => (entry.oid && !entry.value) || (!entry.oid && entry.value) || entry.empty).length;
        
        const btn          = document.getElementById('btn-send-trap');
        const originalText = btn.innerHTML;
        btn.disabled       = true;
        btn.innerHTML      = asInform
            ? '<i class="fas fa-spinner fa-spin"></i> Sending inform...'
            : '<i class="fas fa-spinner fa-spin"></i> Sending...';

        try {
            let resolvedTrapOid = trapOid;
            
            if (trapOid.includes("::")) {
                const trapRes  = await fetch(`/api/mibs/resolve?oid=${encodeURIComponent(trapOid)}&mode=numeric`);
                if (!trapRes.ok) {
                    throw new Error(`Failed to resolve trap OID ${trapOid}: ${await this._extractApiError(trapRes)}`);
                }
                const trapData = await trapRes.json();
                if (!trapData || !trapData.output) {
                    throw new Error(`Failed to resolve trap OID ${trapOid}: no numeric output`);
                }
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
                    if (!vbRes.ok) {
                        throw new Error(`Failed to resolve varbind OID ${oid}: ${await this._extractApiError(vbRes)}`);
                    }
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

            const res = await fetch(asInform ? '/api/traps/send-inform' : '/api/traps/send', {
                method:  'POST',
                headers: {'Content-Type': 'application/json'},
                body:    JSON.stringify(payload)
            });
            
            if (res.ok) {
                const data = await res.json();
                const skippedSuffix = skippedRows > 0 ? ` (${skippedRows} blank/incomplete VarBind row${skippedRows === 1 ? '' : 's'} skipped)` : '';
                if (asInform) {
                    const ackCode = data.response && typeof data.response.error_status_code === 'number'
                        ? data.response.error_status_code
                        : 0;
                    if (ackCode === 0) {
                        const requestLabel = data.request_id != null ? ` (request ${data.request_id})` : '';
                        this.showSenderResult(`Inform acknowledged by ${data.target}:${data.port}${requestLabel}${skippedSuffix}`);
                    } else {
                        const statusLabel = data.response && data.response.error_status
                            ? data.response.error_status
                            : `error_status_code ${ackCode}`;
                        this.showSenderError(`Inform delivered, but the receiver returned: ${statusLabel}`);
                    }
                } else {
                    this.showSenderResult(`Trap sent to ${data.target}:${data.port}${skippedSuffix}`);
                }
                // WS trap push will update the table if target is local;
                // no manual setTimeout reload needed.
            } else {
                const errorMsg = await this._extractApiError(res);
                this.showSenderError(asInform
                    ? `Inform failed (not acknowledged): ${errorMsg}`
                    : `Trap send failed: ${errorMsg}`);
            }
        } catch (e) {
            console.error('[TRAP] Send error:', e);
            const prefix = (e instanceof TypeError) ? 'Connection failed: ' : (asInform ? 'Inform failed: ' : 'Trap send failed: ');
            this.showSenderError(`${prefix}${e.message}`);
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
            // Cache uptime_seconds for updateMetrics() and tick it locally
            // between status payloads (RCV-07).
            this._receiverUptime = status.uptime_seconds != null ? status.uptime_seconds : null;
            this._startUptimeTicker(this._receiverUptime);
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
            this._stopUptimeTicker();
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
        try {
            const res  = await fetch('/api/traps/stop', {method:'POST'});
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || 'Trap receiver failed to stop');
            }
            this.updateStatusUI({
                running: false,
                resolve_mibs: document.getElementById("tr-resolve-toggle")?.checked,
            });
            await this.checkStatus();
            this.showNotification('Trap receiver stopped', 'info');
        } catch (e) {
            console.error('Trap receiver stop failed:', e);
            this.showNotification(`Trap receiver failed: ${e.message}`, 'error');
        }
    },

    // ==================== Metrics ====================

    updateMetrics: function() {
        const totalEl   = document.getElementById('tr-metric-total');
        const lastEl    = document.getElementById('tr-metric-last');
        const sourceEl  = document.getElementById('tr-metric-source');
        const uptimeEl  = document.getElementById('tr-metric-uptime');
        
        if (!totalEl) return;
        
        // RCV-11: "Total Traps" is the persisted total — the same value the
        // pager's "of N traps" shows — not the session list length (which can
        // be a filtered slice or a single page). Before the first fetch there
        // is no persisted total yet; fall back to the loaded session list.
        const persistedTotal = this._trapTotal != null ? this._trapTotal : this.receivedTraps.length;
        totalEl.textContent = persistedTotal;
        
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
        const limit = this._trapLimit || 100;
        const offset = this._trapOffset || 0;
        try {
            const res  = await fetch(`/api/traps/?limit=${limit}&offset=${offset}`);
            if (!res.ok) throw new Error(`Traps request failed: HTTP ${res.status}`);
            const json = await res.json();
            if (requestSeq !== this._trapFetchSeq) return;

            // Server list is authoritative (RCV-03): the listener persists each
            // event to the DB before broadcasting it, so the REST response is
            // never missing a live trap. Replacing — not merging — also stops
            // deleted events from resurrecting after Reset Stats / Clear.
            const nextList = (json.data || [])
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, limit);
            const nextTotal = typeof json.total === 'number' ? json.total : nextList.length;

            // RCV-02: skip the full tbody re-render when the payload is
            // unchanged — the WS-down fallback poll would otherwise rebuild
            // the DOM every second for no visible difference.
            const changed = this._trapsSignature(nextList) !== this._trapsSignature(this.receivedTraps)
                || nextTotal !== this._trapTotal;

            this.receivedTraps = nextList;
            this._trapTotal = nextTotal;

            if (changed) {
                this.persistTraps();
                if (this.hasActiveTrapFilter()) {
                    this.filterTraps();
                } else {
                    this.renderTraps();
                }
            }
            this.updateMetrics();
            this.updatePager();

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

    // TRP-17: badge tone follows a known severity/status vocabulary with
    // whole-token matching (camelCase + separator boundaries). A bare substring
    // heuristic paints "warmup"/"group"/"startup" green via 'up'; token
    // matching keeps those neutral. Unknown names default to neutral.
    _trapBadgeTone: function(trapType) {
        const tokens = String(trapType || '')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[^A-Za-z0-9]+/)
            .map(t => t.toLowerCase())
            .filter(Boolean);
        const success = ['up', 'linkup', 'start', 'started', 'running', 'ok', 'recovered', 'recovery', 'cleared', 'enabled', 'normal', 'online'];
        const danger = ['down', 'linkdown', 'error', 'critical', 'fault', 'shutdown', 'stopped', 'disabled', 'offline'];
        const warning = ['auth', 'authentication', 'authenticationfailure', 'failure', 'failed', 'warning', 'degraded', 'rejected', 'denied'];
        // Danger/warning outrank success: "linkUpFailure" must never paint
        // green off its "up" token.
        if (tokens.some(t => danger.indexOf(t) !== -1)) return 'danger';
        if (tokens.some(t => warning.indexOf(t) !== -1)) return 'warning';
        if (tokens.some(t => success.indexOf(t) !== -1)) return 'success';
        return 'neutral';
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
        
        tbody.innerHTML = trapsToShow.map(t => {
            const trapKey = this.getTrapKey(t);
            const trapType = t.trap_type || 'Unknown';
            // TRP-17: vocabulary-based tone — whole-token matching, neutral default.
            const tone = this._trapBadgeTone(trapType);
            const trapBadgeClass = tone === 'success' ? 'app-badge is-success'
                : tone === 'danger' ? 'app-badge is-danger'
                : tone === 'warning' ? 'app-badge is-warning'
                : 'app-badge is-neutral';
            
            // NOTE: All buttons MUST have type="button" explicitly.
            // Default <button> type is "submit" which would trigger the Send Trap
            // <form onsubmit=...> and navigate the SPA back to the dashboard.
            // Actions are keyed by the stable trap key (id), never the render
            // index — the visible list can change between render and click (RCV-10).
            return `
                <tr>
                    <td class="small text-muted" title="${esc(t.timestamp || '')}">${esc(t.time_str)}</td>
                    <td><code class="small">${esc(t.source)}</code></td>
                    <td>
                        <span class="badge ${trapBadgeClass}">${esc(trapType)}</span>
                    </td>
                    <td>
                        <div class="cursor-pointer app-trap-detail-trigger"
                              data-trap-key="${esc(trapKey)}"
                              title="Click to view full details">
                            ${this.renderVarbindRows(t.varbinds, t.resolved)}
                        </div>
                    </td>
                    <td class="text-center">
                        <div class="trap-action-buttons">
                            <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-1"
                                    data-trap-action="replay" data-trap-key="${esc(trapKey)}" title="Replay trap" aria-label="Replay trap">
                                <i class="fas fa-reply"></i>
                            </button>
                            <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-1"
                                    data-trap-action="copy" data-trap-key="${esc(trapKey)}" title="Copy JSON" aria-label="Copy JSON">
                                <i class="fas fa-copy"></i>
                            </button>
                            <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-1"
                                    data-trap-action="download" data-trap-key="${esc(trapKey)}" title="Download" aria-label="Download trap">
                                <i class="fas fa-download"></i>
                            </button>
                            <button type="button" class="btn btn-sm btn-app-danger-outline btn-icon py-0 px-1"
                                    data-trap-action="delete" data-trap-key="${esc(trapKey)}" title="Delete trap" aria-label="Delete trap">
                                <i class="fas fa-trash"></i>
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

    // Resolve the trap a row action refers to via its stable key (id), so a
    // list mutation between render and click can never target the wrong row.
    // The delegated pattern extends to the replay modal's submit/cancel and the
    // per-trap delete confirm (RCV-10, TRP-07, RCV-12).
    _handleTrapRowAction: function(event) {
        if (!event.target || typeof event.target.closest !== 'function') return;
        const trigger = event.target.closest('[data-trap-key]');
        if (!trigger) return;
        const trapKey = trigger.getAttribute('data-trap-key') || '';
        if (!trapKey) return;
        const action = trigger.getAttribute('data-trap-action') || 'detail';
        if (action === 'copy') {
            this.copyTrap(trapKey);
        } else if (action === 'download') {
            this.downloadTrap(trapKey);
        } else if (action === 'replay') {
            this.showReplayModal(trapKey);
        } else if (action === 'replay-submit') {
            this.submitReplay(trapKey);
        } else if (action === 'delete') {
            this.deleteTrap(trapKey);
        } else {
            this.showTrapDetails(trapKey);
        }
    },

    _findTrapByKey: function(trapKey) {
        const key = String(trapKey || '');
        if (!key) return null;
        return this.getVisibleTraps().find(t => this.getTrapKey(t) === key) || null;
    },

    copyModalJson: function(modalId) {
        const json = this._modalJson[modalId];
        if (!json) return;
        navigator.clipboard.writeText(json)
            .then(()  => this.showNotification('Copied!', 'success'))
            .catch(()  => this.showNotification('Copy failed', 'error'));
    },

    showTrapDetails: function(trapKey) {
        const trap = this._findTrapByKey(trapKey);
        if (!trap) {
            this.showNotification('Trap no longer in the list', 'warning');
            return;
        }
        const esc = TrishulUtils.escapeHtml;
        const simplifiedVarbinds = this.simplifyVarbinds(trap.varbinds, trap.resolved);

        // TRP-14: the snmpTrapOID projection is aligned across the table badge,
        // the formatted header row, and the raw JSON block.
        const snmpTrapOID = this._extractSnmpTrapOid(trap) || trap.trap_type || '--';

        const displayTrap = {
            timestamp:  trap.timestamp,
            time:       trap.time_str,
            source:     trap.source,
            trap_type:  trap.trap_type,
            snmpTrapOID: snmpTrapOID,
            varbinds:   simplifiedVarbinds,
            resolved:   trap.resolved
        };

        const json    = JSON.stringify(displayTrap, null, 2);
        const modalId = `trap-detail-modal-${Date.now()}`;
        this._modalJson[modalId] = json;

        const modal   = document.createElement('div');
        modal.className = 'modal fade';
        modal.id        = modalId;
        // Focusable modal root: bootstrap 5 focuses the .modal element on
        // show() — without tabindex="-1" a div cannot receive that focus, so
        // Escape-to-close (keydown on the modal) never reaches the handler
        // until the user clicks inside the dialog first.
        modal.tabIndex  = -1;
        const titleId   = `${modalId}-title`;
        const formattedId = `${modalId}-formatted`;
        const rawId = `${modalId}-raw`;
        modal.setAttribute('aria-labelledby', titleId);
        const escapedJson = esc(json);
        modal.innerHTML = `
            <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="${titleId}">Trap Details</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-2">
                            <div class="d-flex align-items-center gap-2 flex-wrap small">
                                <span class="badge app-badge is-info">${esc(trap.trap_type || '--')}</span>
                                <span class="text-muted">snmpTrapOID</span>
                                <code class="small">${esc(snmpTrapOID)}</code>
                            </div>
                        </div>
                        <div class="btn-group btn-group-sm mb-2" role="group" aria-label="Trap detail view">
                            <button type="button" class="btn btn-app-primary active" data-detail-view="formatted"
                                    aria-pressed="true"
                                    onclick="TrapsModule.setDetailView('${modalId}', 'formatted')">
                                <i class="fas fa-table"></i> Formatted
                            </button>
                            <button type="button" class="btn btn-app-secondary" data-detail-view="raw"
                                    aria-pressed="false"
                                    onclick="TrapsModule.setDetailView('${modalId}', 'raw')">
                                <i class="fas fa-code"></i> Raw JSON
                            </button>
                        </div>
                        <div id="${formattedId}" class="trap-detail-formatted">
                            ${this.renderDetailVarbindTable(trap.varbinds, trap.resolved)}
                        </div>
                        <div id="${rawId}" class="trap-detail-raw d-none">
                            <div class="text-muted fw-bold small mb-2">Raw JSON</div>
                            <pre class="app-code-pane app-scroll-panel p-3 rounded app-max-h-500">${escapedJson}</pre>
                        </div>
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

    // Value of the snmpTrapOID varbind (1.3.6.1.6.3.1.1.4.1.0) from a trap's
    // formatted varbinds; returns '' when absent so callers can fall back.
    _extractSnmpTrapOid: function(trap) {
        const rows = Array.isArray(trap && trap.varbinds) ? trap.varbinds : [];
        for (const vb of rows) {
            if (!vb) continue;
            if (String(vb.oid || '').includes('1.3.6.1.6.3.1.1.4.1.0')
                || String(vb.name || '').toLowerCase().includes('snmptrapoid')) {
                return vb.value != null ? String(vb.value) : '';
            }
        }
        return '';
    },

    // Formatted <-> Raw JSON toggle inside the detail modal (TRP-14).
    setDetailView: function(modalId, view) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        const formatted = modal.querySelector('.trap-detail-formatted');
        const raw = modal.querySelector('.trap-detail-raw');
        const showRaw = view === 'raw';
        if (formatted) formatted.classList.toggle('d-none', showRaw);
        if (raw) raw.classList.toggle('d-none', !showRaw);
        modal.querySelectorAll('[data-detail-view]').forEach(btn => {
            const isActive = btn.getAttribute('data-detail-view') === view;
            btn.classList.toggle('btn-app-primary', isActive);
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('btn-app-secondary', !isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    },

    copyTrap: function(trapKey) {
        const trap = this._findTrapByKey(trapKey);
        if (!trap) {
            this.showNotification('Trap no longer in the list', 'warning');
            return;
        }
        const simplifiedVarbinds = this.simplifyVarbinds(trap.varbinds, trap.resolved);
        
        const displayTrap = {
            timestamp:  trap.timestamp,
            time:       trap.time_str,
            source:     trap.source,
            trap_type:  trap.trap_type,
            snmpTrapOID: this._extractSnmpTrapOid(trap) || trap.trap_type || '',
            varbinds:   simplifiedVarbinds,
            resolved:   trap.resolved
        };
        
        const json = JSON.stringify(displayTrap, null, 2);
        navigator.clipboard.writeText(json)
            .then(()  => this.showNotification('Trap copied to clipboard', 'success'))
            .catch(()  => this.showNotification('Copy failed — check clipboard permissions', 'error'));
    },

    downloadTrap: function(trapKey) {
        const trap = this._findTrapByKey(trapKey);
        if (!trap) {
            this.showNotification('Trap no longer in the list', 'warning');
            return;
        }
        const simplifiedVarbinds = this.simplifyVarbinds(trap.varbinds, trap.resolved);
        
        const displayTrap = {
            timestamp:  trap.timestamp,
            time:       trap.time_str,
            source:     trap.source,
            trap_type:  trap.trap_type,
            snmpTrapOID: this._extractSnmpTrapOid(trap) || trap.trap_type || '',
            varbinds:   simplifiedVarbinds,
            resolved:   trap.resolved
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
        // RCV-14: clearing the store must reset the pager state too — a stale
        // offset/total would page an empty list and resurrect phantom pages.
        this._trapOffset = 0;
        this._trapTotal = 0;
        this.persistTraps();
        this.renderTraps();
        this.updateMetrics();
        this.updatePager();
        this.showNotification('All traps cleared', 'info');
    },

    // ==================== Replay (TRP-07) ====================

    // Modal with host/port/community overrides prefilled from the recorded
    // event: source host, SNMP default port, recorded community.
    showReplayModal: function(trapKey) {
        const trap = this._findTrapByKey(trapKey);
        if (!trap) {
            this.showNotification('Trap no longer in the list', 'warning');
            return;
        }
        this._replayTargetKey = trapKey;
        const esc = TrishulUtils.escapeHtml;

        const sourceHost = String(trap.source || '').split(':')[0] || '127.0.0.1';
        // RCV-15: list payloads carry a mask, never the recorded community; the
        // server applies the stored value when the override is left blank.
        const recordedCommunity = String(trap.community || '').trim();
        const defaultCommunity = this._isMaskedCommunity(recordedCommunity) || !recordedCommunity
            ? this.COMMUNITY_MASK
            : recordedCommunity;
        const modalId = `trap-replay-modal-${Date.now()}`;
        const titleId = `${modalId}-title`;

        const modal = document.createElement('div');
        modal.className = 'modal fade trap-replay-modal';
        modal.id = modalId;
        // tabindex="-1": makes the modal focusable so bootstrap focuses it
        // on show() — Escape then closes it without an interior click first.
        modal.tabIndex = -1;
        modal.setAttribute('aria-labelledby', titleId);
        modal.innerHTML = `
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="${titleId}">Replay Trap</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div class="text-muted small mb-3">
                            Re-send the stored event <code>${esc(trap.trap_type || '--')}</code> received from
                            <code>${esc(trap.source || '--')}</code>. The target defaults to the recorded values.
                        </div>
                        <div class="row g-2 mb-2">
                            <div class="col-md-6">
                                <label class="form-label small fw-bold" for="${modalId}-host">Target IP</label>
                                <input type="text" id="${modalId}-host" class="form-control form-control-sm rp-host"
                                       value="${esc(sourceHost)}" autocomplete="off">
                            </div>
                            <div class="col-md-3">
                                <label class="form-label small fw-bold" for="${modalId}-port">Port</label>
                                <input type="number" id="${modalId}-port" class="form-control form-control-sm rp-port"
                                       value="162" min="1" max="65535">
                            </div>
                            <div class="col-md-3">
                                <label class="form-label small fw-bold" for="${modalId}-community">Community</label>
                                <input type="text" id="${modalId}-community" class="form-control form-control-sm rp-community"
                                       value="${esc(defaultCommunity)}" autocomplete="off">
                                <div class="form-text small">The recorded value is used unless you override it.</div>
                            </div>
                        </div>
                        <div class="app-status-text is-error small d-none rp-feedback" role="alert"></div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-app-secondary-solid" data-bs-dismiss="modal">Cancel</button>
                        <button type="button" class="btn btn-sm btn-app-primary"
                                data-trap-action="replay-submit" data-trap-key="${esc(trapKey)}">
                            <i class="fas fa-reply"></i> Replay
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => {
            if (this._replayTargetKey === trapKey) this._replayTargetKey = null;
            modal.remove();
        });
    },

    submitReplay: async function(trapKey) {
        const trap = this._findTrapByKey(trapKey);
        if (!trap) {
            this.showNotification('Trap no longer in the list', 'warning');
            return;
        }
        const id = trap.id != null ? String(trap.id) : '';
        if (!id) {
            this.showNotification('This trap cannot be replayed (no id)', 'warning');
            return;
        }
        const modal = document.querySelector('.trap-replay-modal');
        const feedback = modal ? modal.querySelector('.rp-feedback') : null;
        const showFeedback = (message) => {
            if (feedback) {
                feedback.textContent = message;
                feedback.classList.toggle('d-none', !message);
            }
        };

        const host = modal ? (modal.querySelector('.rp-host').value || '').trim() : '';
        const port = modal ? parseInt(modal.querySelector('.rp-port').value, 10) : NaN;
        // RCV-15: an untouched mask means "use the recorded value" — send null
        // so the server applies the stored community instead of the placeholder.
        let community = modal ? (modal.querySelector('.rp-community').value || '').trim() : '';
        if (this._isMaskedCommunity(community)) community = null;

        if (!host) {
            showFeedback('A target host is required.');
            return;
        }
        if (!(port >= 1 && port <= 65535)) {
            showFeedback('Port must be between 1 and 65535.');
            return;
        }

        const submitBtn = modal ? modal.querySelector('[data-trap-action="replay-submit"]') : null;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Replaying...';
        }
        try {
            const res = await fetch(`/api/traps/replay/${encodeURIComponent(id)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, community }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || `Replay failed (HTTP ${res.status})`);
            }
            const target = data.target || {};
            const op = data.operation === 'inform' ? 'Inform' : 'Trap';
            let message = `${op} replayed to ${target.host || host}:${target.port || port}`;
            if (data.response) {
                message += data.response.error_status_code === 0
                    ? ' — acknowledged.'
                    : ` — receiver returned ${data.response.error_status || data.response.error_status_code}.`;
            }
            const modalInstance = modal ? bootstrap.Modal.getInstance(modal) : null;
            if (modalInstance) modalInstance.hide();
            this.showNotification(message, 'success');
        } catch (e) {
            console.error('[TRAP] Replay error:', e);
            showFeedback(e.message || 'Replay failed');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-reply"></i> Replay';
            }
        }
    },

    // ==================== Offline Decode (TRP-08) ====================

    showDecodeModal: function() {
        const modalId = `trap-decode-modal-${Date.now()}`;
        const titleId = `${modalId}-title`;
        const modal = document.createElement('div');
        modal.className = 'modal fade';
        modal.id = modalId;
        // tabindex="-1": makes the modal focusable so bootstrap focuses it
        // on show() — Escape then closes it without an interior click first.
        modal.tabIndex = -1;
        modal.setAttribute('aria-labelledby', titleId);
        modal.innerHTML = `
            <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="${titleId}">Decode Trap Payload</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-2">
                            <label class="form-label small fw-bold" for="${modalId}-payload">Payload</label>
                            <textarea id="${modalId}-payload" class="form-control form-control-sm dc-payload app-code-pane"
                                      rows="5" placeholder="Paste the hex or base64 notification payload here..."></textarea>
                        </div>
                        <div class="row g-2 mb-3">
                            <div class="col-md-4">
                                <label class="form-label small fw-bold" for="${modalId}-encoding">Encoding</label>
                                <select id="${modalId}-encoding" class="form-select form-select-sm dc-encoding">
                                    <option value="hex">Hex</option>
                                    <option value="base64">Base64</option>
                                </select>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label small fw-bold" for="${modalId}-source-host">Source host (optional)</label>
                                <input type="text" id="${modalId}-source-host" class="form-control form-control-sm dc-source-host"
                                       placeholder="127.0.0.1" autocomplete="off">
                            </div>
                            <div class="col-md-4">
                                <label class="form-label small fw-bold" for="${modalId}-source-port">Source port (optional)</label>
                                <input type="number" id="${modalId}-source-port" class="form-control form-control-sm dc-source-port"
                                       min="1" max="65535" placeholder="1162">
                            </div>
                        </div>
                        <div class="app-status-text is-error small d-none mb-2 dc-feedback" role="alert"></div>
                        <div class="dc-result"></div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-app-secondary-solid" data-bs-dismiss="modal">Close</button>
                        <button type="button" class="btn btn-sm btn-app-primary dc-submit">
                            <i class="fas fa-code"></i> Decode
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.dc-submit').addEventListener('click', () => this.submitDecode(modal));
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => modal.remove());
    },

    submitDecode: async function(modal) {
        if (!modal) return;
        const payload = (modal.querySelector('.dc-payload').value || '').trim();
        const encoding = modal.querySelector('.dc-encoding').value || 'hex';
        const sourceHost = (modal.querySelector('.dc-source-host').value || '').trim() || null;
        const sourcePortRaw = modal.querySelector('.dc-source-port').value;
        const sourcePort = sourcePortRaw ? parseInt(sourcePortRaw, 10) : null;
        const feedback = modal.querySelector('.dc-feedback');
        const resultEl = modal.querySelector('.dc-result');

        const showFeedback = (message) => {
            if (feedback) {
                feedback.textContent = message;
                feedback.classList.toggle('d-none', !message);
            }
        };

        if (!payload) {
            showFeedback('Paste a payload to decode.');
            return;
        }
        if (sourcePort != null && !(sourcePort >= 1 && sourcePort <= 65535)) {
            showFeedback('Source port must be between 1 and 65535.');
            return;
        }

        const submitBtn = modal.querySelector('.dc-submit');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Decoding...';
        }
        try {
            const res = await fetch('/api/traps/decode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    payload,
                    encoding,
                    source_host: sourceHost,
                    source_port: sourcePort,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || `Decode failed (HTTP ${res.status})`);
            }
            showFeedback('');
            if (resultEl) resultEl.innerHTML = this.renderDecodedEvent(data.event);
        } catch (e) {
            console.error('[TRAP] Decode error:', e);
            if (resultEl) resultEl.innerHTML = '';
            showFeedback(e.message || 'Decode failed');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-code"></i> Decode';
            }
        }
    },

    renderDecodedEvent: function(event) {
        const esc = TrishulUtils.escapeHtml;
        if (!event || typeof event !== 'object') {
            return '<div class="text-muted small">No decoded event returned.</div>';
        }
        const source = event.source_address
            ? `${event.source_address.host || '--'}:${event.source_address.port || '--'}`
            : '--';
        const notification = event.notification_name || event.notification_oid || '--';
        const varbinds = Array.isArray(event.varbinds) ? event.varbinds : [];
        const rows = varbinds.map(vb => {
            const key = vb.symbolic || vb.oid || '';
            const rawVal = vb.value;
            const value = rawVal && typeof rawVal === 'object' && rawVal.display != null
                ? rawVal.display
                : (vb.display_value != null ? vb.display_value : (rawVal != null ? String(rawVal) : ''));
            const enumLabel = String(vb.enum_label || '').trim();
            const units = String(vb.units || '').trim();
            return `<tr><td><code class="small">${esc(key)}</code></td><td>${esc(value)}` +
                (enumLabel ? ` <span class="badge app-badge is-info app-value-enum-badge">${esc(enumLabel)}</span>` : '') +
                (units ? ` <span class="app-value-units">${esc(units)}</span>` : '') +
                `</td></tr>`;
        }).join('');

        return `
            <div class="small mb-2">
                <div class="d-flex flex-wrap gap-2 align-items-center">
                    <span class="badge app-badge is-info">${esc(notification)}</span>
                    <span class="text-muted">${esc(event.pdu_type || '')}</span>
                    <span class="text-muted">community: <code>${esc(event.community || '--')}</code></span>
                    <span class="text-muted">from <code>${esc(source)}</code></span>
                    ${event.uptime != null ? `<span class="text-muted">uptime: <code>${esc(String(event.uptime))}</code></span>` : ''}
                </div>
            </div>
            <div class="mb-2">
                <div class="text-muted fw-bold small mb-2">VarBinds</div>
                <table class="table table-sm table-hover mb-0 small">
                    <thead class="table-light"><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="2" class="text-muted">No varbinds.</td></tr>'}</tbody>
                </table>
            </div>
        `;
    },

    // ==================== CSV Export + Live Pause (TRP-21) ====================

    // Exports the current view (active filter + page) as CSV.
    exportTrapsCsv: function() {
        const traps = this.getVisibleTraps();
        if (!traps.length) {
            this.showNotification('No traps to export', 'warning');
            return;
        }
        const escapeCell = (value) => {
            const text = value == null ? '' : String(value);
            return `"${text.replace(/"/g, '""')}"`;
        };
        const header = ['timestamp', 'time', 'source', 'community', 'trap_type', 'varbinds'];
        const lines = [header.join(',')];
        traps.forEach(t => {
            const varbinds = (Array.isArray(t.varbinds) ? t.varbinds : [])
                .map(vb => `${vb.name || vb.oid || ''}=${vb.value == null ? '' : vb.value}`)
                .join('; ');
            // RCV-15: the export never carries the real community string — the
            // mask (or nothing) is all that leaves the page, even for legacy
            // session-cached rows that still hold the raw value.
            const community = this._isMaskedCommunity(t.community)
                ? this.COMMUNITY_MASK
                : (String(t.community || '').trim() ? this.COMMUNITY_MASK : '');
            lines.push([
                t.timestamp,
                t.time_str,
                t.source,
                community,
                t.trap_type,
                varbinds,
            ].map(escapeCell).join(','));
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `received_traps_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        this.showNotification(`Exported ${traps.length} trap${traps.length === 1 ? '' : 's'} to CSV`, 'success');
    },

    // Pause the 1s live-prepend churn while inspecting; manual Refresh still
    // works and Resume performs an immediate refresh.
    toggleLivePause: function() {
        this._livePaused = !this._livePaused;
        const btn = document.getElementById('btn-tr-pause');
        if (btn) {
            const paused = this._livePaused;
            btn.innerHTML = paused
                ? '<i class="fas fa-play"></i> Resume'
                : '<i class="fas fa-pause"></i> Pause';
            btn.classList.toggle('btn-app-secondary', !paused);
            btn.classList.toggle('btn-app-primary', paused);
            btn.title = paused ? 'Resume live updates' : 'Pause live updates';
            btn.setAttribute('aria-label', paused ? 'Resume live updates' : 'Pause live updates');
            btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
        }
        if (!this._livePaused) {
            this.loadTraps();
        }
        this.showNotification(
            this._livePaused ? 'Live updates paused — use Refresh for a manual snapshot.' : 'Live updates resumed',
            this._livePaused ? 'warning' : 'info'
        );
    },

    // ==================== Pagination (RCV-05) ====================

    pageTraps: function(direction) {
        const limit = this._trapLimit || 100;
        // RCV-14: clamp against the current total so 'older' can't step past
        // a shrunken store into an empty page — land on the last real page.
        const total = this._trapTotal || 0;
        const lastPageStart = Math.floor(Math.max(0, total - 1) / limit) * limit;
        if (direction === 'older') {
            this._trapOffset = Math.min(this._trapOffset + limit, lastPageStart);
        } else if (direction === 'newer') {
            this._trapOffset = Math.max(0, this._trapOffset - limit);
        } else {
            return;
        }
        this.loadTraps();
    },

    updatePager: function() {
        const pager = document.getElementById('tr-pager');
        if (!pager) return;
        const total = this._trapTotal || 0;
        const hasHistory = total > this._trapLimit || this._trapOffset > 0;
        if (!hasHistory) {
            pager.classList.add('d-none');
            return;
        }
        pager.classList.remove('d-none');
        const info = document.getElementById('tr-pager-info');
        if (info) {
            const shown = Math.max(0, this._trapOffset + (this.receivedTraps.length || 0));
            const page = Math.floor(this._trapOffset / this._trapLimit) + 1;
            const lastPage = Math.max(1, Math.ceil(total / this._trapLimit));
            info.textContent = `Showing ${Math.min(total, shown)} of ${total} traps · Page ${page} of ${lastPage}`;
        }
        const newerBtn = document.getElementById('btn-tr-newer');
        const olderBtn = document.getElementById('btn-tr-older');
        if (newerBtn) newerBtn.disabled = this._trapOffset <= 0;
        if (olderBtn) olderBtn.disabled = (this._trapOffset + this._trapLimit) >= total;
    },

    // ==================== Per-Trap Delete (RCV-12) ====================

    deleteTrap: async function(trapKey) {
        const trap = this._findTrapByKey(trapKey);
        if (!trap) {
            this.showNotification('Trap no longer in the list', 'warning');
            return;
        }
        const id = trap.id != null ? String(trap.id) : '';
        if (!id) {
            this.showNotification('This trap cannot be deleted (no id)', 'warning');
            return;
        }
        const confirmed = await TrishulUtils.confirmDialog({
            title: 'Delete this trap?',
            message: `Delete the received trap <code>${TrishulUtils.escapeHtml(trap.trap_type || '')}</code> from ${TrishulUtils.escapeHtml(trap.source || '--')}?`,
            confirmLabel: 'Delete',
            variant: 'danger',
        });
        if (!confirmed) return;

        try {
            const res = await fetch(`/api/traps/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || `Delete failed (HTTP ${res.status})`);
            }
            this.receivedTraps = this.receivedTraps.filter(t => this.getTrapKey(t) !== trapKey);
            this.filteredTraps = this.filteredTraps.filter(t => this.getTrapKey(t) !== trapKey);
            this._trapTotal = Math.max(0, (this._trapTotal || 0) - 1);
            this.persistTraps();
            this.renderTraps();
            this.updateMetrics();
            this.updatePager();
            this.showNotification('Trap deleted', 'info');
        } catch (e) {
            console.error('[TRAP] Delete error:', e);
            this.showNotification(`Delete failed: ${e.message}`, 'error');
        }
    },

    // ==================== Utilities ====================

    showNotification: function(message, type = 'info') {
        TrishulUtils.showNotification(message, type);
    }
};

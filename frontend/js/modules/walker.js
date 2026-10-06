window.WalkerModule = {
    lastData: null,
    lastDisplayMode: null,
    lastRawLines: null,
    lastJsonFormat: 'flat',
    walkHistory: [],
    MAX_HISTORY: 20,
    filteredData: null,
    _progressHideTimer: null,
    _activeWalkController: null,
    _sortColumn: null,
    _sortDir: 'asc',
    EMPTY_OUTPUT_HTML: '<span class="fs-2 mb-3 d-block text-center empty-state-icon"><i class="fas fa-walking"></i></span><h3 class="h6 fw-semibold d-block text-center mb-1 empty-state-title lh-base">No results yet</h3><span class="d-block text-center empty-state-copy">Configure a target and run a walk.</span>',

    init: function() { 
        this.toggleOptions();
        this.loadRecentTargets();
        this.loadWalkHistory();
        this.renderHistory();
        this.resetSort();

        // Ctrl/Cmd+Enter anywhere in the config card runs the walk; plain
        // Enter submits via the form wrapper.
        const configCard = document.getElementById('walk-config-card');
        if (configCard) {
            configCard.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.execute();
                }
            });
        }

        // Restore the form inputs that produced the cached result. Without
        // this, F5 shows the restored walk output next to default HTML input
        // values — the form would describe a different walk than the pane.
        this.restoreFormConfig();

        // Check if OID was passed from browser — the user's fresh selection
        // wins over the restored draft, and the draft follows it.
        const browserOid = sessionStorage.getItem('walkerOid');
        if (browserOid) {
            document.getElementById("walk-oid").value = browserOid;
            sessionStorage.removeItem('walkerOid');
            this.saveCurrentFormConfig();
            TrishulUtils.showNotification(`OID selected: ${browserOid}`, 'info');
        }

        // Restore last result if exists. Corrupt storage must never abort
        // page init — drop it and start from the empty state instead.
        const lastResult = sessionStorage.getItem('walkerLastResult');
        let parsed = null;
        if (lastResult) {
            try {
                parsed = JSON.parse(lastResult);
            } catch (e) {
                console.warn('Discarding unreadable walkerLastResult:', e);
            }
            if (!parsed || typeof parsed !== 'object') {
                if (lastResult) {
                    try {
                        sessionStorage.removeItem('walkerLastResult');
                    } catch (e) {
                        console.warn('Failed to remove unreadable walkerLastResult:', e);
                    }
                }
                parsed = null;
            }
        }
        if (parsed) {
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
            const timeoutInput = document.getElementById('walk-timeout');
            if (timeoutInput && Number.isFinite(parsed.timeout_ms)) {
                timeoutInput.value = parsed.timeout_ms;
            }
            const retriesInput = document.getElementById('walk-retries');
            if (retriesInput && Number.isFinite(parsed.retries)) {
                retriesInput.value = parsed.retries;
            }
            this.toggleOptions();
            this.restoreLastResult();
        }

        this.attachFormConfigDrafting();
        // Re-apply the result-search filter that was active before the
        // reload, so the restored pane matches what the user was looking at.
        this.restoreResultSearch();
    },

    /**
     * Keep the draft in sync with every keystroke so an F5 never discards
     * in-progress edits, even when no walk has been run yet.
     */
    attachFormConfigDrafting: function() {
        ['walk-target', 'walk-port', 'walk-comm', 'walk-oid'].forEach(id => {
            const el = document.getElementById(id);
            if (!el || el.dataset.draftBound === '1') return;
            el.dataset.draftBound = '1';
            el.addEventListener('input', () => this.saveCurrentFormConfig());
            el.addEventListener('change', () => this.saveCurrentFormConfig());
        });
    },

    saveCurrentFormConfig: function() {
        this.saveFormConfig(
            document.getElementById('walk-target').value,
            document.getElementById('walk-port').value,
            document.getElementById('walk-comm').value,
            document.getElementById('walk-oid').value
        );
    },

    /**
     * Form values (host/port/community/OID) survive an F5: they describe the
     * walk that produced the cached result, so they belong with it.
     */
    saveFormConfig: function(target, port, community, oid) {
        try {
            sessionStorage.setItem('walkerFormConfig', JSON.stringify({
                target: target, port: port, community: community, oid: oid
            }));
        } catch (e) {
            // Storage quota/unavailability must never break a walk.
        }
    },

    restoreFormConfig: function() {
        let config = null;
        try {
            config = JSON.parse(sessionStorage.getItem('walkerFormConfig') || 'null');
        } catch (e) {
            config = null;
        }
        if (!config || typeof config !== 'object') return;
        const setIfString = (id, value) => {
            const el = document.getElementById(id);
            if (el && typeof value === 'string' && value !== '') el.value = value;
        };
        setIfString('walk-target', config.target);
        setIfString('walk-port', config.port);
        setIfString('walk-comm', config.community);
        setIfString('walk-oid', config.oid);
    },

    /**
     * The active result-search filter is part of the view state; persist it
     * so an F5 restores the same filtered rows instead of silently showing
     * the unfiltered set.
     */
    saveResultSearch: function(term) {
        try {
            if (term) {
                sessionStorage.setItem('walkerResultSearch', term);
            } else {
                sessionStorage.removeItem('walkerResultSearch');
            }
        } catch (e) {
            // same tolerance as the other storage writes
        }
    },

    restoreResultSearch: function() {
        let term = '';
        try {
            term = String(sessionStorage.getItem('walkerResultSearch') || '');
        } catch (e) {
            term = '';
        }
        if (!term || !this.lastData) return;
        const searchInput = document.getElementById('walk-result-search');
        if (!searchInput) return;
        searchInput.value = term;
        const clearBtn = document.getElementById('btn-clear-result-search');
        if (clearBtn) clearBtn.classList.remove('d-none');
        this.filterResults();
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

        if (state === 'loading') {
            // Pane-level loading state: the progress bar lives in the config
            // card, so the results pane carries its own feedback while the
            // walk runs instead of going blank.
            output.innerHTML = TrishulUtils.buildPanelPlaceholder({
                state: 'loading',
                title: 'Walking target…',
                copy: 'Results will appear here when the walk completes.',
            });
            return;
        }

        if (state === 'cancelled') {
            output.innerHTML = TrishulUtils.buildPanelPlaceholder({
                title: 'Walk cancelled',
                copy: 'The walk was stopped before completing. Adjust the target and re-run.',
                icon: 'fa-ban',
            });
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
                // Filter-miss states use the shared placeholder pattern —
                // same component as every other panel on the page.
                return Array.isArray(this.filteredData)
                    ? TrishulUtils.buildPanelPlaceholder({
                        title: 'No matching results',
                        copy: 'No rows in this walk match the search. Adjust or clear the search to see the results again.',
                        icon: 'fa-search',
                        compact: true,
                    })
                    : TrishulUtils.buildPanelPlaceholder({
                        title: 'No results to display',
                        copy: 'Run a walk to populate this pane.',
                        icon: 'fa-walking',
                        compact: true,
                    });
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

    /**
     * Count badge reflects what is on screen: the filtered row count while a
     * search is active (info tone marks the filtered state), the walk total
     * otherwise.
     */
    updateCountBadge: function() {
        const countBadge = document.getElementById('walk-count');
        if (!countBadge) return;
        const isFiltered = Array.isArray(this.filteredData);
        const data = isFiltered ? this.filteredData : this.lastData;
        let count = 0;
        if (Array.isArray(data)) {
            count = data.length;
        } else if (data && typeof data === 'object') {
            count = Object.keys(data).length;
        }
        countBadge.className = isFiltered
            ? 'badge app-badge is-info'
            : 'badge badge-soft-light';
        countBadge.textContent = `${count} items`;
    },

    // ==================== Column Sorting ====================

    toggleSort: function(columnLabel) {
        if (this._sortColumn === columnLabel) {
            this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this._sortColumn = columnLabel;
            this._sortDir = 'asc';
        }
        this.renderData();
    },

    resetSort: function() {
        this._sortColumn = null;
        this._sortDir = 'asc';
    },

    // Sortable header cell — same pattern as the traps receiver table:
    // keyboard-operable button, aria-sort, fa-sort indicator.
    sortableTh: function(label) {
        const esc = TrishulUtils.escapeHtml;
        const active = this._sortColumn === label;
        const ariaSort = active ? (this._sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
        const icon = active ? (this._sortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down') : 'fa-sort';
        return `<th scope="col" aria-sort="${ariaSort}">` +
            `<button type="button" class="th-sort-btn bg-transparent border-0 p-0 text-reset fw-bold" ` +
            `onclick="WalkerModule.toggleSort(${esc(JSON.stringify(label))})">` +
            `${esc(label)} <i class="fas ${icon} th-sort-icon" aria-hidden="true"></i>` +
            `</button></th>`;
    },

    sortRowsForColumn: function(rows, column) {
        if (!column) return rows;
        const dir = this._sortDir === 'asc' ? 1 : -1;
        const key = column.sortGet || column.get;
        return rows.slice().sort((a, b) => {
            const av = key(a);
            const bv = key(b);
            if (typeof av === 'number' && typeof bv === 'number') {
                return (av - bv) * dir;
            }
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
        });
    },

    buildRawLineTable: function(lines) {
        const esc = TrishulUtils.escapeHtml;
        const rows = lines.map(line => {
            const text = String(line);
            const sep = text.indexOf(' = ');
            if (sep === -1) return { oid: text, value: '' };
            return { oid: text.slice(0, sep), value: text.slice(sep + 3) };
        });

        const columns = [
            { label: 'OID', get: r => r.oid },
            { label: 'Value', get: r => r.value },
        ];
        const sortedRows = this.sortRowsForColumn(rows, columns.find(c => c.label === this._sortColumn));

        return `
            <table class="table table-sm table-hover mb-0 table-dense">
                <caption class="visually-hidden">Walk results</caption>
                <thead class="table-light sticky-top">
                    <tr>
                        ${columns.map(c => this.sortableTh(c.label)).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${sortedRows.map(r => `<tr><td>${esc(r.oid)}</td><td>${esc(r.value)}</td></tr>`).join('')}
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
                {
                    label: 'OID',
                    get: r => r.symbolic || r.oid,
                    // Numeric OID on hover when a symbolic name is displayed.
                    title: r => (r.symbolic && r.oid && r.symbolic !== r.oid) ? String(r.oid) : '',
                },
                ...(hasType ? [{ label: 'Type', get: r => r.type }] : []),
                {
                    label: 'Value',
                    html: true,
                    // inline variant: muted `label(value)` token instead of the
                    // badge pill — keeps dense walker rows on a single line (WLK-19).
                    get: r => TrishulUtils.formatValue(r.value, {
                        enumLabel: r.enum_label,
                        units: r.units,
                        inline: true
                    }),
                    // sort on the raw value, not the formatted HTML cell
                    sortGet: r => r.value,
                },
            ];
        } else if (first && 'metric_name' in first) {
            columns = [
                { label: 'Metric', get: r => r.metric_name },
                { label: 'Value', get: r => r.value },
                { label: 'Module', get: r => r.mib_module },
                { label: 'Category', get: r => r.metric_category },
                { label: 'Agent', get: r => r.agent_host },
                { label: 'Timestamp', get: r => r.timestamp },
                { label: 'Labels', get: r => r.labels, sortGet: r => JSON.stringify(r.labels || {}) },
            ];
        } else {
            columns = Object.keys(first || {}).map(k => ({ label: k, get: r => r[k] }));
        }

        const cell = (r, c) => {
            const titleText = c.title ? c.title(r) : '';
            const attrs = titleText ? ` title="${esc(titleText)}"` : '';
            if (c.html) return `<td${attrs}>${c.get(r) || ''}</td>`;
            const v = c.get(r);
            if (v === null || v === undefined) return `<td${attrs}></td>`;
            return `<td${attrs}>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td>`;
        };

        const sortedRows = this.sortRowsForColumn(rows, columns.find(c => c.label === this._sortColumn));

        // cell() already returns a complete <td>…</td> element — wrapping it
        // in another <td> made the HTML parser auto-close the outer cell,
        // producing an empty ghost <td> before every real one (columns
        // misaligned, twice as many body cells as headers).
        return `
            <table class="table table-sm table-hover mb-0 table-dense">
                <caption class="visually-hidden">Walk results</caption>
                <thead class="table-light sticky-top">
                    <tr>
                        ${columns.map(c => this.sortableTh(c.label)).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${sortedRows.map(r => `<tr>${columns.map(c => cell(r, c)).join('')}</tr>`).join('')}
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

    saveWalkHistory: function(target, port, oid, result, mode, count, useMibs, jsonFormat, timeoutMs, retries) {
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
            json_format: this.normalizeJsonLayout(jsonFormat || 'flat'),
            timeout_ms: Number.isInteger(timeoutMs) ? timeoutMs : 2000,
            retries: Number.isInteger(retries) ? retries : 1
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
            // Tone carries meaning only: modes are neutral, the warning tone
            // is reserved for the degraded label-fallback output.
            const modeBadgeClass = isLabelFallback ? 'app-badge is-warning' : 'app-badge is-neutral';
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
                            <span class="badge badge-soft-light">${resultCount} items</span>
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
        const timeoutInput = document.getElementById('walk-timeout');
        if (timeoutInput && Number.isInteger(item.timeout_ms)) {
            timeoutInput.value = item.timeout_ms;
        }
        const retriesInput = document.getElementById('walk-retries');
        if (retriesInput && Number.isInteger(item.retries)) {
            retriesInput.value = item.retries;
        }
        // The loaded item's form values are now the current draft — keep the
        // F5 restore in sync with what the user is looking at.
        this.saveCurrentFormConfig();
        this.toggleOptions();
        
        // Drop any active result filter — the stale filteredData would
        // otherwise show the previous walk's rows for the loaded walk.
        this.filteredData = null;
        const searchInput = document.getElementById('walk-result-search');
        if (searchInput) searchInput.value = '';
        const clearBtn = document.getElementById("btn-clear-result-search");
        if (clearBtn) clearBtn.classList.add('d-none');
        this.saveResultSearch('');
        this.resetSort();
        
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

    execute: async function(e) {
        // Submit-event friendly: called from the form (plain Enter), from
        // Ctrl/Cmd+Enter, and from the Run button's submit.
        if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
        }
        // The disabled submit button blocks plain Enter while a walk runs,
        // but the Ctrl/Cmd+Enter path bypasses it — guard here too so a
        // second concurrent walk can't clobber the active controller.
        if (this._activeWalkController) return;
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
        const portInput = document.getElementById("walk-port").value.trim();
        const community = document.getElementById("walk-comm").value.trim() || "public";
        const oid = document.getElementById("walk-oid").value.trim();
        const parse = document.getElementById("walk-parse-toggle").checked;
        const use_mibs = document.getElementById("walk-use-mibs").checked;
        const jsonLayoutEl = document.getElementById("walk-json-layout");
        const json_format = parse
            ? this.normalizeJsonLayout(jsonLayoutEl && jsonLayoutEl.value ? jsonLayoutEl.value : 'flat')
            : 'flat';

        // Validate target (client-side, so an empty host never reaches the API)
        if (!target) {
            errorText.textContent = "Please enter a target host or IP address";
            errorEl.classList.remove('d-none');
            document.getElementById("walk-target").focus();
            return;
        }

        // Validate port (an out-of-range number would otherwise come back as
        // a raw 422 validation payload)
        let port;
        if (portInput === "") {
            port = 161;
        } else {
            port = Number(portInput);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                errorText.textContent = "Port must be a whole number between 1 and 65535";
                errorEl.classList.remove('d-none');
                document.getElementById("walk-port").focus();
                return;
            }
        }

        // Validate OID
        if (!oid) {
            errorText.textContent = "Please enter an OID or MIB name";
            errorEl.classList.remove('d-none');
            return;
        }

        // Validate timeout (WLK-10)
        const timeoutRaw = document.getElementById("walk-timeout").value.trim();
        let timeout_ms = 2000;
        if (timeoutRaw !== "") {
            timeout_ms = Number(timeoutRaw);
            if (!Number.isInteger(timeout_ms) || timeout_ms < 500 || timeout_ms > 10000) {
                errorText.textContent = "Timeout must be a whole number between 500 and 10000 ms";
                errorEl.classList.remove('d-none');
                document.getElementById("walk-timeout").focus();
                return;
            }
        }

        // Validate retries (WLK-10)
        const retriesRaw = document.getElementById("walk-retries").value.trim();
        let retries = 1;
        if (retriesRaw !== "") {
            retries = Number(retriesRaw);
            if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
                errorText.textContent = "Retries must be a whole number between 0 and 5";
                errorEl.classList.remove('d-none');
                document.getElementById("walk-retries").focus();
                return;
            }
        }

        // Basic OID/MIB format validation. The leading dot is optional — the
        // backend's numeric OID parser accepts ".1.3.6..." forms.
        const oidPattern = /^(\.?[0-9]+(\.[0-9]+)*|([A-Z][a-zA-Z0-9-]*)(::[a-zA-Z0-9-]+)*(\.[0-9]+)*)$/;
        if (!oidPattern.test(oid)) {
            errorText.textContent = "Invalid OID format. Use format like: 1.3.6.1 or IF-MIB::ifTable";
            errorEl.classList.remove('d-none');
            return;
        }

        // Save recent target
        this.saveRecentTarget(target);
        // Remember the form values that produced this walk, so an F5 does
        // not restore the result next to default inputs.
        this.saveFormConfig(target, String(port), community, oid);

        // Cancel any pending progress-bar hide from a previous run so it
        // cannot hide this walk's progress mid-flight.
        if (this._progressHideTimer) {
            clearTimeout(this._progressHideTimer);
            this._progressHideTimer = null;
        }

        // UI Loading State
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Running...';
        btn.disabled = true;
        this.setWalkButtons(true);
        this.resetSort();
        this.setOutputState('loading', '');

        // Cancellation handle for the in-flight request.
        const controller = new AbortController();
        this._activeWalkController = controller;

        // Show progress. The walk has no intermediate milestones to report, so
        // the bar runs indeterminate (animated stripes, no aria-valuenow) and
        // only real outcomes — completion count or error — are announced.
        progressEl.classList.remove('d-none');
        progressBar.style.width = '100%';
        progressBar.removeAttribute('aria-valuenow');
        progressText.textContent = `Walking ${oid}...`;
        progressCount.textContent = '';

        try {
            const res = await fetch('/api/walk/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target, port, community, oid, parse, use_mibs, json_format, timeout_ms, retries }),
                signal: controller.signal
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(this.formatApiError(data) || "Walk failed");
            }

            this.lastData = data.data;
            this.lastDisplayMode = data.mode;
            this.lastRawLines = data.rawLines || null;
            this.lastJsonFormat = this.normalizeJsonLayout(data.json_format || json_format);
            this.filteredData = null;

            // A fresh result set replaces the old view: drop any stale
            // search term so the box no longer describes rows that are gone.
            const searchInput = document.getElementById('walk-result-search');
            if (searchInput && searchInput.value !== '') {
                searchInput.value = '';
                const clearBtn = document.getElementById('btn-clear-result-search');
                if (clearBtn) clearBtn.classList.add('d-none');
            }
            this.saveResultSearch('');

            countBadge.textContent = `${data.count} items`;
            countBadge.className = 'badge badge-soft-light';
            progressCount.textContent = `${data.count} items`;
            progressBar.style.width = '100%';
            progressBar.setAttribute('aria-valuenow', '100');

            // Caching the result for reload must never turn a successful
            // walk into a failure — quota errors are logged and ignored.
            try {
                sessionStorage.setItem('walkerLastResult', JSON.stringify({
                    data: data.data,
                    mode: data.mode,
                    rawLines: data.rawLines,
                    use_mibs: use_mibs,
                    json_format: this.normalizeJsonLayout(data.json_format || json_format),
                    timeout_ms: timeout_ms,
                    retries: retries
                }));
            } catch (storageError) {
                console.warn('Failed to cache walk result for reload:', storageError);
            }

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
                timeout_ms,
                retries,
            );
            TrishulUtils.showNotification(`Walk completed: ${data.count} items`, 'success');

        } catch (e) {
            if (e && e.name === 'AbortError') {
                // User-cancelled walk: a distinct pane state, never an error.
                this.setOutputState('cancelled');
                TrishulUtils.showNotification('Walk cancelled', 'info');
                return;
            }
            console.error("Walker Error:", e);
            errorText.textContent = this.formatErrorMessage(e.message);
            errorEl.classList.remove('d-none');
            this.setOutputState('error', `Error: ${e.message}`);
            countBadge.textContent = "0 items";
            countBadge.className = 'badge badge-soft-light';
            this.lastData = null;
            this.lastDisplayMode = null;
            this.lastRawLines = null;
            this.lastJsonFormat = 'flat';
            // The failed walk must not be resurrected by a page reload.
            try {
                sessionStorage.removeItem('walkerLastResult');
            } catch (storageError) {
                console.warn('Failed to drop cached walk result:', storageError);
            }
            TrishulUtils.showNotification(e.message, 'error');
        } finally {
            this._activeWalkController = null;
            btn.innerHTML = originalText;
            btn.disabled = false;
            this.setWalkButtons(false);
            if (this._progressHideTimer) {
                clearTimeout(this._progressHideTimer);
            }
            this._progressHideTimer = setTimeout(() => {
                this._progressHideTimer = null;
                progressEl.classList.add('d-none');
                progressBar.style.width = '0%';
                progressBar.removeAttribute('aria-valuenow');
            }, 500);
        }
    },

    // ==================== Walk Cancellation ====================

    cancelWalk: function() {
        if (this._activeWalkController) {
            this._activeWalkController.abort();
        }
    },

    setWalkButtons: function(walking) {
        const runBtn = document.getElementById('btn-walk-run');
        const cancelBtn = document.getElementById('btn-walk-cancel');
        if (runBtn) runBtn.classList.toggle('d-none', walking);
        if (cancelBtn) cancelBtn.classList.toggle('d-none', !walking);
    },

    /**
     * Turn a non-OK API payload into a readable message. FastAPI/Pydantic
     * validation errors arrive as `detail` arrays of {loc, msg} objects —
     * stringifying those produced "[object Object]".
     */
    formatApiError: function(payload) {
        const detail = payload && payload.detail;
        if (detail === undefined || detail === null) {
            return payload && payload.message ? String(payload.message) : '';
        }
        if (typeof detail === 'string') {
            return detail;
        }
        if (Array.isArray(detail)) {
            return detail.map(item => {
                if (item && typeof item === 'object') {
                    const loc = Array.isArray(item.loc)
                        ? item.loc.filter(part => part !== 'body')
                        : [];
                    const message = String(item.msg || 'Invalid value');
                    return loc.length ? `${loc.join('.')}: ${message}` : message;
                }
                return String(item);
            }).join('; ');
        }
        if (typeof detail === 'object') {
            return JSON.stringify(detail);
        }
        return String(detail);
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
        this.resetSort();

        sessionStorage.removeItem('walkerLastResult');
        this.saveResultSearch('');

        this.setOutputState('empty');
        if (countBadge) {
            countBadge.textContent = "0 items";
            countBadge.className = 'badge badge-soft-light';
        }
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

        // Keep the filter across reloads — it is view state for the result.
        this.saveResultSearch(searchInput.value.trim());

        if (!this.lastData) {
            this.updateCountBadge();
            return;
        }

        if (!searchTerm) {
            this.filteredData = null;
            this.renderData();
            this.updateCountBadge();
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
            this.updateCountBadge();
        } else {
            const text = JSON.stringify(this.lastData).toLowerCase();
            this.filteredData = null;
            if (text.includes(searchTerm)) {
                this.renderData();
            } else {
                output.className = this.getOutputClass('ready');
                output.innerHTML = TrishulUtils.buildPanelPlaceholder({
                    title: 'No matching results',
                    copy: 'Nothing in this walk matches the search. Adjust or clear the search to see the results again.',
                    icon: 'fa-search',
                    compact: true,
                });
            }
            this.updateCountBadge();
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
        this.saveResultSearch('');
        this.filterResults();
    },

    restoreLastResult: function() {
        if (!this.lastData) return;

        this.updateCountBadge();
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
        // Bail while a walk is in flight or was cancelled: the pane does not
        // show the last completed walk's data in those states.
        if (!output || output.classList.contains('walk-empty')
            || this._outputState === 'loading' || this._outputState === 'cancelled') {
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

    /**
     * Copy the current result as tab-separated values — paste-ready for
     * spreadsheets. Honors an active filter like Copy and Export do.
     */
    copyAsTable: function() {
        const output = document.getElementById("walk-output");
        if (!output || output.classList.contains('walk-empty')
            || this._outputState === 'loading' || this._outputState === 'cancelled') {
            TrishulUtils.showNotification("No data to copy", "warning");
            return;
        }

        const data = Array.isArray(this.filteredData) ? this.filteredData : this.lastData;
        const rows = Array.isArray(data)
            ? data.filter(item => item && typeof item === 'object' && !Array.isArray(item))
            : [];
        if (rows.length === 0) {
            TrishulUtils.showNotification("Copy as table is only available for parsed JSON walk results.", "error");
            return;
        }

        const allKeys = new Set();
        rows.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
        const keys = Array.from(allKeys);
        const cellText = (v) => {
            if (v === null || v === undefined) return '';
            const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return text.replace(/[\t\r\n]+/g, ' ');
        };
        const tsv = [keys.join('\t')]
            .concat(rows.map(row => keys.map(k => cellText(row[k])).join('\t')))
            .join('\n');

        navigator.clipboard.writeText(tsv).then(() => {
            TrishulUtils.showNotification("Copied as table (TSV) — paste into a spreadsheet", "success");
        }).catch(() => {
            TrishulUtils.showNotification("Failed to copy", "error");
        });
    },
    
    download: function(format) {
        if (!this.lastData) {
            TrishulUtils.showNotification("No data to export", "warning");
            return;
        }

        // Honor an active filter — including a zero-match one. Silently
        // falling back to the full dataset here disagreed with Copy and
        // exported data the user could not see.
        const isFiltered = Array.isArray(this.filteredData);
        const exportData = isFiltered ? this.filteredData : this.lastData;
        if (isFiltered && exportData.length === 0) {
            TrishulUtils.showNotification("No results match your search — nothing to export", "warning");
            return;
        }
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
            content = this.formatExportText(exportData);
        }

        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `snmp_walk_${Date.now()}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
    },

    /**
     * Plain-text export rendering: object rows are serialized per line
     * instead of joining into "[object Object]".
     */
    formatExportText: function(data) {
        if (Array.isArray(data)) {
            return data
                .map(item => (item && typeof item === 'object') ? JSON.stringify(item) : String(item))
                .join("\n");
        }
        if (data && typeof data === 'object') {
            return JSON.stringify(data, null, 2);
        }
        return String(data ?? '');
    },

    destroy: function() {
        // nothing special yet
    }
};

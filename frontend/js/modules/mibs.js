window.MibsModule = {
    currentTrapData: null,
    uploadModal: null,
    failedMibsModal: null,
    trapDetailsModal: null,
    allMibs: [],
    sourceInventory: [],
    allTraps: [],
    currentStatus: null,
    validationState: null,
    selectedMibPaths: new Set(),
    deletingMibPaths: new Set(),
    // MGR-20: module names whose revision/metadata cards are expanded; keeps
    // the cards open across list re-renders (selection toggles, refreshes).
    expandedModuleMetadata: new Set(),
    _domListeners: [],
    _statusCacheValid: false,
    _trapCacheValid: false,
    _statusRequestId: 0,
    _trapRequestId: 0,
    _trapSortKey: 'name',
    _trapSortDir: 'asc',
    TRAP_ROW_CAP: 500,
    RECOMPILE_BANNER_DISMISS_KEY: 'trishul_recompile_banner_dismissed',

    buildListPlaceholder: function(options) {
        return `<li class="list-group-item border-0 bg-transparent">${TrishulUtils.buildPanelPlaceholder({
            ...options,
            compact: true,
        })}</li>`;
    },

    buildTablePlaceholderRow: function(options) {
        return `<tr><td colspan="5" class="p-0 border-0">${TrishulUtils.buildPanelPlaceholder({
            ...options,
            compact: true,
        })}</td></tr>`;
    },

    init: function() {
        this.destroy();
        this.uploadModal = new bootstrap.Modal(document.getElementById('uploadModal'));
        this.failedMibsModal = new bootstrap.Modal(document.getElementById('failedMibsModal'));
        this.trapDetailsModal = new bootstrap.Modal(document.getElementById('trapDetailsModal'));

        this.bindDomListeners();
        this.initDropzone();
        this._updateTrapSortHeaders();

        if (!this._statusCacheValid) {
            this.loadStatus();
        } else if (this.currentStatus) {
            this.applyStatusSnapshot(this.currentStatus);
        }
        if (!this._trapCacheValid) {
            this.loadTraps();
        } else {
            this.applyTrapSnapshot(this.allTraps);
        }
    },

    destroy: function() {
        this._statusRequestId += 1;
        this._trapRequestId += 1;
        this._domListeners.forEach(([element, type, handler, options]) => {
            try {
                element.removeEventListener(type, handler, options);
            } catch (_error) {}
        });
        this._domListeners = [];
        try { this.uploadModal?.hide(); } catch (_error) {}
        try { this.failedMibsModal?.hide(); } catch (_error) {}
        try { this.trapDetailsModal?.hide(); } catch (_error) {}
        this.uploadModal = null;
        this.failedMibsModal = null;
        this.trapDetailsModal = null;
    },

    bindDomEvent: function(element, type, handler, options) {
        if (!element || typeof element.addEventListener !== 'function') {
            return;
        }
        element.addEventListener(type, handler, options);
        this._domListeners.push([element, type, handler, options]);
    },

    bindDomListeners: function() {
        this.bindDomEvent(document.getElementById('trap-search'), 'input', (e) => {
            const clearBtn = document.getElementById('btn-clear-trap-search');
            if (clearBtn) {
                if (e.target.value.length > 0) {
                    clearBtn.classList.remove('d-none');
                } else {
                    clearBtn.classList.add('d-none');
                }
            }
            this.filterTraps(e.target.value);
        });

        this.bindDomEvent(document.getElementById('mib-upload-input'), 'change', () => {
            this.validateFiles();
        });
        this.bindDomEvent(document.getElementById('mib-upload-group'), 'change', () => {
            const input = document.getElementById('mib-upload-input');
            if (input && input.files && input.files.length > 0) {
                this.validateFiles();
            }
        });
        ['mib-filter-query', 'mib-filter-scope'].forEach((id) => {
            this.bindDomEvent(document.getElementById(id), id === 'mib-filter-query' ? 'input' : 'change', () => {
                this.handleMibFilterChange();
            });
        });
        this.bindDomEvent(document.getElementById('mib-filter-source-group'), 'change', () => {
            this.handleMibFilterChange();
        });
        this.bindDomEvent(document.getElementById('mib-export-type'), 'change', () => {
            this.updateMibSelectionState();
        });
    },

    initDropzone: function() {
        const dropzone = document.getElementById('mib-dropzone');
        const overlay  = document.getElementById('drop-overlay');
        const fileInput = document.getElementById('mib-upload-input');

        if (!dropzone || !overlay || !fileInput) return;

        const preventDefaults = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            this.bindDomEvent(dropzone, eventName, preventDefaults, false);
        });

        let dragCounter = 0;

        this.bindDomEvent(dropzone, 'dragenter', () => {
            dragCounter++;
            overlay.classList.remove('d-none');
            overlay.classList.add('d-flex');
        });

        this.bindDomEvent(dropzone, 'dragleave', () => {
            dragCounter--;
            if (dragCounter === 0) {
                overlay.classList.add('d-none');
                overlay.classList.remove('d-flex');
            }
        });

        this.bindDomEvent(dropzone, 'drop', (e) => {
            dragCounter = 0;
            overlay.classList.add('d-none');
            overlay.classList.remove('d-flex');

            const files = e.dataTransfer.files;

            if (files && files.length > 0) {
                // 1. Open modal first — this resets the form fields
                MibsModule.showUploadModal();

                // 2. Re-assign dropped files via DataTransfer (FileList is read-only)
                const transfer = new DataTransfer();
                Array.from(files).forEach(f => transfer.items.add(f));
                fileInput.files = transfer.files;

                // 3. Auto-validate after files are safely set
                // Slight delay ensures modal is visible and DOM is ready
                setTimeout(() => MibsModule.validateFiles(), 100);
            }
        });
    },

    applyStatusSnapshot: function(data) {
        if (!data || typeof data !== 'object') return;

        this.currentStatus = data;
        const activeModules = Array.isArray(data.active_modules)
            ? data.active_modules
            : (Array.isArray(data.mibs) ? data.mibs : []);
        const failedModules = Array.isArray(data.failed_modules)
            ? data.failed_modules
            : (Array.isArray(data.errors) ? data.errors : []);
        this.allMibs = activeModules;
        this.sourceInventory = Array.isArray(data.source_inventory) ? data.source_inventory : [];
        this.reconcileMibSelection();

        const loadedEl = document.getElementById('mib-count-loaded');
        if (loadedEl) {
            loadedEl.textContent = Number(data.loaded || 0);
        }

        const failedEl = document.getElementById('mib-count-failed');
        if (failedEl) {
            failedEl.textContent = Number(data.failed || 0);
        }

        const failedSummaryBtn = document.getElementById('mib-failed-summary-btn');
        if (failedSummaryBtn) {
            failedSummaryBtn.disabled = failedModules.length === 0;
        }

        this.populateSourceGroupOptions(data.source_groups || []);
        this.populateMibFilterSourceGroupOptions(data.source_groups || [], this.allMibs, this.sourceInventory);
        this.populateExportSourceGroupOptions(data.source_groups || [], this.allMibs, this.sourceInventory);

        const trapCountEl = document.getElementById('mib-count-traps');
        if (trapCountEl) {
            const loadedTraps = this.allMibs.reduce((sum, mib) => sum + Number(mib && mib.traps || 0), 0);
            trapCountEl.textContent = loadedTraps;
        }

        this.renderMibList();
        this.renderFailedMibs(failedModules);
        this.updateRecompileBanner(data);
    },

    updateRecompileBanner: function(data) {
        const banner = document.getElementById('mib-recompile-banner');
        if (!banner) return;
        const recommended = Boolean(data && data.recompile_recommended);
        const bundleId = data && data.active_bundle_id != null ? data.active_bundle_id : null;
        const dismissed = bundleId != null && this.isRecompileBannerDismissed(bundleId);
        banner.classList.toggle('d-none', !recommended || dismissed);
        this.renderRecompileBannerCopy(data);
    },

    // MGR-18: build the banner copy from the status payload instead of the
    // hardcoded string — surfaces producer_version and missing_capabilities.
    renderRecompileBannerCopy: function(data) {
        const copyEl = document.getElementById('mib-recompile-banner-copy');
        if (!copyEl) return;
        const producerVersion = data && data.producer_version ? String(data.producer_version).trim() : '';
        const missing = (Array.isArray(data && data.missing_capabilities) ? data.missing_capabilities : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        const missingText = missing.length > 0 ? missing.join('/') : 'enum/units';
        const versionText = producerVersion ? ` (producer ${producerVersion})` : '';
        copyEl.textContent = `This bundle was compiled by an older MIB compiler${versionText} and lacks ${missingText} metadata. Recompile?`;
    },

    // MGR-14: dismissal is scoped to the bundle it was dismissed for, so a
    // different (or re-uploaded) old bundle prompts again.
    isRecompileBannerDismissed: function(bundleId) {
        if (bundleId == null) return false;
        try {
            const raw = localStorage.getItem(this.RECOMPILE_BANNER_DISMISS_KEY);
            if (!raw) return false;
            const state = JSON.parse(raw);
            return Boolean(state && state.dismissed === true
                && String(state.bundle_id) === String(bundleId));
        } catch (_error) {
            return false;
        }
    },

    dismissRecompileBanner: function() {
        const bundleId = this.currentStatus && this.currentStatus.active_bundle_id != null
            ? this.currentStatus.active_bundle_id
            : null;
        try {
            localStorage.setItem(this.RECOMPILE_BANNER_DISMISS_KEY, JSON.stringify({
                bundle_id: bundleId,
                dismissed: true,
            }));
        } catch (_error) {
            // Storage unavailable — the banner simply returns next visit.
        }
        const banner = document.getElementById('mib-recompile-banner');
        if (banner) banner.classList.add('d-none');
    },

    recompileFromBanner: async function() {
        // MGR-19: busy state on the banner's own button so a recompile can't
        // be double-triggered while the reload is in flight.
        const btn = document.getElementById('mib-recompile-banner-btn');
        const originalHtml = btn ? btn.innerHTML : '';
        if (btn) {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Recompiling...';
        }
        try {
            localStorage.removeItem(this.RECOMPILE_BANNER_DISMISS_KEY);
            await this.reloadMibs();
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                btn.innerHTML = originalHtml;
            }
        }
    },

    loadStatus: async function() {
        const requestId = ++this._statusRequestId;
        const list = document.getElementById('mib-list');
        // Only show loading spinner on first ever load; on page switch render
        // cached data immediately and refresh silently in background.
        if (list && !this.currentStatus) {
            list.innerHTML = this.buildListPlaceholder({
                state: 'loading',
                title: 'Loading MIB sources',
                copy: 'Reading the active source inventory.',
            });
        } else if (this.currentStatus) {
            // Render stale data immediately so the page doesn't blank out
            this.applyStatusSnapshot(this.currentStatus);
        }

        try {
            const res  = await fetch('/api/mibs/status');
            const data = await res.json();
            if (requestId !== this._statusRequestId) return;

            this._statusCacheValid = true;
            this.applyStatusSnapshot(data);
        } catch (e) {
            if (requestId !== this._statusRequestId) return;
            console.error('Failed to load MIB status', e);
            if (list) {
                list.innerHTML = this.buildListPlaceholder({
                    icon: 'fa-triangle-exclamation',
                    title: 'Unable to load MIB sources',
                    copy: 'Refresh the page or check the backend logs for details.',
                });
            }
        }
    },

    renderMibList: function() {
        const list = document.getElementById('mib-list');
        if (!list) return;
        const esc = TrishulUtils.escapeHtml;
        const filters = this.getMibFilterState();
        const scopedMibs = this.getScopedMibs(filters.sourceGroup);
        const mibs = this.getFilteredMibs();
        const hasFilter = this.hasActiveMibFilters(filters);

        if (scopedMibs.length === 0 && !filters.query) {
            list.innerHTML = this.buildListPlaceholder({
                icon: hasFilter ? 'fa-filter' : 'fa-inbox',
                title: hasFilter ? 'No matching MIB sources' : 'No MIB sources',
                copy: hasFilter
                    ? 'Clear the current filter or choose a different source group.'
                    : 'Upload MIB files or enable remote dependency fetch before building a bundle.',
            });
            this.updateMibSelectionState();
            return;
        }

        if (mibs.length === 0) {
            list.innerHTML = this.buildListPlaceholder({
                icon: hasFilter ? 'fa-filter' : 'fa-inbox',
                title: hasFilter ? 'No matching MIB sources' : 'No MIB sources',
                copy: hasFilter
                    ? 'Clear the current filter or choose a different source group.'
                    : 'Upload MIB files to populate the source inventory.',
            });
            this.updateMibSelectionState();
            return;
        }

        list.innerHTML = mibs.map(mib => {
            const path = this.mibPath(mib);
            const isDeleting = this.isDeletingMibPath(path);
            const canDownloadRaw = this.isRawDownloadableMib(mib);
            // MGR-20: expansion survives re-renders via the module-keyed set.
            const metadataExpanded = Boolean(mib.module_metadata)
                && this.expandedModuleMetadata.has(mib.name);
            return `
            <li class="list-group-item py-2 mib-list-item ${this.isMibSelected(mib) ? 'mib-list-item-selected' : ''}">
                <div class="d-flex align-items-start gap-2">
                    ${path ? `
                        <div class="form-check mt-1 mb-0">
                            <input type="checkbox"
                                   class="form-check-input mib-selection-checkbox"
                                   data-path="${esc(path)}"
                                   aria-label="Select ${esc(path)}"
                                   onchange="MibsModule.toggleMibSelection(this)"
                                   ${isDeleting ? 'disabled' : ''}
                                   ${this.isMibSelected(mib) ? 'checked' : ''}>
                        </div>
                    ` : '<span class="mib-selection-spacer"></span>'}
                    <div class="flex-grow-1 min-w-0">
                        <div class="mib-item-title-row">
                            <i class="fas fa-book app-header-icon is-success"></i>
                            <strong class="mib-item-title">${esc(mib.name)}</strong>
                            ${this.renderSourceBadge(mib)}
                            ${this.renderInventoryStatusBadge(mib)}
                            ${mib.source_group && !['bundled', 'auto-fetched'].includes(String(mib.source_group).toLowerCase()) ? `<span class="badge app-badge is-light">${esc(mib.source_group)}</span>` : ''}
                        </div>
                        <div class="small text-muted mib-item-meta">
                            <span>${Number(mib.objects || 0)} objects</span>
                            <span class="app-meta-sep">·</span>
                            <span>${Number(mib.traps || 0)} traps</span>
                            ${Array.isArray(mib.imports) && mib.imports.length > 0 ? `<span class="app-meta-sep">·</span><span>${mib.imports.length} imports</span>` : ''}
                        </div>
                        ${Array.isArray(mib.imports) && mib.imports.length > 0 ? `
                            <div class="small text-muted mib-item-detail app-truncate-line" title="${esc(mib.imports.join(', '))}">
                                Imports: ${mib.imports.slice(0, 4).map(esc).join(', ')}${mib.imports.length > 4 ? ', ...' : ''}
                            </div>
                        ` : ''}
                        ${mib.relative_path ? `
                            <div class="small text-muted mib-item-detail app-truncate-line" title="${esc(mib.relative_path)}">
                                Path: ${esc(mib.relative_path)}
                            </div>
                        ` : ''}
                        ${mib.active_relative_path ? `
                            <div class="small text-muted mib-item-detail app-truncate-line" title="${esc(mib.active_relative_path)}">
                                Active source: ${esc(mib.active_relative_path)}
                            </div>
                        ` : ''}
                        ${mib.error && String(mib.status || '').toLowerCase() !== 'active' ? `
                            <div class="small text-muted mib-item-detail app-truncate-line" title="${esc(mib.error)}">
                                State: ${esc(mib.error)}
                            </div>
                        ` : ''}
                    </div>
                <div class="d-flex align-items-center gap-1">
                    ${mib.module_metadata ? `
                        <button type="button" class="btn btn-sm btn-app-secondary btn-icon mib-side-action"
                                onclick="MibsModule.toggleModuleMetadata(this, '${esc(mib.name)}')"
                                title="Module metadata" aria-label="Module metadata"
                                aria-expanded="${metadataExpanded ? 'true' : 'false'}">
                            <i class="fas fa-clock-rotate-left"></i>
                        </button>
                    ` : ''}
                    ${canDownloadRaw ? `
                        <button type="button" class="btn btn-sm btn-app-secondary btn-icon mib-side-action"
                                onclick="MibsModule.downloadMib(this.dataset.path)"
                                data-path="${esc(path)}"
                                title="Download MIB source"
                                aria-label="Download MIB source">
                            <i class="fas fa-download"></i>
                        </button>
                    ` : ''}
                    ${mib.deletable ? `
                        <button type="button" class="btn btn-sm btn-app-danger-outline btn-icon mib-side-action"
                                onclick="MibsModule.deleteMib(this.dataset.path)"
                                data-path="${esc(path)}"
                                title="Delete MIB source"
                                aria-label="Delete MIB source"
                                ${isDeleting ? 'disabled aria-busy="true"' : ''}>
                            <i class="fas ${isDeleting ? 'fa-spinner fa-spin' : 'fa-trash'}"></i>
                        </button>
                    ` : ''}
                </div>
                </div>
                <div class="mib-module-meta-panel ${metadataExpanded ? '' : 'd-none'}">${metadataExpanded ? this.buildModuleMetadataCard(mib.module_metadata) : ''}</div>
            </li>
        `;
        }).join('');

        this.updateMibSelectionState();
    },

    mibPath: function(mib) {
        return String((mib && (mib.relative_path || mib.file)) || '').trim();
    },

    isMibSelected: function(mib) {
        const path = this.mibPath(mib);
        return Boolean(path) && this.selectedMibPaths.has(path);
    },

    isDeletingMibPath: function(path) {
        return Boolean(path) && this.deletingMibPaths.has(String(path).trim());
    },

    reconcileMibSelection: function() {
        const available = new Set(
            [...(this.allMibs || []), ...(this.sourceInventory || [])]
                .map(mib => this.mibPath(mib))
                .filter(Boolean)
        );
        this.selectedMibPaths = new Set(Array.from(this.selectedMibPaths).filter(path => available.has(path)));
    },

    getFailedMibs: function() {
        if (Array.isArray(this.currentStatus?.failed_modules)) {
            return this.currentStatus.failed_modules;
        }
        return Array.isArray(this.currentStatus?.errors) ? this.currentStatus.errors : [];
    },

    getMibFilterState: function() {
        const sourceGroup = String(document.getElementById('mib-filter-source-group')?.value || '').trim().toLowerCase();
        const scope = String(document.getElementById('mib-filter-scope')?.value || 'all').trim().toLowerCase() || 'all';
        const query = String(document.getElementById('mib-filter-query')?.value || '').trim().toLowerCase();
        return { sourceGroup, scope, query };
    },

    hasActiveMibFilters: function(filters) {
        return Boolean(
            filters
            && (filters.sourceGroup || filters.query)
        );
    },

    matchesFilterValue: function(value, query) {
        if (!query) {
            return true;
        }
        return String(value || '').toLowerCase().includes(query);
    },

    getScopedMibs: function(sourceGroup) {
        const normalizedGroup = String(sourceGroup || '').trim().toLowerCase();
        if (!normalizedGroup) {
            return Array.isArray(this.allMibs) ? this.allMibs : [];
        }

        const scopedInventory = (Array.isArray(this.sourceInventory) ? this.sourceInventory : []).filter((mib) => {
            const group = String(mib && mib.source_group ? mib.source_group : '').trim().toLowerCase();
            return group === normalizedGroup;
        });
        if (scopedInventory.length > 0) {
            return scopedInventory;
        }

        return (Array.isArray(this.allMibs) ? this.allMibs : []).filter((mib) => {
            const group = String(mib && mib.source_group ? mib.source_group : '').trim().toLowerCase();
            return group === normalizedGroup;
        });
    },

    getFilteredMibs: function() {
        const filters = this.getMibFilterState();
        return this.getScopedMibs(filters.sourceGroup).filter((mib) => {
            const moduleName = String(mib && mib.name ? mib.name : '').toLowerCase();
            const imports = Array.isArray(mib && mib.imports) ? mib.imports.join(' ').toLowerCase() : '';
            const relativePath = [
                mib && mib.relative_path,
                mib && mib.file,
                mib && mib.active_relative_path,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            const searchFields = {
                all: [moduleName, imports, relativePath].join(' '),
                module: moduleName,
                imports,
                path: relativePath,
            };
            return this.matchesFilterValue(searchFields[filters.scope] || searchFields.all, filters.query);
        });
    },

    getSelectedMibs: function() {
        const selectedPaths = Array.from(this.selectedMibPaths);
        if (selectedPaths.length === 0) {
            return [];
        }

        const byPath = new Map();
        [
            ...(this.getFilteredMibs() || []),
            ...((Array.isArray(this.sourceInventory) ? this.sourceInventory : [])),
            ...((Array.isArray(this.allMibs) ? this.allMibs : [])),
        ].forEach((mib) => {
            const path = this.mibPath(mib);
            if (path && !byPath.has(path)) {
                byPath.set(path, mib);
            }
        });

        return selectedPaths
            .map((path) => byPath.get(path))
            .filter(Boolean);
    },

    getSelectedDeletablePaths: function() {
        return this.getSelectedMibs()
            .filter((mib) => mib && mib.deletable && this.mibPath(mib))
            .map((mib) => this.mibPath(mib));
    },

    isRawDownloadableMib: function(mib) {
        return Boolean(mib && mib.deletable && this.mibPath(mib));
    },

    getSelectedDownloadablePaths: function() {
        return this.getSelectedMibs()
            .filter((mib) => this.isRawDownloadableMib(mib))
            .map((mib) => this.mibPath(mib));
    },

    getSelectedExportModules: function() {
        const skipped = [];
        const modules = new Set();

        this.getSelectedMibs().forEach((mib) => {
            const status = String(mib && mib.status ? mib.status : 'active').toLowerCase();
            const moduleName = String(mib && mib.name ? mib.name : '').trim();
            const path = this.mibPath(mib) || moduleName;
            if (!moduleName) {
                skipped.push(path);
                return;
            }
            if (['failed', 'invalid', 'missing_deps', 'pending'].includes(status)) {
                skipped.push(path);
                return;
            }
            modules.add(moduleName);
        });

        return {
            modules: Array.from(modules).sort((left, right) => left.localeCompare(right)),
            skippedCount: skipped.length,
            selectedCount: this.selectedMibPaths.size,
        };
    },

    getVisibleDeletableMibs: function() {
        return this.getFilteredMibs().filter(mib => mib && mib.deletable && this.mibPath(mib));
    },

    getVisibleSelectableMibs: function() {
        return this.getFilteredMibs().filter(mib => mib && this.mibPath(mib));
    },

    handleMibFilterChange: function() {
        this.selectedMibPaths.clear();
        this.renderMibList();
    },

    toggleMibSelection: function(input) {
        const path = String(input?.dataset?.path || '').trim();
        if (!path) return;
        if (input.checked) {
            this.selectedMibPaths.add(path);
        } else {
            this.selectedMibPaths.delete(path);
        }
        input.closest('.mib-list-item')?.classList.toggle('mib-list-item-selected', input.checked);
        this.updateMibSelectionState();
    },

    selectVisibleMibs: function() {
        this.getVisibleSelectableMibs().forEach(mib => {
            const path = this.mibPath(mib);
            if (path) this.selectedMibPaths.add(path);
        });
        this.renderMibList();
    },

    clearMibSelection: function() {
        this.selectedMibPaths.clear();
        this.renderMibList();
    },

    updateMibSelectionState: function() {
        const summary = document.getElementById('mib-selection-summary');
        const selectVisibleBtn = document.getElementById('mib-select-visible-btn');
        const clearSelectionBtn = document.getElementById('mib-clear-selection-btn');
        const exportSelectedJsonBtn = document.getElementById('mib-export-selected-json-btn');
        const exportSelectedCsvBtn = document.getElementById('mib-export-selected-csv-btn');
        const downloadSelectedBtn = document.getElementById('mib-download-selected-btn');
        const deleteSelectedBtn = document.getElementById('mib-delete-selected-btn');
        const filteredMibs = this.getFilteredMibs();
        const visibleSelectable = filteredMibs.filter(mib => mib && this.mibPath(mib));
        const selectedVisibleCount = visibleSelectable.filter(mib => this.isMibSelected(mib)).length;
        const totalSelected = this.selectedMibPaths.size;
        const totalDeletableSelected = this.getSelectedDeletablePaths().length;
        const totalDownloadableSelected = this.getSelectedDownloadablePaths().length;
        const totalExportableSelected = this.getSelectedExportModules().modules.length;
        const filters = this.getMibFilterState();
        const filteredText = this.hasActiveMibFilters(filters)
            ? `${filteredMibs.length} shown`
            : `${this.allMibs.length} MIBs`;
        const deleting = this.deletingMibPaths.size > 0;
        const exportTypeLabel = this.getExportTypeLabel();

        if (summary) {
            let text = filteredText;
            if (visibleSelectable.length > 0) {
                text += ` · ${selectedVisibleCount} selected`;
            }
            summary.textContent = text;
        }
        if (selectVisibleBtn) {
            selectVisibleBtn.disabled = deleting || visibleSelectable.length === 0 || selectedVisibleCount === visibleSelectable.length;
        }
        if (clearSelectionBtn) {
            clearSelectionBtn.disabled = deleting || totalSelected === 0;
        }
        if (exportSelectedJsonBtn) {
            exportSelectedJsonBtn.disabled = deleting || totalExportableSelected === 0;
            exportSelectedJsonBtn.title = `Export selected ${exportTypeLabel} as JSON`;
        }
        if (exportSelectedCsvBtn) {
            exportSelectedCsvBtn.disabled = deleting || totalExportableSelected === 0;
            exportSelectedCsvBtn.title = `Export selected ${exportTypeLabel} as CSV`;
        }
        if (downloadSelectedBtn) {
            downloadSelectedBtn.disabled = deleting || totalDownloadableSelected === 0;
            downloadSelectedBtn.title = totalDownloadableSelected > 1
                ? 'Download selected MIB source files as zip'
                : 'Download selected MIB source file';
        }
        if (deleteSelectedBtn) {
            deleteSelectedBtn.disabled = deleting || totalDeletableSelected === 0;
            deleteSelectedBtn.innerHTML = deleting
                ? '<i class="fas fa-spinner fa-spin"></i>'
                : '<i class="fas fa-trash"></i>';
        }
    },

    getExportType: function() {
        return String(document.getElementById('mib-export-type')?.value || 'catalog').trim() || 'catalog';
    },

    getExportTypeLabel: function() {
        const labels = {
            catalog: 'full catalog',
            summary: 'summary',
            modules: 'modules',
            objects: 'objects',
            notifications: 'notifications',
        };
        return labels[this.getExportType()] || 'catalog data';
    },

    sourceLabel: function(mib) {
        const sourceKind = String(mib && mib.source_kind ? mib.source_kind : '').toLowerCase();
        if (sourceKind === 'bundled' || mib.builtin) return 'Bundled';
        if (sourceKind === 'auto-fetched') return 'Auto-fetched';
        if (sourceKind === 'uploaded') return 'Uploaded';
        if (sourceKind === 'compiled') return 'Compiled';
        return 'Managed';
    },

    renderSourceBadge: function(mib) {
        const label = this.sourceLabel(mib);
        if (label === 'Bundled') {
            return '<span class="badge app-badge is-neutral ms-2">Bundled</span>';
        }
        if (label === 'Auto-fetched') {
            return '<span class="badge app-badge is-warning ms-2">Auto-fetched</span>';
        }
        if (label === 'Uploaded') {
            return '<span class="badge app-badge is-info ms-2">Uploaded</span>';
        }
        if (label === 'Compiled') {
            return '<span class="badge app-badge is-primary ms-2">Compiled</span>';
        }
        return '';
    },

    renderInventoryStatusBadge: function(mib) {
        const status = String(mib && mib.status ? mib.status : '').toLowerCase();
        if (status === 'shadowed') {
            return '<span class="badge app-badge is-neutral ms-2">Shadowed</span>';
        }
        if (status === 'pending') {
            return '<span class="badge app-badge is-warning ms-2">Pending</span>';
        }
        if (status === 'missing_deps') {
            return '<span class="badge app-badge is-warning ms-2">Missing deps</span>';
        }
        if (status === 'invalid') {
            return '<span class="badge app-badge is-danger ms-2">Invalid</span>';
        }
        if (status === 'failed') {
            return '<span class="badge app-badge is-danger ms-2">Failed</span>';
        }
        return '';
    },

    toggleModuleMetadata: function(button, moduleName) {
        const mib = (this.allMibs || []).find(item => item && item.name === moduleName);
        const panel = button ? button.closest('.mib-list-item')?.querySelector('.mib-module-meta-panel') : null;
        if (!mib || !panel) return;
        // MGR-20: remember expansion per module so re-renders don't collapse.
        const expand = panel.classList.contains('d-none');
        if (expand) {
            panel.innerHTML = this.buildModuleMetadataCard(mib.module_metadata);
            panel.classList.remove('d-none');
            this.expandedModuleMetadata.add(moduleName);
        } else {
            panel.classList.add('d-none');
            this.expandedModuleMetadata.delete(moduleName);
        }
        if (button) {
            button.setAttribute('aria-expanded', expand ? 'true' : 'false');
        }
    },

    buildModuleMetadataCard: function(metadata) {
        const esc = TrishulUtils.escapeHtml;
        const revisions = Array.isArray(metadata && metadata.revisions) ? metadata.revisions : [];
        return `
            <div class="mib-module-meta-card p-2 mt-2 small">
                ${metadata.organization ? `
                    <div class="mb-1"><span class="text-muted fw-bold">Organization:</span> ${esc(metadata.organization)}</div>
                ` : ''}
                ${metadata.lastupdated ? `
                    <div class="mb-1"><span class="text-muted fw-bold">Last updated:</span> ${esc(metadata.lastupdated)}</div>
                ` : ''}
                ${metadata.contactinfo ? `
                    <div class="mb-1 text-muted app-break-word"><span class="fw-bold">Contact:</span> ${esc(metadata.contactinfo)}</div>
                ` : ''}
                ${revisions.length > 0 ? `
                    <div class="mt-1">
                        <div class="text-muted fw-bold mb-1">Revisions</div>
                        <ul class="list-unstyled mb-0 app-scroll-panel app-max-h-150">
                            ${revisions.map(rev => `
                                <li class="mb-1">
                                    <code class="small">${esc(rev.date || '')}</code>
                                    ${rev.description ? `<div class="text-muted app-fs-75">${esc(rev.description)}</div>` : ''}
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                ` : ''}
                ${metadata.description ? `
                    <div class="mt-1 text-muted app-fs-75">${esc(metadata.description)}</div>
                ` : ''}
            </div>
        `;
    },

    renderFailedMibs: function(errors) {
        const list = document.getElementById('failed-mib-list');
        const total = document.getElementById('failed-mib-total-count');
        const esc = TrishulUtils.escapeHtml;
        const rows = Array.isArray(errors) ? errors : [];

        if (total) {
            total.textContent = rows.length;
        }
        if (!list) return;

        if (rows.length === 0) {
            list.innerHTML = `
                <li class="list-group-item border-0 bg-transparent">
                    <div class="app-panel-placeholder is-compact">
                        <i class="fas fa-circle-check app-header-icon is-success"></i>
                        <span class="app-panel-placeholder-title">No failed MIBs</span>
                        <span class="app-panel-placeholder-copy">All stored sources are currently loading cleanly.</span>
                    </div>
                </li>
            `;
            return;
        }

        list.innerHTML = rows.map(mib => {
            const path = this.mibPath(mib);
            const isDeleting = this.isDeletingMibPath(path);
            return `
            <li class="list-group-item">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="flex-grow-1">
                        <div class="d-flex align-items-center">
                            <i class="fas fa-exclamation-circle app-header-icon is-danger me-2"></i>
                            <strong class="app-status-text is-error">${esc(mib.name)}</strong>
                        </div>
                        <div class="small text-muted mt-1 font-monospace app-max-w-500 app-break-word">
                            ${esc(mib.error || 'Unknown error')}
                        </div>
                        ${mib.file ? `<div class="small text-muted mt-1">Source: <code>${esc(mib.file)}</code></div>` : ''}
                        ${mib.active_relative_path ? `<div class="small text-muted mt-1">Active source: <code>${esc(mib.active_relative_path)}</code></div>` : ''}
                        ${mib.status === 'missing_deps' ? `
                            <div class="mt-2">
                                <span class="badge app-badge is-warning">Missing dependencies</span>
                                ${mib.missing_deps && mib.missing_deps.length > 0 ? `
                                    <div class="small mt-1">${mib.missing_deps.map(esc).join(', ')}</div>
                                ` : ''}
                                <button type="button" class="btn btn-xs btn-app-secondary ms-2" onclick="MibsModule.showDependencyHelp()">
                                    <i class="fas fa-question-circle"></i> Help
                                </button>
                            </div>
                        ` : ''}
                    </div>
                    ${mib.deletable ? `
                        <button type="button" class="btn btn-sm btn-app-danger-outline" onclick="MibsModule.deleteMib(this.dataset.path)" data-path="${esc(path)}" ${isDeleting ? 'disabled aria-busy="true"' : ''}>
                            <i class="fas ${isDeleting ? 'fa-spinner fa-spin' : 'fa-trash'}"></i>
                        </button>
                    ` : ''}
                </div>
            </li>
        `;
        }).join('');
    },

    openFailedMibsModal: function() {
        const errors = this.getFailedMibs();
        this.renderFailedMibs(errors);
        const deleteAllBtn = document.getElementById('mib-delete-all-failed-btn');
        if (deleteAllBtn) deleteAllBtn.disabled = errors.length === 0 || this.deletingMibPaths.size > 0;
        if (errors.length === 0) {
            TrishulUtils.showNotification('No failed MIBs', 'success');
            return;
        }
        this.failedMibsModal.show();
    },

    deleteAllFailed: async function() {
        const errors = this.getFailedMibs();
        const paths = errors
            .filter(e => e.deletable && e.file && !this.isDeletingMibPath(e.file))
            .map(e => e.file);
        if (paths.length === 0) {
            TrishulUtils.showNotification('No deletable failed MIBs', 'warning');
            return;
        }
        await this.deleteMibs(paths);
        this.failedMibsModal.hide();
    },

    applyTrapSnapshot: function(traps) {
        this.allTraps = Array.isArray(traps) ? traps : [];

        const totalBadge = document.getElementById('trap-total-count');
        if (totalBadge) {
            totalBadge.textContent = this.allTraps.length;
        }

        const query = String(document.getElementById('trap-search')?.value || '').trim();
        if (query) {
            this.filterTraps(query);
            return;
        }
        this.renderTraps(this.allTraps);
    },

    loadTraps: async function() {
        const requestId = ++this._trapRequestId;
        const tbody = document.getElementById('trap-table-body');
        if (tbody && !this.allTraps.length) {
            tbody.innerHTML = this.buildTablePlaceholderRow({
                state: 'loading',
                title: 'Loading trap catalog',
                copy: 'Reading notifications from the active bundle.',
            });
            this._renderTrapTableFooter(null);
        } else if (this.allTraps.length) {
            this.applyTrapSnapshot(this.allTraps);
        }

        try {
            const res  = await fetch('/api/mibs/traps');
            const data = await res.json();
            if (requestId !== this._trapRequestId) return;

            this._trapCacheValid = true;
            this.applyTrapSnapshot(data.traps || []);
        } catch (e) {
            if (requestId !== this._trapRequestId) return;
            console.error('Failed to load traps', e);
            if (tbody) {
                tbody.innerHTML = this.buildTablePlaceholderRow({
                    icon: 'fa-triangle-exclamation',
                    title: 'Unable to load trap catalog',
                    copy: 'Refresh the page or inspect the backend logs for details.',
                });
                this._renderTrapTableFooter(null);
            }
        }
    },

    renderTraps: function(traps) {
        const tbody = document.getElementById('trap-table-body');
        if (!tbody) return;
        const esc = TrishulUtils.escapeHtml;

        const sortedTraps = this.sortTrapCatalog(traps);

        if (sortedTraps.length === 0) {
            tbody.innerHTML = this.buildTablePlaceholderRow({
                icon: 'fa-bell-slash',
                title: 'No traps in catalog',
                copy: 'The active bundle does not currently expose any notification definitions.',
            });
            this._renderTrapTableFooter(null);
            return;
        }

        const rowCap = Number(this.TRAP_ROW_CAP) || 500;
        const totalCount = sortedTraps.length;
        const visibleRows = totalCount > rowCap ? sortedTraps.slice(0, rowCap) : sortedTraps;

        const loadedModules  = new Set();
        if (this.currentStatus && this.currentStatus.mibs) {
            this.currentStatus.mibs.forEach(mib => loadedModules.add(mib.name));
        }

        const knownSystemMibs = ['SNMPv2-MIB', 'SNMPv2-SMI', 'SNMP-FRAMEWORK-MIB'];

        tbody.innerHTML = visibleRows.map(trap => {
            const isSystemMib = knownSystemMibs.includes(trap.module) && !loadedModules.has(trap.module);
            const payload = esc(TrishulUtils.encodeDataAttr(trap));

            return `
            <tr ${isSystemMib ? 'class="table-secondary"' : ''}>
                <td class="mib-trap-name-cell" title="${esc(trap.name)}">
                    <div class="d-flex align-items-center mib-trap-row-main">
                        <i class="fas fa-bell ${isSystemMib ? 'app-header-icon is-neutral' : 'app-header-icon is-warning'} me-2"></i>
                        <strong class="mib-trap-name text-truncate">${esc(trap.name)}</strong>
                        ${isSystemMib ? '<span class="badge app-badge is-neutral ms-2 app-fs-60">System</span>' : ''}
                    </div>
                </td>
                <td title="${esc(trap.oid)}">
                    <code class="small text-muted text-truncate d-block app-fs-70">${esc(trap.oid)}</code>
                </td>
                <td class="text-center" title="${esc(trap.module)}">
                    <span class="${isSystemMib ? 'badge app-badge is-neutral app-fs-70 mib-trap-module-badge' : 'badge mib-module-badge app-fs-70 mib-trap-module-badge'}">${esc(trap.module)}</span>
                </td>
                <td class="text-center">
                    <span class="badge app-badge is-info app-fs-70">${Number((trap.objects || []).length)}</span>
                </td>
                <td class="text-center">
                    <div class="trap-action-buttons">
                        <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-2"
                                onclick="MibsModule.handleTrapAction(this)"
                                data-action="details"
                                data-trap="${payload}"
                                title="View Details">
                            <i class="fas fa-info-circle"></i>
                        </button>
                        <button type="button" class="btn btn-sm btn-app-secondary btn-icon py-0 px-2"
                                onclick="MibsModule.handleTrapAction(this)"
                                data-action="send"
                                data-trap="${payload}"
                                title="Send Trap">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        this._renderTrapTableFooter(totalCount > (Number(this.TRAP_ROW_CAP) || 500) ? { shown: visibleRows.length, total: totalCount } : null);
    },

    sortTrapCatalog: function(traps) {
        const list = Array.isArray(traps) ? traps : [];
        const key  = this._trapSortKey;
        const dir  = this._trapSortDir === 'asc' ? 1 : -1;
        return list.slice().sort((a, b) => {
            const left  = key === 'oid' ? String(a.oid  || '') : String(a.name || '');
            const right = key === 'oid' ? String(b.oid  || '') : String(b.name || '');
            return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }) * dir;
        });
    },

    toggleTrapSort: function(key) {
        if (this._trapSortKey === key) {
            this._trapSortDir = this._trapSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this._trapSortKey = key;
            this._trapSortDir = 'asc';
        }
        this._updateTrapSortHeaders();
        const query = String(document.getElementById('trap-search')?.value || '').trim();
        if (query) {
            this.filterTraps(query);
        } else {
            this.renderTraps(this.allTraps);
        }
    },

    _updateTrapSortHeaders: function() {
        const configs = [
            { key: 'name', thId: 'trap-th-name' },
            { key: 'oid',  thId: 'trap-th-oid' },
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

    _renderTrapTableFooter: function(meta) {
        const foot = document.getElementById('trap-table-footer');
        if (!foot) return;
        if (!meta) {
            foot.classList.add('d-none');
            return;
        }
        const summaryEl = foot.querySelector('.trap-table-summary');
        if (summaryEl) {
            summaryEl.textContent = `Showing latest ${meta.shown} of ${meta.total.toLocaleString()} — refine your search`;
        }
        foot.classList.remove('d-none');
    },

    handleTrapAction: function(button) {
        const trap = TrishulUtils.decodeDataAttr(button?.dataset?.trap || '', null);
        if (!trap) return;
        if (button.dataset.action === 'details') {
            this.showTrapDetails(trap);
            return;
        }
        if (button.dataset.action === 'send') {
            this.useTrapDirectly(trap);
        }
    },

    useTrapDirectly: function(trap) {
        sessionStorage.setItem('selectedTrap', JSON.stringify(trap));
        window.location.hash = '#traps';
    },

    filterTraps: function(query) {
        if (!this.allTraps) return;
        const filtered = this.allTraps.filter(trap => {
            const searchStr = `${trap.name} ${trap.module} ${trap.oid} ${trap.description}`.toLowerCase();
            return searchStr.includes(query.toLowerCase());
        });
        this.renderTraps(filtered);
    },

    clearTrapSearch: function() {
        const searchInput = document.getElementById('trap-search');
        if (searchInput) {
            searchInput.value = '';
            const clearBtn = document.getElementById('btn-clear-trap-search');
            if (clearBtn) clearBtn.classList.add('d-none');
            searchInput.focus();
        }
        this.filterTraps('');
    },

    showTrapDetails: function(trap) {
        this.currentTrapData = trap;

        const title = document.getElementById('trap-detail-title');
        const body  = document.getElementById('trap-detail-body');
        const esc = TrishulUtils.escapeHtml;

        title.textContent = trap.full_name;
        const copyOid = esc(trap.oid || '');

        body.innerHTML = `
            <div class="app-surface-muted border rounded p-3 mb-3">
                <div class="row g-3 small">
                    <div class="col-sm-6">
                        <div class="text-muted fw-bold mb-1">Name</div>
                        <div><code>${esc(trap.name)}</code></div>
                    </div>
                    <div class="col-sm-6">
                        <div class="text-muted fw-bold mb-1">Module</div>
                        <div><span class="badge app-badge is-neutral">${esc(trap.module)}</span></div>
                    </div>
                    <div class="col-12">
                        <div class="text-muted fw-bold mb-1">Full Name</div>
                        <div><code>${esc(trap.full_name)}</code></div>
                    </div>
                    <div class="col-12">
                        <div class="text-muted fw-bold mb-1">OID</div>
                        <div class="d-flex align-items-center gap-2 flex-wrap">
                            <code>${esc(trap.oid)}</code>
                            <button type="button" class="btn btn-xs btn-app-secondary"
                                    onclick="MibsModule.copyValue(this.dataset.copy)"
                                    data-copy="${copyOid}">
                                <i class="fas fa-copy"></i> Copy
                            </button>
                        </div>
                    </div>
                    <div class="col-12">
                        <div class="text-muted fw-bold mb-1">Description</div>
                        <div class="small text-muted">${esc(trap.description || 'No description available')}</div>
                    </div>
                </div>
            </div>
            <div class="mb-2">
                <div class="text-muted fw-bold small mb-2">Associated Objects (VarBinds)</div>
                ${(trap.objects || []).length > 0 ? `
                    <div class="list-group app-scroll-panel app-max-h-260">
                        ${(trap.objects || []).map(obj => `
                            <div class="list-group-item d-flex justify-content-between align-items-center gap-3">
                                <div class="min-w-0">
                                    <code>${esc(obj.name)}</code>
                                    <div class="small text-muted text-break">${esc(obj.full_name)}</div>
                                </div>
                                <code class="text-muted small text-break">${esc(obj.oid)}</code>
                            </div>
                        `).join('')}
                    </div>
                ` : '<div class="text-muted small">No associated objects defined</div>'}
            </div>
        `;

        this.trapDetailsModal.show();
    },

    copyValue: function(value) {
        navigator.clipboard.writeText(value || '')
            .then(() => TrishulUtils.showNotification('Copied', 'success'))
            .catch(() => TrishulUtils.showNotification('Copy failed', 'error'));
    },

    useTrapInSender: function() {
        if (!this.currentTrapData) return;
        sessionStorage.setItem('selectedTrap', JSON.stringify(this.currentTrapData));
        window.location.hash = '#traps';
        this.trapDetailsModal.hide();
    },

    showUploadModal: function() {
        this.validationState = null;
        document.getElementById('mib-upload-input').value = '';
        document.getElementById('mib-upload-group').value = this.getSelectedSourceGroup();
        document.getElementById('upload-validation-results').classList.add('d-none');
        document.getElementById('dependency-alert').classList.add('d-none');
        document.getElementById('validating-indicator').classList.add('d-none');
        document.getElementById('btn-upload').disabled = true;
        document.getElementById('btn-upload').innerHTML = '<i class="fas fa-upload"></i> Upload';
        document.getElementById('btn-upload').title = '';
        document.getElementById('btn-upload-partial').classList.add('d-none');
        document.getElementById('btn-upload-partial').disabled = true;
        this.uploadModal.show();
    },

    validateFiles: async function() {
        const input = document.getElementById('mib-upload-input');
        if (!input.files || input.files.length === 0) {
            alert('Please select at least one file');
            return;
        }

        // Show loading spinner, hide previous results
        const indicator  = document.getElementById('validating-indicator');
        const resultsDiv = document.getElementById('upload-validation-results');
        const depAlert   = document.getElementById('dependency-alert');
        const depList    = document.getElementById('dependency-list');
        const validationList = document.getElementById('validation-list');
        const uploadBtn = document.getElementById('btn-upload');
        const partialBtn = document.getElementById('btn-upload-partial');

        indicator.classList.remove('d-none');
        resultsDiv.classList.add('d-none');
        depAlert.classList.add('d-none');
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload';
        partialBtn.classList.add('d-none');
        partialBtn.disabled = true;
        this.validationState = null;

        try {
            const formData = new FormData();
            for (let file of input.files) formData.append('files', file);
            formData.append('source_group', this.getSelectedSourceGroup());

            const res  = await fetch('/api/mibs/validate-batch', { method: 'POST', body: formData });
            const data = await res.json();
            const esc = TrishulUtils.escapeHtml;
            this.validationState = data;

            validationList.innerHTML = data.files.map(r => {
                const hasLocalMissing = r.missing_deps.length > 0;
                const partialBadge = r.ready_for_partial
                    ? '<span class="badge app-badge is-info ms-2">Partial-ready</span>'
                    : (
                        r.partial_blockers && r.partial_blockers.length > 0
                            ? '<span class="badge app-badge is-warning ms-2">Blocked</span>'
                            : ''
                    );
                const statusClass  = r.valid ? 'border-success' : 'border-danger';
                const statusBadge  = r.valid
                    ? '<span class="badge app-badge is-success">✓ Valid</span>'
                    : '<span class="badge app-badge is-danger">✗ Invalid</span>';

                return `
                    <div class="card mb-2 ${statusClass}">
                        <div class="card-body p-2">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <strong>${esc(r.filename)}</strong>
                                    <span class="text-muted small ms-2">(${esc(r.mib_name)})</span>
                                    ${partialBadge}
                                </div>
                                ${statusBadge}
                            </div>
                            <div class="text-muted small mt-2">
                                <strong>Target:</strong> <code>${esc(r.target_relative_path || `${data.source_group || this.getSelectedSourceGroup()}/${r.safe_name || r.filename}`)}</code>
                                ${r.will_replace ? '<span class="badge app-badge is-warning ms-2">Will replace</span>' : ''}
                            </div>
                            ${r.errors.length > 0 ? `
                                <div class="alert alert-danger py-1 px-2 mt-2 mb-0 small">
                                    <strong>Errors:</strong><br>${r.errors.map(esc).join('<br>')}
                                </div>` : ''}
                            ${r.imports.length > 0 ? `
                                <div class="text-muted small mt-2">
                                    <strong>Imports:</strong> ${r.imports.map(esc).join(', ')}
                                </div>` : ''}
                            ${hasLocalMissing ? `
                                <div class="alert alert-warning py-1 px-2 mt-2 mb-0 small">
                                    <i class="fas fa-exclamation-triangle"></i>
                                    <strong>Missing:</strong> ${r.missing_deps.map(esc).join(', ')}
                                </div>` : ''}
                            ${r.partial_blockers && r.partial_blockers.length > 0 && !hasLocalMissing ? `
                                <div class="alert alert-secondary py-1 px-2 mt-2 mb-0 small">
                                    <i class="fas fa-layer-group"></i>
                                    <strong>Blocked for partial compile by:</strong> ${r.partial_blockers.map(esc).join(', ')}
                                </div>` : ''}
                        </div>
                    </div>`;
            }).join('');

            resultsDiv.classList.remove('d-none');

            const fetchPolicy = data.dependency_fetch || {};
            const autoFetchEnabled = !!fetchPolicy.auto_enabled;
            const usingDefaultSources = !!fetchPolicy.using_default_sources;
            const uploadBlockedReason = data.upload_blocked_reason || '';
            const sourceSummary = autoFetchEnabled
                ? (
                    usingDefaultSources
                        ? 'Upload will try tsmi default remote sources for the missing dependencies.'
                        : 'Upload will try the configured remote source list from Settings.'
                )
                : 'Remote dependency fetch is disabled in Settings.';

            if (data.global_missing_deps.length > 0) {
                depList.innerHTML = `
                    <p class="mb-2">The following dependencies are not available:</p>
                    <ul class="mb-2">
                        ${data.global_missing_deps.map(dep => `<li><code>${esc(dep)}</code></li>`).join('')}
                    </ul>
                    <p class="mb-0 small">
                        <strong>Options:</strong><br>
                        • Upload the missing MIBs in another batch<br>
                        • Use partial compile for the ready MIBs only<br>
                        • ${esc(sourceSummary)}
                        ${uploadBlockedReason ? `<br>• ${esc(uploadBlockedReason)}` : ''}
                    </p>`;
                depAlert.classList.remove('d-none');
            } else if (uploadBlockedReason) {
                depList.innerHTML = `<p class="mb-0 small">${esc(uploadBlockedReason)}</p>`;
                depAlert.classList.remove('d-none');
            } else {
                depAlert.classList.add('d-none');
            }

            uploadBtn.disabled = !data.can_upload;
            uploadBtn.innerHTML = data.can_upload
                ? (
                    autoFetchEnabled && data.global_missing_deps.length > 0
                        ? '<i class="fas fa-upload"></i> Upload &amp; Reload (Auto-fetch Deps)'
                        : '<i class="fas fa-upload"></i> Upload &amp; Reload'
                )
                : (
                    uploadBlockedReason
                        ? '<i class="fas fa-ban"></i> Full Upload Blocked'
                        : '<i class="fas fa-ban"></i> Cannot Upload (Fix Errors)'
                );
            uploadBtn.title = uploadBlockedReason;

            const partialCompile = data.partial_compile || {};
            if (partialCompile.can_partial_compile) {
                partialBtn.classList.remove('d-none');
                partialBtn.disabled = false;
                partialBtn.innerHTML = `<i class="fas fa-layer-group"></i> Partial Compile Ready MIBs (${Number(partialCompile.ready_count) || 0})`;
            } else {
                partialBtn.classList.add('d-none');
                partialBtn.disabled = true;
            }

        } catch (e) {
            console.error('Validation error:', e);
            alert('Validation failed: ' + e.message);
        } finally {
            indicator.classList.add('d-none');
        }
    },

    uploadFiles: async function(mode = 'full') {
        const input = document.getElementById('mib-upload-input');
        const btn   = document.getElementById('btn-upload');
        const partialBtn = document.getElementById('btn-upload-partial');
        const originalText = btn.innerHTML;
        const originalPartialText = partialBtn ? partialBtn.innerHTML : '';
        const normalizedMode = mode === 'partial' ? 'partial' : 'full';
        let controlsRestored = false;
        const restoreControls = () => {
            if (controlsRestored) return;
            controlsRestored = true;
            btn.innerHTML = originalText;
            btn.disabled  = false;
            if (partialBtn) {
                partialBtn.innerHTML = originalPartialText;
                partialBtn.disabled = false;
            }
        };
        btn.innerHTML = normalizedMode === 'partial'
            ? '<i class="fas fa-spinner fa-spin"></i> Partial compiling...'
            : '<i class="fas fa-spinner fa-spin"></i> Uploading...';
        btn.disabled  = true;
        if (partialBtn) {
            partialBtn.disabled = true;
            if (normalizedMode === 'partial') {
                partialBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working...';
            }
        }

        try {
            const formData = new FormData();
            for (let file of input.files) formData.append('files', file);
            formData.append('compile_mode', normalizedMode);
            formData.append('source_group', this.getSelectedSourceGroup());
            if (normalizedMode === 'partial') {
                const readyMibs = (this.validationState && this.validationState.partial_compile
                    ? this.validationState.partial_compile.ready_mibs
                    : []) || [];
                formData.append('compile_targets', JSON.stringify(readyMibs));
            }

            const res = await fetch('/api/mibs/upload', { method: 'POST', body: formData });

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Upload failed (${res.status}): ${errorText}`);
            }

            const data = await res.json();

            if (!data || !data.results || !Array.isArray(data.results)) {
                throw new Error('Invalid response format from server');
            }

            const loaded = data.results.filter(r => r.status === 'loaded').length;
            const skipped = data.results.filter(r => r.status === 'skipped').length;
            const failed = data.results.filter(r => r.status === 'failed').length;
            const errors = data.results.filter(r => r.status === 'error').length;
            const selectedCount = input.files ? input.files.length : data.results.length;
            const processedCount = data.results.length;

            let message = normalizedMode === 'partial'
                ? `Partial Compile Complete!\n\n✓ Successfully loaded: ${loaded}\n`
                : `Upload Complete!\n\n✓ Successfully loaded: ${loaded}\n`;
            if (data.source_group) message += `Source group: ${data.source_group}\n`;
            if (processedCount !== selectedCount) {
                message += `Files processed: ${processedCount} of ${selectedCount}\n`;
            }
            if (skipped > 0) message += `➜ Skipped for now: ${skipped}\n`;
            if (failed > 0) message += `⚠ Failed to load: ${failed}\n`;
            if (errors > 0) message += `✗ Upload errors: ${errors}\n`;
            if (data.dependency_fetch && data.dependency_fetch.enabled) {
                const resolvedDeps = (data.dependency_fetch.resolved || data.dependency_fetch.downloaded || []).length;
                const unresolvedDeps = (data.dependency_fetch.failed || [])
                    .map(name => String(name || '').trim())
                    .filter(Boolean);
                const failedDeps = unresolvedDeps.length;
                const unresolvedPreview = failedDeps > 12
                    ? `${unresolvedDeps.slice(0, 12).join(', ')}, +${failedDeps - 12} more`
                    : unresolvedDeps.join(', ');
                message += `\nRemote dependency fetch: ${resolvedDeps} resolved`;
                if (data.dependency_fetch.using_default_sources) {
                    message += ' via tsmi defaults';
                }
                if (failedDeps > 0) message += `, ${failedDeps} unresolved`;
                message += '\n';
                if (failedDeps > 0 && failed === 0 && errors === 0) {
                    message += 'No MIB modules failed to load; one or more remote dependencies remained unresolved.\n';
                }
                if (failedDeps > 0) {
                    message += `Unresolved dependencies: ${unresolvedPreview}\n`;
                }
            }

            const problemFiles = data.results.filter(r => r.status === 'failed' || r.status === 'error' || r.status === 'skipped');
            if (problemFiles.length > 0) {
                message += `\nDetails:\n`;
                problemFiles.forEach(r => { message += `• ${r.filename}: ${r.error || 'Unknown error'}\n`; });
            }

            restoreControls();
            this.uploadModal.hide();
            alert(message);
            this._statusCacheValid = false;
            await this.loadStatus();
            await this.loadTraps();

        } catch (e) {
            console.error('Upload error:', e);
            alert('Upload failed:\n\n' + e.message);
        } finally {
            restoreControls();
        }
    },

    reloadMibs: async function() {
        const reloadBtn = document.querySelector('button[onclick*="reloadMibs"]');
        const originalHtml = reloadBtn ? reloadBtn.innerHTML : '';

        if (reloadBtn) {
            reloadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            reloadBtn.disabled  = true;
        }

        try {
            const res = await fetch('/api/mibs/reload', { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this._statusCacheValid = false; await this.loadStatus();
            await this.loadTraps();
            const resolvedDeps = data.dependency_fetch ? ((data.dependency_fetch.resolved || data.dependency_fetch.downloaded || []).length) : 0;
            let message = `Reloaded: ${data.loaded} loaded, ${data.failed} failed`;
            if (data.dependency_fetch && data.dependency_fetch.enabled) {
                message += ` · remote deps ${resolvedDeps} resolved`;
                if (data.dependency_fetch.using_default_sources) {
                    message += ' via defaults';
                }
            }
            TrishulUtils.showNotification(message, 'success');
        } catch (e) {
            console.error('Reload failed', e);
            TrishulUtils.showNotification('Reload failed: ' + e.message, 'error');
        } finally {
            if (reloadBtn) {
                reloadBtn.innerHTML = originalHtml;
                reloadBtn.disabled  = false;
            }
        }
    },

    deleteMib: async function(filename) {
        await this.deleteMibs([filename]);
    },

    deleteSelectedMibs: async function() {
        await this.deleteMibs(this.getSelectedDeletablePaths());
    },

    exportSelectedMibs: async function(format = 'json') {
        const selection = this.getSelectedExportModules();
        if (selection.modules.length === 0) {
            if (selection.selectedCount > 0) {
                TrishulUtils.showNotification('Selected MIBs are not part of the active bundle yet', 'warning');
            } else {
                TrishulUtils.showNotification('Select at least one MIB to export', 'warning');
            }
            return;
        }

        const filters = this.getMibFilterState();
        const result = await this.exportCatalog(format, {
            export_type: this.getExportType(),
            modules: selection.modules,
            source_groups: filters.sourceGroup ? [filters.sourceGroup] : [],
        });
        if (result?.ok && selection.skippedCount > 0) {
            TrishulUtils.showNotification(
                `${selection.skippedCount} selected MIBs were skipped because they are not loaded in the active bundle`,
                'warning',
                5000,
            );
        }
    },

    downloadMib: async function(path) {
        await this.downloadMibSources([path]);
    },

    downloadSelectedMibs: async function() {
        await this.downloadMibSources(this.getSelectedDownloadablePaths());
    },

    downloadMibSources: async function(paths) {
        const normalized = Array.from(
            new Set(
                (Array.isArray(paths) ? paths : [])
                    .map((path) => String(path || '').trim())
                    .filter(Boolean)
            )
        );
        if (normalized.length === 0) {
            TrishulUtils.showNotification('Select at least one stored MIB source to download', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/mibs/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: normalized }),
            });
            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(errorText || `Download failed (${res.status})`);
            }
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename=\"([^\"]+)\"/);
            const filename = match ? match[1] : (normalized.length > 1 ? 'mibs.zip' : 'source.mib');
            this.triggerDownload(blob, filename);
            TrishulUtils.showNotification(`Download ready: ${filename}`, 'success');
        } catch (e) {
            console.error('MIB source download failed:', e);
            TrishulUtils.showNotification(`MIB download failed: ${e.message}`, 'error', 5000);
        }
    },

    deleteMibs: async function(paths) {
        const normalized = Array.from(
            new Set(
                (Array.isArray(paths) ? paths : [])
                    .map(path => String(path || '').trim())
                    .filter(Boolean)
            )
        );

        if (normalized.length === 0) {
            TrishulUtils.showNotification('Select at least one MIB to delete', 'warning');
            return;
        }

        const title = normalized.length === 1 ? `Delete ${normalized[0]}?` : `Delete ${normalized.length} MIB files?`;
        const preview = normalized.slice(0, 5);
        const overflowText = normalized.length > 5 ? `...and ${normalized.length - 5} more` : '';
        const message =
            `<ul>${preview.map(path => `<li>${TrishulUtils.escapeHtml(path)}</li>`).join('')}</ul>` +
            (overflowText ? `<p class="mb-2">${TrishulUtils.escapeHtml(overflowText)}</p>` : '') +
            `<p class="mb-0">This will remove the selected MIB source files and rebuild the active MIB bundle.</p>`;
        const confirmed = await TrishulUtils.confirmDialog({
            title,
            message,
            confirmLabel: 'Delete',
            variant: 'danger',
        });
        if (!confirmed) return;

        normalized.forEach(path => this.deletingMibPaths.add(path));
        this.renderMibList();
        this.renderFailedMibs(this.getFailedMibs());

        try {
            const res = await fetch('/api/mibs/delete-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: normalized }),
            });
            let data = {};
            try {
                data = await res.json();
            } catch (_error) {
                data = {};
            }
            if (!res.ok) {
                throw new Error(data.detail || 'Delete failed');
            }

            this.selectedMibPaths.clear();
            this.deletingMibPaths.clear();
            this._statusCacheValid = false;
            await this.loadStatus();
            await this.loadTraps();

            const resolvedDeps = data.dependency_fetch ? ((data.dependency_fetch.resolved || data.dependency_fetch.downloaded || []).length) : 0;
            const deletedCount = Number(data.deleted_count || normalized.length || 0);
            let notification = deletedCount === 1
                ? `Deleted ${normalized[0]}`
                : `Deleted ${deletedCount} MIBs`;
            if (data && data.reload_applied) {
                notification += ` · ${Number(data.loaded || 0)} loaded, ${Number(data.failed || 0)} failed`;
                if (data.dependency_fetch && data.dependency_fetch.enabled) {
                    notification += ` · remote deps ${resolvedDeps} resolved`;
                    if (data.dependency_fetch.using_default_sources) {
                        notification += ' via defaults';
                    }
                }
            }
            TrishulUtils.showNotification(notification, 'success', 5000);
        } catch (e) {
            console.error('Delete failed:', e);
            normalized.forEach(path => this.deletingMibPaths.delete(path));
            this.renderMibList();
            this.renderFailedMibs(this.getFailedMibs());
            alert(`Delete failed: ${e.message}`);
        }
    },

    getSelectedSourceGroup: function() {
        const input = document.getElementById('mib-upload-group');
        const value = String(input && input.value ? input.value : '').trim().replace(/\\/g, '/');
        return value || 'common';
    },

    populateSourceGroupOptions: function(groups) {
        const datalist = document.getElementById('mib-source-group-options');
        if (!datalist) return;
        const items = Array.isArray(groups) ? groups : [];
        datalist.innerHTML = items.map(group => {
            const name = typeof group === 'string' ? group : group.name;
            if (!name || name === 'auto-fetched') return '';
            return `<option value="${TrishulUtils.escapeHtml(name || '')}"></option>`;
        }).join('');
    },

    populateMibFilterSourceGroupOptions: function(groups, mibs, sourceInventory) {
        const select = document.getElementById('mib-filter-source-group');
        if (!select) return;

        const previous = String(select.value || '');
        const names = new Set();

        (Array.isArray(groups) ? groups : []).forEach(group => {
            const name = typeof group === 'string' ? group : group && group.name;
            if (name) names.add(String(name));
        });

        (Array.isArray(mibs) ? mibs : []).forEach(mib => {
            if (mib && mib.source_group) names.add(String(mib.source_group));
        });
        (Array.isArray(sourceInventory) ? sourceInventory : []).forEach(mib => {
            if (mib && mib.source_group) names.add(String(mib.source_group));
        });

        const options = ['<option value="">All source groups</option>'];
        Array.from(names)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
            .forEach(name => {
                options.push(`<option value="${TrishulUtils.escapeHtml(name)}">${TrishulUtils.escapeHtml(name)}</option>`);
            });

        select.innerHTML = options.join('');
        if (previous && names.has(previous)) {
            select.value = previous;
        }
    },

    populateExportSourceGroupOptions: function(groups, mibs, sourceInventory) {
        const select = document.getElementById('mib-export-source-group');
        if (!select) return;

        const previous = String(select.value || '');
        const names = new Set();

        (Array.isArray(groups) ? groups : []).forEach(group => {
            const name = typeof group === 'string' ? group : group && group.name;
            if (name) names.add(String(name));
        });

        (Array.isArray(mibs) ? mibs : []).forEach(mib => {
            if (mib && mib.source_group) names.add(String(mib.source_group));
        });
        (Array.isArray(sourceInventory) ? sourceInventory : []).forEach(mib => {
            if (mib && mib.source_group) names.add(String(mib.source_group));
        });

        const options = ['<option value="">All active MIBs</option>'];
        Array.from(names)
            .filter(name => name && name !== 'auto-fetched')
            .sort((a, b) => a.localeCompare(b))
            .forEach(name => {
                options.push(`<option value="${TrishulUtils.escapeHtml(name)}">${TrishulUtils.escapeHtml(name)}</option>`);
            });

        select.innerHTML = options.join('');
        if (previous && names.has(previous)) {
            select.value = previous;
        }
    },

    exportCatalog: async function(format = 'json', options = {}) {
        const payload = {
            format: format === 'csv' ? 'csv' : 'json',
            modules: Array.isArray(options.modules) ? options.modules : [],
            notifications: Array.isArray(options.notifications) ? options.notifications : [],
            source_groups: Array.isArray(options.source_groups) ? options.source_groups : [],
            export_type: String(options.export_type || 'catalog'),
        };

        try {
            const res = await fetch('/api/mibs/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(errorText || `Export failed (${res.status})`);
            }
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            const filename = match ? match[1] : `trishul-mibs.${payload.format === 'csv' ? 'csv' : 'json'}`;
            this.triggerDownload(blob, filename);
            TrishulUtils.showNotification(`Export ready: ${filename}`, 'success');
            return { ok: true, filename };
        } catch (e) {
            console.error('Catalog export failed:', e);
            TrishulUtils.showNotification(`Catalog export failed: ${e.message}`, 'error', 5000);
            return { ok: false, error: e };
        }
    },

    exportScopedCatalog: async function(format = 'json') {
        const groupSelect = document.getElementById('mib-export-source-group');
        const typeSelect = document.getElementById('mib-export-type');
        const selectedGroup = String(groupSelect && groupSelect.value ? groupSelect.value : '').trim();
        const exportType = String(typeSelect && typeSelect.value ? typeSelect.value : 'catalog').trim();

        await this.exportCatalog(format, {
            export_type: exportType || 'catalog',
            source_groups: selectedGroup ? [selectedGroup] : [],
        });
    },

    exportTrapCatalog: async function(format = 'json') {
        await this.exportCatalog(format, {
            export_type: 'notifications',
        });
    },

    exportCurrentTrap: async function(format = 'json') {
        if (!this.currentTrapData) {
            TrishulUtils.showNotification('No trap selected for export', 'warning');
            return;
        }
        await this.exportCatalog(format, {
            export_type: 'notifications',
            notifications: [this.currentTrapData.full_name || this.currentTrapData.name || this.currentTrapData.oid],
        });
    },

    triggerDownload: function(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    },

    showDependencyHelp: function() {
        alert(
            'How to resolve missing dependencies:\n\n' +
            '1. Upload the missing MIBs manually using this dialog\n' +
            '2. Or use partial compile for the ready MIBs only\n' +
            '3. Reload after the dependencies are available\n\n' +
            'Validation never performs remote fetches. Auto-fetch, if enabled in Settings, only runs during upload/reload.'
        );
    },

    fetchDependenciesFromElement: async function(button) {
        const deps = TrishulUtils.decodeDataAttr(button?.dataset?.deps || '', []);
        await this.fetchDependencies(deps);
    },

    fetchDependenciesFromValidation: async function() {
        const button = document.getElementById('btn-fetch-dependencies');
        const deps = TrishulUtils.decodeDataAttr(button?.dataset?.deps || '', []);
        await this.fetchDependencies(deps);
    },

    fetchDependencies: async function(dependencies) {
        const deps = Array.isArray(dependencies) ? dependencies.filter(Boolean) : [];
        if (deps.length === 0) {
            TrishulUtils.showNotification('No missing dependencies to fetch', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/mibs/fetch-dependencies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dependencies: deps, reload_after_fetch: true })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || 'Dependency fetch failed');
            }

            const downloaded = (data.downloaded || []).length;
            const cached = (data.cached || []).length;
            const failed = (data.failed || []).length;
            let message = `Dependency fetch complete: ${downloaded} downloaded`;
            if (cached > 0) message += `, ${cached} cached`;
            if (failed > 0) message += `, ${failed} failed`;
            TrishulUtils.showNotification(message, failed > 0 ? 'warning' : 'success', 5000);
            this._statusCacheValid = false; await this.loadStatus();
            await this.loadTraps();
            const input = document.getElementById('mib-upload-input');
            if (input && input.files && input.files.length > 0) {
                await this.validateFiles();
            }
        } catch (e) {
            console.error('Dependency fetch failed:', e);
            TrishulUtils.showNotification(`Dependency fetch failed: ${e.message}`, 'error', 5000);
        }
    }

};

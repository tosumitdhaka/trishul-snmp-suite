window.BrowserModule = {
    currentModule: null,
    currentTypeFilter: null,
    currentView: 'module',
    searchTimeout: null,
    allModules: [],
    isSearchActive: false,
    currentSearchResults: [],
    nodeCache: {},
    _oidIndex: null,
    _oidIndexBundleId: null,
    _activeBundleId: null,
    _windowListeners: [],
    _mibsBroadcastTimer: null,
    _searchRequestId: 0,
    _bundleSummary: null,
    _currentDetailData: null,

    STATE_KEY: 'browserState',

    // BRW-23: bundle-scoped dismissal for the "bundle predates enum/units
    // metadata" notice — same shape as the MIB Manager banner (MGR-14).
    RECOMPILE_NOTICE_KEY: 'trishul_browser_recompile_notice_dismissed',

    // UI type labels the server path emits (mirrors browser_service._ui_type).
    UI_NODE_TYPES: [
        'Module', 'Node', 'MibTable', 'MibTableRow', 'MibTableColumn',
        'MibScalar', 'NotificationType', 'ObjectGroup', 'ModuleCompliance',
        'ModuleIdentity',
    ],

    // Raw SMI type tokens (as stored in the oid-index sidecar) → UI type
    // labels, so fast-path results render the same icons/badges as server
    // results (BRW-12).
    OID_INDEX_UI_TYPE_MAP: {
        'NOTIFICATION-TYPE': 'NotificationType',
        'TRAP-TYPE': 'NotificationType',
        'OBJECT-GROUP': 'ObjectGroup',
        'MODULE-COMPLIANCE': 'ModuleCompliance',
        'MODULE-IDENTITY': 'ModuleIdentity',
        'SCALAR': 'MibScalar',
        'TABLE': 'MibTable',
        'ROW': 'MibTableRow',
        'COLUMN': 'MibTableColumn',
    },

    getNodeCacheKey: function(oid, module) {
        return `${module || ''}::${oid || ''}`;
    },

    makeNodeRef: function(oid, module) {
        return `${module || ''}|${oid || ''}`;
    },

    parseNodeRef: function(ref) {
        const value = String(ref || '');
        const separator = value.indexOf('|');
        if (separator === -1) {
            return { module: '', oid: value };
        }
        return {
            module: value.slice(0, separator),
            oid: value.slice(separator + 1),
        };
    },

    cacheNode: function(node) {
        if (node && node.oid) {
            this.nodeCache[this.getNodeCacheKey(node.oid, node.module)] = node;
            if (!this.nodeCache[node.oid]) {
                this.nodeCache[node.oid] = node;
            }
        }
    },

    cacheNodesRecursive: function(nodes) {
        if (!Array.isArray(nodes)) return;
        nodes.forEach(node => {
            this.cacheNode(node);
            if (Array.isArray(node.children)) {
                this.cacheNodesRecursive(node.children);
            }
        });
    },

    isNodeExpanded: function(nodeEl) {
        const childrenEl = nodeEl?.querySelector(':scope > .tree-children');
        return !!childrenEl && childrenEl.classList.contains('is-expanded');
    },

    setNodeExpanded: function(nodeEl, expanded) {
        const childrenEl = nodeEl?.querySelector(':scope > .tree-children');
        const toggleBtn = nodeEl?.querySelector(':scope > .tree-node-content > .tree-expand-icon');

        if (childrenEl) {
            childrenEl.classList.toggle('is-expanded', !!expanded);
            childrenEl.classList.toggle('is-collapsed', !expanded);
        }

        if (toggleBtn) {
            // BRW-13: the expand control is a button wrapping the chevron —
            // flip the glyph inside it and keep its expanded state announced.
            const icon = toggleBtn.querySelector('i') || toggleBtn;
            icon.classList.toggle('fa-chevron-down', !!expanded);
            icon.classList.toggle('fa-chevron-right', !expanded);
            toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
    },

    buildTreePlaceholder: function(options) {
        return TrishulUtils.buildPanelPlaceholder(options);
    },
    
    init: async function() {
        this.currentView = 'module';
        this.currentSearchResults = [];
        this.nodeCache = {};
        // BRW-08: oid-index state is bundle-scoped; reset it alongside the
        // node cache so a page re-entry can never serve the previous
        // bundle's data. init()'s loadOidIndex() then re-resolves the
        // active bundle id (from the modules/tree payload when the backend
        // includes it, else via /api/mibs/status).
        this._oidIndex = null;
        this._oidIndexBundleId = null;
        this._activeBundleId = null;
        // BRW-23: detail-panel notice state is bundle-scoped as well.
        this._bundleSummary = null;
        this._currentDetailData = null;
        this.setButtonStates();

        // Restore state if exists
        this.restoreState();
        this.applyViewLayout();

        // MGR-12: bundle mutations broadcast over WS (from any client/tab) —
        // drop bundle-scoped caches and refresh the visible tree.
        this.bindWindowEvent('trishul:ws:mibs', () => this.handleMibsBroadcast());

        // Load modules first, then tree
        await this.loadModules();
        // BRW-19: apply the restored filter/search UI only after the module
        // options exist, so the select values and the filter state agree.
        this.applyRestoredUiState();
        this.loadTree();
        this.loadOidIndex();
        // BRW-23: one status fetch per page entry powers the detail-panel
        // "bundle predates enum/units metadata" notice.
        this.loadBundleSummary();
        
        // Check if coming from Walker/Trap Sender
        const searchOid = sessionStorage.getItem('browserSearchOid');
        const filterType = sessionStorage.getItem('browserFilterType');
        
        if (searchOid) {
            // Clear any pending restore state — previous session's tree selection
            // must not conflict with this new programmatic search.  The node being
            // searched may not be in the (unexpanded) tree yet, which would trigger
            // a spurious "Could not find node" console.warn.
            this.pendingSelectedOid   = null;
            this.pendingExpandedNodes = [];

            document.getElementById('browser-search-input').value = searchOid;
            
            if (filterType) {
                document.getElementById('browser-type-filter').value = filterType;
                this.currentTypeFilter = filterType;
            }
            
            setTimeout(() => {
                this.search();
                TrishulUtils.showNotification(`Searching for: ${searchOid}`, 'info');
            }, 300);
            
            sessionStorage.removeItem('browserSearchOid');
            sessionStorage.removeItem('browserFilterType');
        }
    },
    
    destroy: function() {
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }
        if (this._mibsBroadcastTimer) {
            clearTimeout(this._mibsBroadcastTimer);
            this._mibsBroadcastTimer = null;
        }
        this._windowListeners.forEach(([type, handler]) => {
            window.removeEventListener(type, handler);
        });
        this._windowListeners = [];
        // Invalidate any in-flight search so stale responses can't render
        // after the page is gone.
        this._searchRequestId += 1;
        // Save state before leaving
        this.saveState();
    },

    bindWindowEvent: function(type, handler) {
        window.addEventListener(type, handler);
        this._windowListeners.push([type, handler]);
    },

    // MGR-12: the active bundle changed elsewhere (other tab or client).
    // Every bundle-scoped cache must go; if the tree is on screen, reload it.
    handleMibsBroadcast: function() {
        this._oidIndex = null;
        this._oidIndexBundleId = null;
        this._activeBundleId = null;
        this.nodeCache = {};
        // BRW-23: the detail-panel notice follows the (possibly new)
        // bundle's manifest, so refresh the status snapshot too.
        this._bundleSummary = null;
        this.loadBundleSummary();
        if (!document.getElementById('browser-tree-container')) return;
        if (this.isSearchActive) return;
        // Coalesce broadcast bursts into a single reload so a flurry of bundle
        // pushes (e.g. during a recompile) does not fan out into N loadTree calls.
        if (this._mibsBroadcastTimer) {
            clearTimeout(this._mibsBroadcastTimer);
        }
        this._mibsBroadcastTimer = setTimeout(() => {
            this._mibsBroadcastTimer = null;
            this.loadTree();
        }, 250);
    },

    // BRW-27: fetch the lightweight bundle summary once per page entry — a
    // manifest-only read, unlike the full /api/mibs/status source-inventory
    // scan. It feeds the detail-panel recompile notice (BRW-23) and keeps
    // the last-seen bundle id fresh for the oid-index validation (BRW-08).
    loadBundleSummary: async function() {
        try {
            const res = await fetch('/api/mibs/bundle-summary');
            if (!res.ok) return null;
            const data = await res.json();
            this._bundleSummary = data || null;
            if (this._bundleSummary) {
                this.noteActiveBundleId(this._bundleSummary);
            }
            // The snapshot can arrive after a node detail is already on
            // screen — re-render it when the notice state changed in either
            // direction (newly due, or no longer due after a bundle switch).
            if (
                this._currentDetailData
                && (this.shouldShowRecompileNotice() || document.getElementById('browser-recompile-notice'))
            ) {
                this.renderDetails(this._currentDetailData);
            }
            return this._bundleSummary;
        } catch (_error) {
            return null;
        }
    },

    shouldShowRecompileNotice: function() {
        const snapshot = this._bundleSummary;
        if (!snapshot || !snapshot.recompile_recommended) return false;
        return !this.isRecompileNoticeDismissed(snapshot.active_bundle_id);
    },

    isRecompileNoticeDismissed: function(bundleId) {
        if (bundleId == null) return false;
        try {
            const raw = localStorage.getItem(this.RECOMPILE_NOTICE_KEY);
            if (!raw) return false;
            const state = JSON.parse(raw);
            return Boolean(
                state
                && state.dismissed === true
                && String(state.bundle_id) === String(bundleId)
            );
        } catch (_error) {
            return false;
        }
    },

    dismissRecompileNotice: function() {
        const bundleId = this._bundleSummary && this._bundleSummary.active_bundle_id != null
            ? this._bundleSummary.active_bundle_id
            : null;
        try {
            localStorage.setItem(this.RECOMPILE_NOTICE_KEY, JSON.stringify({
                bundle_id: bundleId,
                dismissed: true,
            }));
        } catch (_error) {
            // Storage unavailable — the notice simply returns next visit.
        }
        const notice = document.getElementById('browser-recompile-notice');
        if (notice) notice.remove();
    },

    recompileNoticeMissingText: function() {
        const missing = Array.isArray(this._bundleSummary && this._bundleSummary.missing_capabilities)
            ? this._bundleSummary.missing_capabilities.filter(Boolean)
            : [];
        return missing.length ? missing.join('/') : 'enum/units';
    },

    buildRecompileNotice: function() {
        const esc = TrishulUtils.escapeHtml;
        return `
            <div class="alert alert-warning small d-flex align-items-start gap-2 mb-3 py-2" id="browser-recompile-notice" role="status">
                <i class="fas fa-circle-info mt-1" aria-hidden="true"></i>
                <div class="flex-grow-1">
                    This bundle predates ${esc(this.recompileNoticeMissingText())} metadata —
                    <a href="#mibs">recompile it in MIB Manager</a>.
                </div>
                <button type="button" class="btn-close" aria-label="Dismiss the recompile notice"
                        onclick="BrowserModule.dismissRecompileNotice()"></button>
            </div>
        `;
    },

    saveState: function() {
        // Get expanded nodes
        const expandedNodes = [];
        document.querySelectorAll('.tree-node').forEach(node => {
            if (this.isNodeExpanded(node)) {
                const oid = node.getAttribute('data-oid');
                const module = node.getAttribute('data-module') || '';
                if (oid) expandedNodes.push(this.makeNodeRef(oid, module));
            }
        });
        
        // Get selected node
        const selectedNode = document.querySelector('.tree-node-content.is-selected, .search-result-item.is-selected');
        let selectedOid = null;
        let selectedModule = null;
        if (selectedNode) {
            const parentNode = selectedNode.closest('.tree-node, .search-result-item');
            if (parentNode) {
                selectedOid = parentNode.getAttribute('data-oid') || 
                            parentNode.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
                selectedModule = parentNode.getAttribute('data-module') || null;
            }
        }
        
        const state = {
            currentView: this.currentView,
            currentModule: this.currentModule,
            currentTypeFilter: this.currentTypeFilter,
            searchQuery: document.getElementById('browser-search-input')?.value || '',
            isSearchActive: this.isSearchActive,
            expandedNodes: expandedNodes,
            selectedOid: selectedOid,
            selectedModule: selectedModule,
        };
        
        sessionStorage.setItem(this.STATE_KEY, JSON.stringify(state));
    },

    restoreState: function() {
        try {
            const stateStr = sessionStorage.getItem(this.STATE_KEY);
            if (!stateStr) return;
            
            const state = JSON.parse(stateStr);
            
            // Restore view
            this.currentView = state.currentView || 'module';
            
            // Restore filters
            this.currentModule = state.currentModule;
            this.currentTypeFilter = state.currentTypeFilter;
            if (this.currentView === 'oid') {
                this.currentModule = null;
                this.currentTypeFilter = null;
            }
            
            // Store expanded nodes and selected OID for later restoration
            this.pendingExpandedNodes = (state.expandedNodes || []).map(item => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object') {
                    return this.makeNodeRef(item.oid, item.module);
                }
                return '';
            }).filter(Boolean);
            this.pendingSelectedOid = state.selectedOid;
            this.pendingSelectedModule = state.selectedModule || null;

            // BRW-19: filter/search UI values are applied by
            // applyRestoredUiState() once the module options exist — applying
            // them against a not-yet-populated select used to leave the UI
            // showing "All Modules" while the tree was actually filtered.
            this._restoredUi = {
                moduleFilter: this.currentModule,
                typeFilter: this.currentTypeFilter,
                searchQuery: String(state.searchQuery || ''),
            };

        } catch (e) {
            console.error('Failed to restore state:', e);
        }
    },

    applyRestoredUiState: function() {
        const restored = this._restoredUi;
        if (!restored) return;
        this._restoredUi = null;

        const moduleSelect = document.getElementById('browser-module-filter');
        if (moduleSelect && restored.moduleFilter) {
            moduleSelect.value = restored.moduleFilter;
            if (moduleSelect.value !== restored.moduleFilter) {
                // Module no longer exists in the catalog — clear the filter
                // so the UI and the tree state agree.
                this.currentModule = null;
            }
        }

        const typeSelect = document.getElementById('browser-type-filter');
        if (typeSelect && restored.typeFilter) {
            typeSelect.value = restored.typeFilter;
        }

        if (restored.searchQuery) {
            const searchInput = document.getElementById('browser-search-input');
            const clearBtn = document.getElementById('btn-clear-search');
            if (searchInput) {
                searchInput.value = restored.searchQuery;
                if (clearBtn) clearBtn.classList.remove('d-none');
            }
        }

        this.setButtonStates();

        if (restored.searchQuery.trim().length >= 2) {
            this.search();
        }
    },

    restoreExpandedNodes: async function() {
        if (!this.pendingExpandedNodes || this.pendingExpandedNodes.length === 0) {
            // Even if no expanded nodes, still try to restore selected node
            if (this.pendingSelectedOid) {
                await this.restoreSelectedNode();
            }
            return;
        }
        
        // Expand nodes sequentially to ensure proper loading
        for (const ref of this.pendingExpandedNodes) {
            await this.expandNodeByRef(ref);
        }
        
        // After all expansions, restore selected node
        if (this.pendingSelectedOid) {
            await this.restoreSelectedNode();
        }

        // Clear pending state
        this.pendingExpandedNodes = [];
        this.pendingSelectedOid = null;
        this.pendingSelectedModule = null;
    },

    // Module rows carry the OID of the module's first root node, so a
    // module header and its first child can share the same
    // [data-oid][data-module] pair. querySelector() would always resolve
    // to the module header (it precedes its children in the DOM), which
    // used to hijack the selection highlight, expansion, and state restore
    // for that child. Prefer plain tree rows and fall back to the module
    // header only when nothing else matches.
    findTreeNodeEl: function(oid, module) {
        if (!oid) return null;
        const selector = module
            ? `.tree-node[data-oid="${oid}"][data-module="${module}"]`
            : `.tree-node[data-oid="${oid}"]`;
        const candidates = document.querySelectorAll(selector);
        for (const candidate of candidates) {
            if (!candidate.classList.contains('tree-module')) {
                return candidate;
            }
        }
        return document.querySelector(selector);
    },

    expandNodeByRef: async function(ref) {
        const nodeRef = this.parseNodeRef(ref);
        const nodeEl = this.findTreeNodeEl(nodeRef.oid, nodeRef.module);
        if (!nodeEl) {
            return;
        }
        
        const children = nodeEl.querySelector(':scope > .tree-children');
        
        if (!children) {
            return;
        }
        
        // Load children if not loaded
        if (children.innerHTML.trim() === '') {
            try {
                await this.loadChildrenIntoNode(nodeEl);
            } catch (e) {
                console.error(`Failed to load children for ${nodeRef.oid}:`, e);
            }
        }
        
        this.setNodeExpanded(nodeEl, true);
    },

    expandNodeByOid: async function(oid, module) {
        return this.expandNodeByRef(this.makeNodeRef(oid, module));
    },

    restoreSelectedNode: async function() {
        if (!this.pendingSelectedOid) {
            return;
        }
        
        // Wait a bit for DOM to settle
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Try to find the node in the tree (prefers a plain row over a
        // module header that shares the same OID — see findTreeNodeEl).
        let nodeEl = this.findTreeNodeEl(this.pendingSelectedOid, this.pendingSelectedModule);

        if (!nodeEl) {
            // Node might be in search results
            nodeEl = this.pendingSelectedModule
                ? document.querySelector(`.search-result-item[data-oid="${this.pendingSelectedOid}"][data-module="${this.pendingSelectedModule}"]`)
                : document.querySelector(`.search-result-item[data-oid="${this.pendingSelectedOid}"]`);
        }
        
        if (nodeEl) {
            // Highlight the node
            const contentEl = nodeEl.querySelector('.tree-node-content') || nodeEl;
            if (contentEl) {
                contentEl.classList.add('is-selected');
                
                // Scroll into view
                contentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            
            // Load details
            try {
                await this.loadNodeDetails(this.pendingSelectedOid, this.pendingSelectedModule);
            } catch (e) {
                console.error('Failed to restore node details:', e);
                const panel = document.getElementById('browser-details-panel');
                if (panel) {
                    panel.innerHTML = `
                        <div class="text-center text-muted p-5">
                            <i class="fas fa-exclamation-triangle fa-3x mb-3 app-header-icon is-warning"></i>
                            <p>Could not restore previous selection</p>
                            <p class="small">The node may have been removed or filtered out</p>
                            <button type="button" class="btn btn-sm btn-app-primary-outline mt-2" onclick="BrowserModule.clearSelection()">
                                <i class="fas fa-times"></i> Clear Selection
                            </button>
                        </div>
                    `;
                }
            }
        } else {
            // Node not found — clear silently, no console.warn needed
            this.pendingSelectedOid = null;
            this.pendingSelectedModule = null;
        }
    },

    clearSelection: function() {
        document.querySelectorAll('.tree-node-content, .search-result-item').forEach(el => {
            el.classList.remove('is-selected', 'active');
        });
        
        const panel = document.getElementById('browser-details-panel');
        if (panel) {
            panel.innerHTML = `
                <div class="text-center text-muted p-5">
                    <i class="fas fa-mouse-pointer fa-3x mb-3 text-muted"></i>
                    <p class="small">Select an OID from the tree to view details</p>
                </div>
            `;
        }
        
        this.pendingSelectedOid = null;
    },
    
    setButtonStates: function() {
        const btnModule = document.getElementById('btn-view-module');
        const btnOid = document.getElementById('btn-view-oid');
        
        if (!btnModule || !btnOid) return;
        
        if (this.currentView === 'module') {
            btnModule.className = 'btn btn-sm btn-app-primary';
            btnOid.className = 'btn btn-sm btn-app-secondary';
        } else {
            btnOid.className = 'btn btn-sm btn-app-primary';
            btnModule.className = 'btn btn-sm btn-app-secondary';
        }
    },

    applyViewLayout: function() {
        const filtersSection = document.getElementById('filters-section');
        const searchSection = document.getElementById('search-section');
        const title = document.getElementById('browser-tree-title');

        if (!filtersSection || !searchSection) return;

        if (this.currentView === 'oid') {
            filtersSection.classList.add('d-none');
            searchSection.classList.add('d-none');
            if (title) {
                title.textContent = 'OID Hierarchy (Standard Tree)';
            }
            return;
        }

        filtersSection.classList.remove('d-none');
        searchSection.classList.remove('d-none');
        if (title) {
            title.textContent = 'MIB Tree (By Module)';
        }
    },
    
    loadModules: async function() {
        try {
            const res = await fetch('/api/mibs/browse/modules');
            
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            
            const data = await res.json();
            this.allModules = data.modules || [];
            this.noteActiveBundleId(data);
            
            // Populate filter dropdown
            const select = document.getElementById('browser-module-filter');
            if (!select) return;
            
            select.innerHTML = '<option value="">All Modules</option>';
            
            if (this.allModules.length === 0) {
                select.innerHTML += '<option disabled>No modules loaded</option>';
            } else {
                this.allModules.forEach(mod => {
                    const option = document.createElement('option');
                    option.value = mod.name;
                    option.textContent = `${mod.name} (${mod.objects})`;
                    select.appendChild(option);
                });
            }
            
            return this.allModules;
        } catch (e) {
            console.error('Failed to load modules:', e);
            return [];
        }
    },

    buildModuleTreeUrl: function() {
        const params = new URLSearchParams();
        if (this.currentModule) {
            params.set('module', this.currentModule);
        }
        if (this.currentTypeFilter) {
            params.set('type_filter', this.currentTypeFilter);
        }
        const query = params.toString();
        return query ? `/api/mibs/browse/tree/module?${query}` : '/api/mibs/browse/tree/module';
    },

    buildOidTreeUrl: function(rootOid, moduleName) {
        const params = new URLSearchParams({
            root_oid: rootOid,
            depth: '1'
        });
        const effectiveModule = this.currentView === 'oid' ? '' : (moduleName || '');
        if (effectiveModule) {
            params.set('module', effectiveModule);
        }
        if (this.currentView !== 'oid' && this.currentTypeFilter) {
            params.set('type_filter', this.currentTypeFilter);
        }
        return `/api/mibs/browse/tree/oid?${params.toString()}`;
    },

    getNodeModule: function(nodeEl) {
        if (this.currentView === 'oid') return '';
        if (!nodeEl) return this.currentModule || '';
        return nodeEl.dataset.module || this.currentModule || '';
    },

    loadChildrenIntoNode: async function(nodeEl) {
        if (!nodeEl) return [];

        const oid = nodeEl.getAttribute('data-oid') || '';
        const moduleName = this.getNodeModule(nodeEl);
        const childrenEl = nodeEl.querySelector(':scope > .tree-children');

        if (!oid || !childrenEl || childrenEl.innerHTML.trim() !== '') {
            return [];
        }

        const res = await fetch(this.buildOidTreeUrl(oid, moduleName));
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        this.noteActiveBundleId(data);
        const children = Array.isArray(data.children) ? data.children : [];
        if (children.length > 0) {
            this.cacheNodesRecursive(children);
            childrenEl.innerHTML = children.map(child =>
                this.buildTreeNodeHtml(child, 0)
            ).join('');
        }
        return children;
    },
    
    switchView: function(view) {
        this.currentView = view;
        this.setButtonStates();
        this.applyViewLayout();
        this.saveState();

        if (view === 'oid') {
            // Clear filters
            this.currentModule = null;
            this.currentTypeFilter = null;
            document.getElementById('browser-module-filter').value = '';
            document.getElementById('browser-type-filter').value = '';
            document.getElementById('browser-search-input').value = '';
            document.getElementById('btn-clear-search').classList.add('d-none');
            this.isSearchActive = false;
        }

        this.loadTree();
    },
    
    applyFilters: function() {
        const moduleSelect = document.getElementById('browser-module-filter');
        const typeSelect = document.getElementById('browser-type-filter');
        
        this.currentModule = moduleSelect.value || null;
        this.currentTypeFilter = typeSelect.value || null;

        this.saveState();
        
        const searchInput = document.getElementById('browser-search-input');
        if (searchInput.value.trim().length >= 2) {
            this.search();
        } else {
            this.loadTree();
        }
    },

    syncFiltersFromUi: function() {
        if (this.currentView === 'oid') {
            this.currentModule = null;
            this.currentTypeFilter = null;
            return;
        }
        const moduleSelect = document.getElementById('browser-module-filter');
        const typeSelect = document.getElementById('browser-type-filter');
        this.currentModule = moduleSelect && moduleSelect.value ? moduleSelect.value : null;
        this.currentTypeFilter = typeSelect && typeSelect.value ? typeSelect.value : null;
    },
    
    clearFilters: function() {
        document.getElementById('browser-module-filter').value = '';
        document.getElementById('browser-type-filter').value = '';
        this.currentModule = null;
        this.currentTypeFilter = null;
        
        const searchInput = document.getElementById('browser-search-input');
        if (searchInput.value.trim().length >= 2) {
            this.search();
        } else {
            this.loadTree();
        }
    },
    
    // BRW-21: the tree count badge means different things per view — keep the
    // number but announce what it counts via title/aria-label.
    setTreeCount: function(count, meaning) {
        const badge = document.getElementById('browser-tree-count');
        if (!badge) return;
        badge.textContent = count;
        badge.title = meaning;
        badge.setAttribute('aria-label', `${meaning}: ${count}`);
    },

    clearSearch: function() {
        document.getElementById('browser-search-input').value = '';
        // BUG FIX: was style.display = 'none'
        document.getElementById('btn-clear-search').classList.add('d-none');
        this.isSearchActive = false;
        this.loadTree();
        // BRW-21: match the MIBs page — clear returns focus to the input.
        document.getElementById('browser-search-input').focus();
    },

    debounceSearch: function() {
        const searchInput = document.getElementById('browser-search-input');
        const query = searchInput.value.trim();

        // BUG FIX: was style.display = 'block'/'none'
        const clearBtn = document.getElementById('btn-clear-search');
        if (query.length > 0) {
            clearBtn.classList.remove('d-none');
        } else {
            clearBtn.classList.add('d-none');
        }

        clearTimeout(this.searchTimeout);

        if (query.length < 2) {
            if (this.isSearchActive) {
                this.isSearchActive = false;
                this.loadTree();
            }
            return;
        }

        // BRW-21: 300ms debounce (was 500) for snappier feedback, still
        // protecting the server from per-keystroke searches.
        this.searchTimeout = setTimeout(() => this.search(), 300);
    },
    
    // BRW-08: observe the active bundle id from payloads the browser already
    // fetches (modules/tree responses carry `active_bundle_id` when the
    // backend includes it). No-op when the field is absent.
    noteActiveBundleId: function(data) {
        if (!data || typeof data !== 'object') return;
        if (data.active_bundle_id != null) {
            this._activeBundleId = data.active_bundle_id;
        }
    },

    // Fallback bundle-id source when no browser payload carried the field.
    fetchActiveBundleIdFromStatus: async function() {
        try {
            const statusRes = await fetch('/api/mibs/status');
            if (!statusRes.ok) return null;
            const status = await statusRes.json();
            return status && status.active_bundle_id != null ? status.active_bundle_id : null;
        } catch (e) {
            console.error('Failed to resolve active bundle id', e);
            return null;
        }
    },

    loadOidIndex: async function() {
        try {
            // BRW-08: never serve a cached index without validating that it
            // belongs to the currently active bundle. `_activeBundleId` is
            // refreshed by noteActiveBundleId() from the modules/tree
            // payloads; only fall back to /api/mibs/status when no payload
            // has carried the id yet.
            if (this._activeBundleId == null) {
                this._activeBundleId = await this.fetchActiveBundleIdFromStatus();
            }
            const bundleId = this._activeBundleId;
            if (bundleId == null) {
                this._oidIndex = null;
                this._oidIndexBundleId = null;
                return;
            }
            if (this._oidIndex && this._oidIndexBundleId === bundleId) {
                return;
            }
            const res = await fetch(`/api/bundles/${bundleId}/oid-index`);
            if (!res.ok) {
                this._oidIndex = null;
                this._oidIndexBundleId = null;
                return;
            }
            this._oidIndex = await res.json();
            this._oidIndexBundleId = bundleId;
        } catch (e) {
            console.error('Failed to load OID index', e);
            this._oidIndex = null;
            this._oidIndexBundleId = null;
        }
    },

    // BRW-12: map raw SMI type tokens (oid-index sidecar values such as
    // "OBJECT-TYPE" or "NOTIFICATION-TYPE") to the UI type labels the
    // server path produces, so fast-path results get the same icons and
    // badges. Unrecognized values fall back to the generic "Node" label.
    normalizeNodeType: function(rawType) {
        const raw = String(rawType || '').trim();
        if (!raw) return 'Node';
        if (this.UI_NODE_TYPES.indexOf(raw) !== -1) return raw;
        const mapped = this.OID_INDEX_UI_TYPE_MAP[raw.toUpperCase()];
        if (mapped) return mapped;
        return 'Node';
    },

    // Try each type-ish field of an oid-index entry until one maps to a
    // known UI label; class/nodetype hints win over the raw object_type token.
    normalizeOidIndexType: function(entry) {
        const source = entry && typeof entry === 'object' ? entry : {};
        const candidates = [source.class, source.nodetype, source.object_type];
        for (const candidate of candidates) {
            const normalized = this.normalizeNodeType(candidate);
            if (normalized !== 'Node') return normalized;
        }
        return 'Node';
    },

    tryOidIndexSearch: function(query, container) {
        if (!this._oidIndex || !this._oidIndex.oids) return false;
        // BRW-09: the index carries no module/type metadata, so an OID
        // search under an active module or type filter must use the server
        // path, which honors both filters.
        if (this.currentModule || this.currentTypeFilter) return false;
        const trimmed = String(query || '').trim();
        if (!/^[\d.]+$/.test(trimmed)) return false;

        const oids = this._oidIndex.oids;
        let bestKey = null;
        let bestLength = -1;
        Object.keys(oids).forEach(key => {
            if ((trimmed === key || trimmed.startsWith(key + '.')) && key.length > bestLength) {
                bestKey = key;
                bestLength = key.length;
            }
        });
        if (!bestKey) return false;

        const entry = oids[bestKey];
        const node = {
            name: entry.object,
            full_name: `${entry.module}::${entry.object}`,
            module: entry.module,
            oid: bestKey,
            type: this.normalizeOidIndexType(entry),
            description: '',
        };
        this.currentSearchResults = [node];
        this.cacheNode(node);
        this.setTreeCount(1, 'Search results');
        this.renderSearchResults([node], container);
        return true;
    },

    search: async function() {
        const query = document.getElementById('browser-search-input').value.trim();
        const container = document.getElementById('browser-tree-container');

        if (query.length < 2) {
            return;
        }

        // BRW-10: overlapping searches must resolve in order — a slow early
        // response can never overwrite the results of a newer one.
        const requestId = ++this._searchRequestId;

        this.syncFiltersFromUi();
        this.saveState();
        this.isSearchActive = true;

        // BRW-25: the local oid-index fast path ignores module/type filters, so
        // when a filter is active skip the index (its download and its
        // placeholder) entirely and go straight to the server search.
        const filterActive = Boolean(this.currentModule) || Boolean(this.currentTypeFilter);

        // BRW-24: give immediate feedback while the oid-index validates or
        // downloads instead of a silent pause on the first numeric search.
        // The staleness check also revalidates the cached index against the
        // last observed bundle id (BRW-08 defense in depth).
        const indexReady = this._oidIndex && this._oidIndexBundleId != null
            && (this._activeBundleId == null || this._oidIndexBundleId === this._activeBundleId);
        if (!filterActive && !indexReady) {
            container.innerHTML = this.buildTreePlaceholder({
                state: 'loading',
                title: 'Searching catalog',
                copy: 'Preparing the OID index for fast numeric lookups.',
            });
            await this.loadOidIndex();
            if (requestId !== this._searchRequestId) return;
        }
        if (!filterActive && this.tryOidIndexSearch(query, container)) {
            return;
        }

        container.innerHTML = this.buildTreePlaceholder({
            state: 'loading',
            title: 'Searching catalog',
            copy: 'Matching objects, notifications, and descriptions.',
        });

        try {
            const params = new URLSearchParams();
            params.set('query', query);
            params.set('limit', '100');
            if (this.currentModule) {
                params.set('module', this.currentModule);
            }
            if (this.currentTypeFilter) {
                params.set('type_filter', this.currentTypeFilter);
            }
            const res = await fetch(`/api/mibs/browse/search?${params.toString()}`);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            const data = await res.json();
            if (requestId !== this._searchRequestId) return;
            this.currentSearchResults = data.results || [];
            this.cacheNodesRecursive(this.currentSearchResults);

            this.setTreeCount(data.count, 'Search results');

            if (data.results.length === 0) {
                container.innerHTML = this.buildTreePlaceholder({
                    icon: 'fa-search',
                    title: `No results for "${query}"`,
                    copy: 'Try a broader keyword, an OID prefix, or clear one of the active filters.',
                });
                return;
            }

            this.renderSearchResults(data.results, container);

            if (this.pendingSelectedOid) {
                setTimeout(() => {
                    this.restoreSelectedNode();
                }, 100);
            }

        } catch (e) {
            if (requestId !== this._searchRequestId) return;
            console.error('Search failed:', e);
            container.innerHTML = `<div class="alert alert-danger m-2 small">Search failed: ${TrishulUtils.escapeHtml(e.message)}</div>`;
        }
    },
    
    renderSearchResults: function(results, container) {
        const esc = TrishulUtils.escapeHtml;
        let html = '<div class="list-group list-group-flush">';
        
        results.forEach(node => {
            const icon = this.getNodeIcon(node.type);
            const iconColor = this.getNodeIconColor(node.type);
            
            html += `
                <div class="list-group-item list-group-item-action p-2 search-result-item cursor-pointer"
                     onclick="BrowserModule.selectNodeFromElement(this)"
                     data-oid="${esc(node.oid)}"
                     data-module="${esc(node.module || '')}">
                    <div class="d-flex justify-content-between align-items-start">
                        <div class="flex-grow-1">
                            <div class="fw-bold small">
                                <i class="fas ${icon} ${iconColor} me-1"></i>
                                ${esc(node.name)}
                            </div>
                            <code class="text-muted app-fs-70">${esc(node.oid)}</code>
                            <span class="badge app-badge is-neutral ms-2 app-fs-65">${esc(node.module)}</span>
                        </div>
                    </div>
                    ${node.description ? `
                        <div class="text-muted mt-1 app-browser-desc-preview">
                            ${esc(node.description.substring(0, 120))}${node.description.length > 120 ? '...' : ''}
                        </div>
                    ` : ''}
                </div>
            `;
        });
        
        html += '</div>';
        container.innerHTML = html;
    },
    
    loadTree: async function() {
        if (this.isSearchActive) {
            return;
        }
        
        const container = document.getElementById('browser-tree-container');
        this.currentSearchResults = [];
        
        container.innerHTML = this.buildTreePlaceholder({
            state: 'loading',
            title: this.currentView === 'module' ? 'Loading tree' : 'Loading OID tree',
            copy: this.currentView === 'module'
                ? 'Preparing the active catalog by module.'
                : 'Preparing the active catalog by OID root.',
        });
        
        try {
            let data;
            
            if (this.currentView === 'module') {
                const res = await fetch(this.buildModuleTreeUrl());

                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }

                data = await res.json();
                this.noteActiveBundleId(data);

                if (!data.modules || data.modules.length === 0) {
                    const hasActiveFilter = Boolean(this.currentModule || this.currentTypeFilter);
                    container.innerHTML = hasActiveFilter
                        ? this.buildTreePlaceholder({
                            icon: 'fa-filter',
                            title: 'No matching objects',
                            copy: 'Clear the module or type filter and try again.',
                        })
                        : this.buildTreePlaceholder({
                            icon: 'fa-inbox',
                            title: 'No active MIBs',
                            copy: 'Upload or activate MIB sources before browsing the tree.',
                            actionHtml: '<a href="#mibs" class="btn btn-sm btn-app-primary"><i class="fas fa-upload me-1"></i>Open MIB Manager</a>',
                        });
                    this.setTreeCount('0', 'Objects in view');
                    return;
                }
                
                this.cacheNodesRecursive(data.modules);
                this.renderModuleTree(data.modules, container);
                this.setTreeCount(data.count, 'Objects in view');
                
                setTimeout(() => {
                    this.autoExpandFilteredModuleRoots();
                    this.restoreExpandedNodes();
                }, 100);
                
            } else {
                const res = await fetch(this.buildOidTreeUrl('1.3.6.1', this.currentModule || ''));

                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }

                data = await res.json();
                this.noteActiveBundleId(data);
                this.cacheNode(data.root);
                this.cacheNodesRecursive(data.children);
                this.renderOidTree(data, container);
                this.setTreeCount(data.total_descendants, 'Objects under root');
                
                setTimeout(() => {
                    this.restoreExpandedNodes();
                }, 100);
            }
        } catch (e) {
            console.error('Failed to load tree:', e);
            container.innerHTML = `<div class="alert alert-danger m-2 small">Failed to load tree: ${TrishulUtils.escapeHtml(e.message)}</div>`;
        }
    },
    
    renderModuleTree: function(modules, container) {
        if (modules.length === 0) {
            container.innerHTML = this.buildTreePlaceholder({
                icon: 'fa-book',
                title: 'No modules found',
                copy: 'Adjust the current filters or refresh the active bundle.',
            });
            return;
        }
        
        const esc = TrishulUtils.escapeHtml;
        let html = '';
        
        modules.forEach(module => {
            const children = module.children || [];
            
            const hasChildren = children.length > 0;
            
            html += `
                <div class="tree-node tree-module" data-oid="${esc(module.oid)}" data-module="${esc(module.module || module.name || '')}">
                    <div class="d-flex align-items-center py-2 px-3 tree-node-content border-bottom"
                         onclick="BrowserModule.handleNodeClickFromElement(this)">
                        ${hasChildren ? `
                            <button type="button" class="btn p-0 border-0 shadow-none tree-expand-icon" 
                                    aria-label="Expand module" aria-expanded="false"
                                    onclick="event.stopPropagation(); BrowserModule.toggleNodeFromElement(this)">
                                <i class="fas fa-chevron-right fa-xs me-2"></i>
                            </button>
                        ` : '<span class="app-tree-spacer"></span>'}
                         <i class="fas fa-book app-header-icon is-primary me-2"></i>
                         <span class="tree-node-name fw-bold">${esc(module.name)}</span>
                         <span class="badge badge-subtle ms-auto app-fs-70">${esc(String(module.object_count != null ? module.object_count : children.length))} ${this.currentTypeFilter ? this.getTypeLabel(this.currentTypeFilter) : 'objects'}</span>
                    </div>
                    ${hasChildren ? `
                        <div class="tree-children app-tree-children-pad is-collapsed">
                            ${children.map(child => this.buildTreeNodeHtml(child, 1)).join('')}
                        </div>
                    ` : ''}
                </div>
            `;
        });
        
        if (html === '') {
            container.innerHTML = '<div class="text-center text-muted p-3 small">No objects match the selected filters</div>';
        } else {
            container.innerHTML = html;
        }
    },

    shouldAutoExpandFilteredModuleRoots: function() {
        return this.currentView === 'module'
            && !this.isSearchActive
            && Boolean(this.currentModule || this.currentTypeFilter);
    },

    autoExpandFilteredModuleRoots: function() {
        if (!this.shouldAutoExpandFilteredModuleRoots()) {
            return;
        }

        document.querySelectorAll('#browser-tree-container .tree-module').forEach(node => {
            this.setNodeExpanded(node, true);
        });
    },
    
    renderOidTree: function(data, container) {
        const esc = TrishulUtils.escapeHtml;
        const html = `
            <div class="tree-node" data-oid="${esc(data.root.oid)}" data-module="${esc(data.root.module || this.currentModule || '')}">
                <div class="d-flex align-items-center py-2 px-3 tree-node-content border-bottom" 
                     onclick="BrowserModule.handleNodeClickFromElement(this)">
                     ${data.children.length > 0 ? `
                        <button type="button" class="btn p-0 border-0 shadow-none tree-expand-icon" 
                                aria-label="Collapse root" aria-expanded="true"
                                onclick="event.stopPropagation(); BrowserModule.toggleNodeFromElement(this)">
                            <i class="fas fa-chevron-down fa-xs me-2"></i>
                        </button>
                    ` : '<span class="app-tree-spacer"></span>'}
                    <i class="fas fa-cube app-header-icon is-neutral me-2"></i>
                    <span class="tree-node-name fw-bold">${esc(data.root.name)}</span>
                    <code class="ms-auto text-muted small">${esc(data.root.oid)}</code>
                </div>
                <div class="tree-children app-tree-children-pad is-expanded">
                    ${data.children.map(child => this.buildTreeNodeHtml(child, 1)).join('')}
                </div>
            </div>
        `;
        
        container.innerHTML = html;
    },

    buildTreeNodeHtml: function(node, level) {
        const esc = TrishulUtils.escapeHtml;
        const indent = level * 15;
        const hasChildren = node.has_children || (node.children && node.children.length > 0);
        const icon = this.getNodeIcon(node.type);
        const iconColor = this.getNodeIconColor(node.type);
        
        let html = `
            <div class="tree-node" data-oid="${esc(node.oid)}" data-module="${esc(node.module || '')}" style="padding-left: ${indent}px;">
                <div class="d-flex align-items-center py-1 px-2 tree-node-content" 
                     onclick="BrowserModule.handleNodeClickFromElement(this)">
                     ${hasChildren ? `
                        <button type="button" class="btn p-0 border-0 shadow-none tree-expand-icon" 
                                aria-label="Expand node" aria-expanded="false"
                                onclick="event.stopPropagation(); BrowserModule.toggleNodeFromElement(this)">
                            <i class="fas fa-chevron-right fa-xs me-2"></i>
                        </button>
                    ` : '<span class="app-tree-spacer"></span>'}
                    <i class="fas ${icon} ${iconColor} me-2 app-browser-node-icon"></i>
                    <span class="tree-node-name small">${esc(node.name)}</span>
                    <code class="ms-auto text-muted app-fs-65">${esc(node.oid.split('.').slice(-2).join('.'))}</code>
                </div>
                ${hasChildren ? '<div class="tree-children is-collapsed"></div>' : ''}
            </div>
        `;
        
        return html;
    },

    filterNodesByType: function(nodes, typeFilter) {
        if (!typeFilter) return nodes;
        
        let filtered = [];
        
        nodes.forEach(node => {
            if (node.type === typeFilter) {
                filtered.push(node);
            } else if (node.children && node.children.length > 0) {
                const filteredChildren = this.filterNodesByType(node.children, typeFilter);
                if (filteredChildren.length > 0) {
                    const nodeCopy = {...node};
                    nodeCopy.children = filteredChildren;
                    filtered.push(nodeCopy);
                }
            }
        });
        
        return filtered;
    },
    
    getTypeLabel: function(type) {
        const labels = {
            'MibScalar': 'scalars',
            'MibTable': 'tables',
            'MibTableColumn': 'columns',
            'NotificationType': 'traps'
        };
        return labels[type] || 'objects';
    },

    expandToSelectedDepth: async function() {
        const depthSelect = document.getElementById('expand-depth-select');
        const depth = parseInt(depthSelect.value) || 3;
        
        await this.expandToDepth(depth);
    },

    expandToDepth: async function(maxDepth) {
        const expandBtn = document.getElementById('btn-expand');
        const originalHtml = expandBtn ? expandBtn.innerHTML : '';
        
        if (expandBtn) {
            expandBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Expanding...';
            expandBtn.disabled = true;
        }
        
        try {
            if (this.currentView === 'module') {
                const moduleNodes = document.querySelectorAll('.tree-module');
                let count = 0;
                for (const node of moduleNodes) {
                    await this.expandNodeRecursively(node, maxDepth);
                    count++;
                }
                TrishulUtils.showNotification(`Expanded ${count} module(s) to ${maxDepth} level(s)`, 'success');
            } else {
                const rootNode = document.querySelector('.tree-node[data-oid="1.3.6.1"]');
                if (rootNode) {
                    await this.expandNodeRecursively(rootNode, maxDepth);
                    TrishulUtils.showNotification(`Expanded OID tree to ${maxDepth} level(s)`, 'success');
                } else {
                    TrishulUtils.showNotification('Root node not found', 'warning');
                }
            }
        } catch (e) {
            console.error('Failed to expand tree:', e);
            TrishulUtils.showNotification('Failed to expand tree', 'error');
        } finally {
            if (expandBtn) {
                expandBtn.innerHTML = originalHtml;
                expandBtn.disabled = false;
            }
        }
    },

    collapseAll: function() {
        const allNodes = document.querySelectorAll('.tree-node');
        let count = 0;
        
        allNodes.forEach(node => {
            const icon = node.querySelector(':scope > .tree-node-content > .tree-expand-icon');
            const children = node.querySelector(':scope > .tree-children');
            
            if (icon && children && this.isNodeExpanded(node)) {
                this.setNodeExpanded(node, false);
                count++;
            }
        });
        
        if (count > 0) {
            TrishulUtils.showNotification(`Collapsed ${count} node(s)`, 'info');
        }
    },

    expandModuleRoots: async function() {
        const moduleNodes = document.querySelectorAll('.tree-module');
        
        for (const node of moduleNodes) {
            const icon = node.querySelector(':scope > .tree-node-content > .tree-expand-icon');
            const children = node.querySelector(':scope > .tree-children');
            
            if (icon && children) {
                if (children.innerHTML.trim() === '') {
                    try {
                        await this.loadChildrenIntoNode(node);
                    } catch (e) {
                        console.error('Failed to load children:', e);
                    }
                }
                
                this.setNodeExpanded(node, true);
            }
        }
    },

    expandOidTree: async function() {
        const rootNode = document.querySelector('.tree-node[data-oid="1.3.6.1"]');
        
        if (!rootNode) {
            console.warn('Root OID node not found');
            return;
        }
        
        await this.expandNodeRecursively(rootNode, 2);
    },

    expandNodeRecursively: async function(nodeEl, depth) {
        if (depth <= 0) return;
        
        const oid = nodeEl.getAttribute('data-oid');
        const icon = nodeEl.querySelector(':scope > .tree-node-content > .tree-expand-icon');
        const children = nodeEl.querySelector(':scope > .tree-children');
        
        if (!icon || !children) return;
        
        if (children.innerHTML.trim() === '') {
            try {
                await this.loadChildrenIntoNode(nodeEl);
            } catch (e) {
                console.error(`Failed to load children for ${oid}:`, e);
                return;
            }
        }
        
        this.setNodeExpanded(nodeEl, true);
        
        if (depth > 1) {
            const childNodes = children.querySelectorAll(':scope > .tree-node');
            for (const childNode of childNodes) {
                await this.expandNodeRecursively(childNode, depth - 1);
            }
        }
    },
        
    getNodeIcon: function(type) {
        const icons = {
            'Module': 'fa-book',
            'MibTable': 'fa-table',
            'MibTableRow': 'fa-list',
            'MibTableColumn': 'fa-columns',
            'MibScalar': 'fa-file',
            'NotificationType': 'fa-bell',
            'ObjectGroup': 'fa-folder',
            'ModuleCompliance': 'fa-check-circle',
            'ModuleIdentity': 'fa-id-card'
        };
        return icons[type] || 'fa-cube';
    },

    getNodeIconColor: function(type) {
        const colors = {
            'Module': 'app-header-icon is-primary',
            'MibTable': 'app-header-icon is-table',
            'MibTableColumn': 'app-header-icon is-success',
            'MibScalar': 'app-header-icon is-info',
            'NotificationType': 'app-header-icon is-warning',
            'ObjectGroup': 'app-header-icon is-neutral',
            'ModuleIdentity': 'app-header-icon is-primary'
        };
        return colors[type] || 'app-header-icon is-neutral';
    },
    
    toggleNodeFromElement: async function(el) {
        const nodeEl = el?.closest('.tree-node');
        if (!nodeEl) return;
        await this.toggleNodeElement(nodeEl);
    },

    toggleNodeElement: async function(nodeEl) {
        const childrenEl = nodeEl.querySelector(':scope > .tree-children');
        const icon = nodeEl.querySelector(':scope > .tree-node-content > .tree-expand-icon');
        
        if (!childrenEl || !icon) return;
        
        if (!this.isNodeExpanded(nodeEl)) {

            if (childrenEl.innerHTML.trim() === '') {
                try {
                    const children = await this.loadChildrenIntoNode(nodeEl);
                    if (!children.length) {
                        childrenEl.innerHTML = '<div class="text-muted small px-2 py-1">No children</div>';
                    }
                } catch (e) {
                    // BRW-11: leave the children container empty and stay
                    // collapsed — writing an error into the container used to
                    // permanently block the lazy-load retry (it only fires on
                    // empty innerHTML). The toast tells the user to retry.
                    console.error('Failed to load children:', e);
                    TrishulUtils.showNotification(
                        'Failed to load tree children — expand the node again to retry',
                        'error'
                    );
                    return;
                }
            }

            this.setNodeExpanded(nodeEl, true);
        } else {
            this.setNodeExpanded(nodeEl, false);
        }
    },

    toggleNode: async function(oid, module) {
        const nodeEl = this.findTreeNodeEl(oid, module);
        if (!nodeEl) return;
        await this.toggleNodeElement(nodeEl);
    },

    handleNodeClickFromElement: async function(el) {
        // BRW-13: a row click selects the node only — expansion is the
        // chevron button's job, so the two intents no longer fire together.
        const nodeEl = el?.closest('.tree-node');
        if (!nodeEl) return;
        const oid = nodeEl.getAttribute('data-oid');
        const module = nodeEl.getAttribute('data-module') || null;
        if (!oid) return;

        await this.selectNode(oid, module, el);
    },
    
    selectNode: async function(oid, module, sourceEl) {
        document.querySelectorAll('.tree-node-content, .search-result-item').forEach(el => {
            el.classList.remove('is-selected', 'active');
        });
        
        // Prefer the element the user actually interacted with; module
        // headers can share the oid+module of their first child, so an
        // oid-based lookup alone may resolve to the wrong row.
        const treeSelector = module
            ? `.tree-node[data-oid="${oid}"][data-module="${module}"] > .tree-node-content`
            : `.tree-node[data-oid="${oid}"] > .tree-node-content`;
        const searchSelector = module
            ? `.search-result-item[data-oid="${oid}"][data-module="${module}"]`
            : `.search-result-item[data-oid="${oid}"]`;
        const nodeEl = (sourceEl && sourceEl.classList && (sourceEl.classList.contains('tree-node-content') || sourceEl.classList.contains('search-result-item')))
            ? sourceEl
            : (this.findTreeNodeEl(oid, module)?.querySelector(':scope > .tree-node-content')
                || document.querySelector(searchSelector));
        if (nodeEl) {
            nodeEl.classList.add('is-selected');
        }
        
        await this.loadNodeDetails(oid, module);
        
        this.saveState();
    },
    
    loadNodeDetails: async function(oid, module) {
        const panel = document.getElementById('browser-details-panel');
        panel.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm"></div></div>';
        
        try {
            const params = new URLSearchParams();
            if (module) params.set('module', module);
            const query = params.toString();
            const url = query
                ? `/api/mibs/browse/node/${encodeURIComponent(oid)}?${query}`
                : `/api/mibs/browse/node/${encodeURIComponent(oid)}`;
            const res = await fetch(url);
            
            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error('Node not found');
                } else {
                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }
            }
            
            const data = await res.json();
            this.renderDetails(data);
            
        } catch (e) {
            console.error('Failed to load details:', e);
            const message = TrishulUtils.escapeHtml(e.message);
            
            panel.innerHTML = `
                <div class="alert alert-warning m-3">
                    <i class="fas fa-exclamation-triangle me-2"></i>
                    <strong>Could not load details</strong>
                    <p class="small mb-0 mt-2">${message}</p>
                </div>
                <div class="text-center mt-3">
                    <button type="button" class="btn btn-sm btn-app-primary-outline" onclick="BrowserModule.clearSelection()">
                        <i class="fas fa-times"></i> Clear Selection
                    </button>
                </div>
            `;
        }
    },
    
    renderDetails: function(data) {
        const node = data.node;
        const panel = document.getElementById('browser-details-panel');
        const esc = TrishulUtils.escapeHtml;

        // BRW-23: keep the rendered payload so a late status snapshot can
        // re-render the detail with the recompile notice once it arrives.
        this._currentDetailData = data;

        const isNotification = node.type === 'NotificationType';
        const trapObjects = data.trap_objects || [];

        // BRW-16: sort enumerations numerically by value so large enums
        // (e.g. ifType) can be scanned and compared.
        const enumEntries = node.enums
            ? Object.entries(node.enums).sort((left, right) => {
                const leftValue = Number(left[1]);
                const rightValue = Number(right[1]);
                if (Number.isFinite(leftValue) && Number.isFinite(rightValue) && leftValue !== rightValue) {
                    return leftValue - rightValue;
                }
                return String(left[0]).localeCompare(String(right[0]));
            })
            : [];
        // BRW-15: render declared range/size/enum constraints (and union
        // alternatives) as badges in the detail table.
        const constraintBadges = this.buildConstraintBadges(node.constraints, node.enums);
        const trapPayload = TrishulUtils.encodeDataAttr({
            full_name: node.full_name,
            name: node.name,
            oid: node.oid,
            objects: trapObjects
        });

        panel.innerHTML = `
            ${this.shouldShowRecompileNotice() ? this.buildRecompileNotice() : ''}
            <!-- Breadcrumb with tooltips -->
            ${data.breadcrumb.length > 0 ? `
                <nav aria-label="breadcrumb" class="mb-3">
                    <ol class="breadcrumb small mb-0">
                        ${data.breadcrumb.map((b, idx) => `
                            <li class="breadcrumb-item ${idx === data.breadcrumb.length - 1 ? 'active' : ''}" 
                                title="${esc(b.full_name)} (${esc(b.oid)})">
                                ${idx === data.breadcrumb.length - 1 ? esc(b.name) : `
                                    <a href="#" onclick="return BrowserModule.selectNodeFromLink(this)" data-oid="${esc(b.oid)}" data-module="${esc(b.module || '')}">
                                        ${esc(b.name)}
                                    </a>
                                `}
                            </li>
                        `).join('')}
                    </ol>
                </nav>
            ` : ''}
            
            <!-- Compact Key-Value Pairs -->
            <table class="table table-sm table-borderless mb-3 app-browser-detail-table">
                <tbody>
                    <tr>
                        <td class="text-muted fw-bold app-browser-detail-label">Name</td>
                        <td><code>${esc(node.name)}</code></td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">Full Name</td>
                        <td>
                            <div class="browser-detail-copy-row">
                                <code class="browser-detail-copy-value" title="${esc(node.full_name)}">${esc(node.full_name)}</code>
                                <button type="button" class="btn btn-xs btn-app-secondary btn-icon ms-2"
                                        onclick="BrowserModule.copyValue(this.dataset.copy)"
                                        data-copy="${esc(node.full_name)}">
                                    <i class="fas fa-copy"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">OID</td>
                        <td>
                            <div class="browser-detail-copy-row">
                                <code class="browser-detail-copy-value" title="${esc(node.oid)}">${esc(node.oid)}</code>
                                <button type="button" class="btn btn-xs btn-app-secondary btn-icon ms-2"
                                        onclick="BrowserModule.copyValue(this.dataset.copy)"
                                        data-copy="${esc(node.oid)}">
                                    <i class="fas fa-copy"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">Module</td>
                        <td><span class="badge app-badge is-neutral">${esc(node.module)}</span></td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">Type</td>
                        <td><span class="badge app-badge is-info">${esc(node.type)}</span></td>
                    </tr>
                    ${node.syntax ? `
                        <tr>
                            <td class="text-muted fw-bold">Syntax</td>
                            <td><code class="small">${esc(node.syntax)}</code></td>
                        </tr>
                    ` : ''}
                    ${node.units ? `
                        <tr>
                            <td class="text-muted fw-bold">Units</td>
                            <td><span class="badge app-badge is-info app-browser-units-badge">${esc(node.units)}</span></td>
                        </tr>
                    ` : ''}
                    ${constraintBadges ? `
                        <tr>
                            <td class="text-muted fw-bold">Constraints</td>
                            <td>${constraintBadges}</td>
                        </tr>
                    ` : ''}
                    ${node.access ? `
                        <tr>
                            <td class="text-muted fw-bold">Access</td>
                            <td><span class="badge app-badge is-warning">${esc(node.access)}</span></td>
                        </tr>
                    ` : ''}
                    ${node.status ? `
                        <tr>
                            <td class="text-muted fw-bold">Status</td>
                            <td><span class="badge ${node.status === 'current' ? 'app-badge is-success' : 'app-badge is-neutral'}">${esc(node.status)}</span></td>
                        </tr>
                    ` : ''}
                </tbody>
            </table>
            
            ${node.description ? `
                <div class="mb-3">
                    <label class="fw-bold small text-muted d-block mb-1">Description</label>
                    <div class="small text-muted p-2 app-surface-muted rounded app-scroll-panel app-max-h-120 app-fs-75">
                        ${esc(node.description)}
                    </div>
                </div>
            ` : ''}
            
            ${enumEntries.length > 0 ? `
                <div class="mb-3" id="browser-enum-section">
                    <label class="fw-bold small text-muted d-block mb-1">Enumerations
                        <span class="badge app-badge is-neutral ms-1">${enumEntries.length}</span>
                    </label>
                    <div class="app-scroll-panel app-max-h-300">
                        <table class="table table-sm table-hover mb-0 app-browser-enum-table">
                            <thead class="table-light">
                                <tr><th scope="col" class="small">Label</th><th scope="col" class="small">Value</th></tr>
                            </thead>
                            <tbody>
                                ${enumEntries.map(([label, value]) => `
                                    <tr>
                                        <td><code class="small">${esc(label)}</code></td>
                                        <td class="small">${esc(String(value))}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : ''}
            
            ${isNotification && trapObjects.length > 0 ? `
                <div class="mb-3">
                    <label class="fw-bold small text-muted d-block mb-1">VarBinds (${trapObjects.length})</label>
                    <div class="list-group list-group-flush small app-scroll-panel app-max-h-150">
                        ${trapObjects.map(obj => `
                            <div class="list-group-item px-2 py-1 border-0 app-surface-muted mb-1 rounded">
                                <code class="small">${esc(obj.name)}</code>
                                <div class="text-muted app-fs-65">${esc(obj.full_name)}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            
            ${node.indexes && node.indexes.length > 0 ? `
                <div class="mb-3">
                    <label class="fw-bold small text-muted d-block mb-1">Indexes</label>
                    <ul class="small mb-0 ps-3">
                        ${node.indexes.map(idx => `<li><code class="small">${esc(idx)}</code></li>`).join('')}
                    </ul>
                </div>
            ` : ''}
            
            <!-- Actions — BRW-18: pinned to the panel bottom so the primary
                 action stays reachable on long (enum/description-heavy) details -->
            <div class="app-browser-detail-actions">
                <div class="d-grid gap-2">
                    ${!isNotification ? `
                        <button type="button" class="btn btn-sm btn-app-primary" onclick="BrowserModule.useInWalker(this.dataset.fullName)" data-full-name="${esc(node.full_name)}">
                            <i class="fas fa-walking"></i> Walk this OID
                        </button>
                    ` : ''}
                    ${isNotification ? `
                        <button type="button" class="btn btn-sm btn-app-primary" onclick="BrowserModule.useInTrapSenderFromElement(this)" data-trap="${esc(trapPayload)}">
                            <i class="fas fa-paper-plane"></i> Send this Trap
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    },

    // BRW-15: render a node's declared constraints as compact mono badges,
    // following the picker's vocabulary ("lo..hi" ranges, "length lo..hi").
    // Range and size badges list every declared pair; enum constraints show
    // the value count and jump to the Enumerations table when present;
    // bits constraints show the named bits (BRW-28); unions render each
    // alternative joined by "or" under an "any of" lead.
    buildConstraintBadges: function(constraints, enums) {
        const esc = TrishulUtils.escapeHtml;
        if (!constraints || typeof constraints !== 'object' || !constraints.kind) return '';

        const enumCount = enums && typeof enums === 'object' ? Object.keys(enums).length : 0;
        const badge = (text) => `<span class="badge app-badge is-neutral app-browser-constraint-badge">${esc(text)}</span>`;

        const renderFact = (kind, data) => {
            if (kind === 'bits') {
                // BRW-28: BITS data is [name, bit] pairs — show the named
                // bits (truncated with the full list in the tooltip), or
                // just the count when no names are derivable.
                const entries = Array.isArray(data) ? data : [];
                const names = entries
                    .filter(pair => Array.isArray(pair) && pair.length >= 2 && String(pair[0] || '').trim())
                    .map(pair => String(pair[0]));
                if (!entries.length && !names.length) return '';
                if (names.length) {
                    const shown = names.slice(0, 5).join(', ');
                    const suffix = names.length > 5 ? `, +${names.length - 5} more` : '';
                    return `<span class="badge app-badge is-neutral app-browser-constraint-badge" title="BITS: ${esc(names.join(', '))}">bits: ${esc(shown)}${esc(suffix)}</span>`;
                }
                return badge(`${entries.length} bits`);
            }
            const pairs = (Array.isArray(data) ? data : [])
                .filter(pair => Array.isArray(pair) && pair.length >= 2)
                .map(pair => `${pair[0]}..${pair[1]}`);
            if (kind === 'range' && pairs.length) {
                return badge(pairs.join(', '));
            }
            if (kind === 'size' && pairs.length) {
                return badge(`length ${pairs.join(', ')}`);
            }
            if (kind === 'enum') {
                const count = pairs.length || enumCount;
                if (!count) return '';
                if (enumCount > 0) {
                    return `<button type="button" class="badge app-badge is-neutral app-browser-constraint-badge app-browser-constraint-link"
                        onclick="BrowserModule.scrollToEnumTable()"
                        title="Jump to the Enumerations table"
                        aria-label="Jump to the Enumerations table (${esc(String(count))} values)">${esc(String(count))} values</button>`;
                }
                return badge(`${count} values`);
            }
            return '';
        };

        if (constraints.kind !== 'union' && Array.isArray(constraints.data)) {
            return renderFact(constraints.kind, constraints.data);
        }
        if (constraints.kind === 'union' && Array.isArray(constraints.data)) {
            const alternatives = constraints.data
                .map(item => item && typeof item === 'object' ? renderFact(item.kind, item.data) : '')
                .filter(Boolean);
            if (!alternatives.length) return '';
            return `<span class="small text-muted">any of</span> ${alternatives.join(' <span class="small text-muted">or</span> ')}`;
        }
        return '';
    },

    scrollToEnumTable: function() {
        const section = document.getElementById('browser-enum-section');
        if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    },

    selectNodeFromElement: function(el) {
        this.selectNode(el?.dataset?.oid, el?.dataset?.module, el);
    },

    selectNodeFromLink: function(link) {
        this.selectNode(link?.dataset?.oid, link?.dataset?.module || null);
        return false;
    },

    copyValue: function(value) {
        navigator.clipboard.writeText(value || '')
            .then(() => TrishulUtils.showNotification('Copied', 'success'))
            .catch(() => TrishulUtils.showNotification('Copy failed', 'error'));
    },

    useInWalker: function(fullName) {
        sessionStorage.setItem('walkerOid', fullName);
        window.location.hash = '#walker';
    },
    
    useInTrapSender: function(trapData) {
        if (typeof trapData === 'string') {
            sessionStorage.setItem('trapOid', trapData);
        } else {
            sessionStorage.setItem('selectedTrap', JSON.stringify(trapData));
        }
        window.location.hash = '#traps';
    },

    useInTrapSenderFromElement: function(button) {
        const trapData = TrishulUtils.decodeDataAttr(button?.dataset?.trap || '', null);
        if (trapData) {
            this.useInTrapSender(trapData);
        }
    },

    _getCurrentViewRecords: function() {
        if (this.isSearchActive) {
            return (this.currentSearchResults || []).map(node => ({
                view: 'search',
                oid: node.oid,
                name: node.name,
                full_name: node.full_name,
                module: node.module,
                // BRW-12: normalize raw SMI tokens so exports match the UI.
                type: this.normalizeNodeType(node.type),
                description: node.description || ''
            }));
        }

        const rows = [];
        document.querySelectorAll('#browser-tree-container .tree-node[data-oid]').forEach(nodeEl => {
            const oid = nodeEl.getAttribute('data-oid');
            const module = nodeEl.getAttribute('data-module') || '';
            const cached = this.nodeCache[this.getNodeCacheKey(oid, module)] || this.nodeCache[oid] || {};
            rows.push({
                view: this.currentView,
                oid: oid,
                name: cached.name || '',
                full_name: cached.full_name || '',
                module: cached.module || module || '',
                type: this.normalizeNodeType(cached.type),
                description: cached.description || '',
                has_children: cached.has_children != null ? String(!!cached.has_children) : '',
            });
        });
        return rows;
    },

    exportCurrentView: function(format) {
        const rows = this._getCurrentViewRecords();
        if (rows.length === 0) {
            TrishulUtils.showNotification('Nothing to export from the current browser view', 'warning');
            return;
        }

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (format === 'csv') {
            const csv = TrishulUtils.toCsv(rows, [
                { key: 'view', label: 'view' },
                { key: 'oid', label: 'oid' },
                { key: 'name', label: 'name' },
                { key: 'full_name', label: 'full_name' },
                { key: 'module', label: 'module' },
                { key: 'type', label: 'type' },
                { key: 'description', label: 'description' },
                { key: 'has_children', label: 'has_children' },
            ]);
            TrishulUtils.downloadText(`trishul-browser-view-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
            return;
        }

        TrishulUtils.downloadText(
            `trishul-browser-view-${stamp}.json`,
            JSON.stringify({
                exported_at: new Date().toISOString(),
                view: this.isSearchActive ? 'search' : this.currentView,
                records: rows
            }, null, 2),
            'application/json;charset=utf-8'
        );
    }
};

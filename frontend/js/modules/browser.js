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

    STATE_KEY: 'browserState',

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
        const icon = nodeEl?.querySelector(':scope > .tree-node-content > .tree-expand-icon');

        if (childrenEl) {
            childrenEl.classList.toggle('is-expanded', !!expanded);
            childrenEl.classList.toggle('is-collapsed', !expanded);
        }

        if (icon) {
            icon.classList.toggle('fa-chevron-down', !!expanded);
            icon.classList.toggle('fa-chevron-right', !expanded);
        }
    },

    buildTreePlaceholder: function(options) {
        return TrishulUtils.buildPanelPlaceholder(options);
    },
    
    init: async function() {
        this.currentView = 'module';
        this.currentSearchResults = [];
        this.nodeCache = {};
        this.setButtonStates();

        // Restore state if exists
        this.restoreState();
        this.applyViewLayout();
        
        // Load modules first, then tree
        await this.loadModules();
        this.loadTree();
        this.loadOidIndex();
        
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
        // Save state before leaving
        this.saveState();
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
            
            // Restore UI elements (will be set after DOM loads)
            setTimeout(() => {
                if (state.currentModule) {
                    const moduleSelect = document.getElementById('browser-module-filter');
                    if (moduleSelect) moduleSelect.value = state.currentModule;
                }
                
                if (state.currentTypeFilter) {
                    const typeSelect = document.getElementById('browser-type-filter');
                    if (typeSelect) typeSelect.value = state.currentTypeFilter;
                }
                
                if (state.searchQuery) {
                    const searchInput = document.getElementById('browser-search-input');
                    const clearBtn = document.getElementById('btn-clear-search');
                    
                    if (searchInput) {
                        searchInput.value = state.searchQuery;
                        
                        // BUG FIX: was style.display = 'block' — overridden by d-none class
                        if (clearBtn && state.searchQuery.length > 0) {
                            clearBtn.classList.remove('d-none');
                        }
                        
                        if (state.searchQuery.length >= 2) {
                            this.search();
                        }
                    }
                }
                
                this.setButtonStates();
            }, 100);
            
        } catch (e) {
            console.error('Failed to restore state:', e);
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

    expandNodeByRef: async function(ref) {
        const nodeRef = this.parseNodeRef(ref);
        const nodeEl = nodeRef.module
            ? document.querySelector(`.tree-node[data-oid="${nodeRef.oid}"][data-module="${nodeRef.module}"]`)
            : document.querySelector(`.tree-node[data-oid="${nodeRef.oid}"]`);
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
        
        // Try to find the node in the tree
        let nodeEl = this.pendingSelectedModule
            ? document.querySelector(`.tree-node[data-oid="${this.pendingSelectedOid}"][data-module="${this.pendingSelectedModule}"]`)
            : document.querySelector(`.tree-node[data-oid="${this.pendingSelectedOid}"]`);

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
    
    clearSearch: function() {
        document.getElementById('browser-search-input').value = '';
        // BUG FIX: was style.display = 'none'
        document.getElementById('btn-clear-search').classList.add('d-none');
        this.isSearchActive = false;
        this.loadTree();
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
        
        this.searchTimeout = setTimeout(() => this.search(), 500);
    },
    
    loadOidIndex: async function() {
        if (this._oidIndex && this._oidIndexBundleId) return;
        try {
            if (this._activeBundleId == null) {
                const statusRes = await fetch('/api/mibs/status');
                const status = await statusRes.json();
                this._activeBundleId = status.active_bundle_id || null;
            }
            const bundleId = this._activeBundleId;
            if (!bundleId) {
                this._oidIndex = null;
                this._oidIndexBundleId = null;
                return;
            }
            if (this._oidIndexBundleId === bundleId && this._oidIndex) {
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

    tryOidIndexSearch: function(query, container, countBadge) {
        if (!this._oidIndex || !this._oidIndex.oids) return false;
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
            type: entry.object_type || entry.class || 'Node',
            description: '',
        };
        this.currentSearchResults = [node];
        this.cacheNode(node);
        if (countBadge) countBadge.textContent = 1;
        this.renderSearchResults([node], container);
        return true;
    },

    search: async function() {
        const query = document.getElementById('browser-search-input').value.trim();
        const container = document.getElementById('browser-tree-container');
        const countBadge = document.getElementById('browser-tree-count');
        
        if (query.length < 2) {
            return;
        }
        
        this.syncFiltersFromUi();
        this.saveState();
        this.isSearchActive = true;

        if (!this._oidIndex || !this._oidIndexBundleId) {
            await this.loadOidIndex();
        }
        if (this.tryOidIndexSearch(query, container, countBadge)) {
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
            this.currentSearchResults = data.results || [];
            this.cacheNodesRecursive(this.currentSearchResults);
            
            countBadge.textContent = data.count;
            
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
        const countBadge = document.getElementById('browser-tree-count');
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
                    countBadge.textContent = '0';
                    return;
                }
                
                this.cacheNodesRecursive(data.modules);
                this.renderModuleTree(data.modules, container);
                countBadge.textContent = data.count;
                
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
                this.cacheNode(data.root);
                this.cacheNodesRecursive(data.children);
                this.renderOidTree(data, container);
                countBadge.textContent = data.total_descendants;
                
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
                            <i class="fas fa-chevron-right fa-xs me-2 tree-expand-icon" 
                            onclick="event.stopPropagation(); BrowserModule.toggleNodeFromElement(this)"></i>
                        ` : '<span class="app-tree-spacer"></span>'}
                        <i class="fas fa-book app-header-icon is-primary me-2"></i>
                        <span class="tree-node-name fw-bold">${esc(module.name)}</span>
                        <span class="badge badge-subtle ms-auto app-fs-70">${children.length} ${this.currentTypeFilter ? this.getTypeLabel(this.currentTypeFilter) : 'objects'}</span>
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
                        <i class="fas fa-chevron-down fa-xs me-2 tree-expand-icon" 
                           onclick="event.stopPropagation(); BrowserModule.toggleNodeFromElement(this)"></i>
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
                        <i class="fas fa-chevron-right fa-xs me-2 tree-expand-icon" 
                           onclick="event.stopPropagation(); BrowserModule.toggleNodeFromElement(this)"></i>
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
            'ModuleCompliance': 'fa-check-circle'
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
            'ObjectGroup': 'app-header-icon is-neutral'
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
                    console.error('Failed to load children:', e);
                    childrenEl.innerHTML = '<div class="small app-status-text is-error px-2 py-1">Failed to load</div>';
                }
            }
            
            this.setNodeExpanded(nodeEl, true);
        } else {
            this.setNodeExpanded(nodeEl, false);
        }
    },

    toggleNode: async function(oid, module) {
        const nodeEl = module
            ? document.querySelector(`.tree-node[data-oid="${oid}"][data-module="${module}"]`)
            : document.querySelector(`.tree-node[data-oid="${oid}"]`);
        if (!nodeEl) return;
        await this.toggleNodeElement(nodeEl);
    },

    handleNodeClickFromElement: async function(el) {
        const nodeEl = el?.closest('.tree-node');
        if (!nodeEl) return;
        const oid = nodeEl.getAttribute('data-oid');
        const module = nodeEl.getAttribute('data-module') || null;
        if (!oid) return;

        await this.selectNode(oid, module);

        const childrenEl = nodeEl.querySelector(':scope > .tree-children');
        const icon = nodeEl.querySelector(':scope > .tree-node-content > .tree-expand-icon');
        if (childrenEl && icon) {
            await this.toggleNodeElement(nodeEl);
        }
    },
    
    selectNode: async function(oid, module) {
        document.querySelectorAll('.tree-node-content, .search-result-item').forEach(el => {
            el.classList.remove('is-selected', 'active');
        });
        
        const treeSelector = module
            ? `.tree-node[data-oid="${oid}"][data-module="${module}"] > .tree-node-content`
            : `.tree-node[data-oid="${oid}"] > .tree-node-content`;
        const searchSelector = module
            ? `.search-result-item[data-oid="${oid}"][data-module="${module}"]`
            : `.search-result-item[data-oid="${oid}"]`;
        const nodeEl = document.querySelector(treeSelector) ||
                    document.querySelector(searchSelector);
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
        
        const isNotification = node.type === 'NotificationType';
        const trapObjects = data.trap_objects || [];
        const trapPayload = TrishulUtils.encodeDataAttr({
            full_name: node.full_name,
            name: node.name,
            oid: node.oid,
            objects: trapObjects
        });
        
        panel.innerHTML = `
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
                            <td><code class="small">${esc(node.units)}</code></td>
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
            
            ${node.enums && Object.keys(node.enums).length > 0 ? `
                <div class="mb-3">
                    <label class="fw-bold small text-muted d-block mb-1">Enumerations</label>
                    <div class="app-scroll-panel app-max-h-150">
                        <table class="table table-sm table-hover mb-0 app-browser-enum-table">
                            <thead class="table-light">
                                <tr><th scope="col" class="small">Label</th><th scope="col" class="small">Value</th></tr>
                            </thead>
                            <tbody>
                                ${Object.entries(node.enums).map(([label, value]) => `
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
            
            <!-- Actions -->
            <hr>
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
        `;
    },

    selectNodeFromElement: function(el) {
        this.selectNode(el?.dataset?.oid, el?.dataset?.module);
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
                type: node.type,
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
                type: cached.type || '',
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

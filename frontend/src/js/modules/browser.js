window.BrowserModule = {
    currentModule: null,
    currentTypeFilter: null,
    currentView: 'module',
    searchTimeout: null,
    allModules: [],
    isSearchActive: false,
    currentSearchResults: [],
    nodeCache: {},

    STATE_KEY: 'browserState',

    cacheNode: function(node) {
        if (node && node.oid) {
            this.nodeCache[node.oid] = node;
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
    
    init: async function() {
        this.currentView = 'module';
        this.currentSearchResults = [];
        this.nodeCache = {};
        this.setButtonStates();

        // Restore state if exists
        this.restoreState();
        
        // Load modules first, then tree
        await this.loadModules();
        this.loadTree();
        
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
            const children = node.querySelector(':scope > .tree-children');
            if (children && children.style.display === 'block') {
                const oid = node.getAttribute('data-oid');
                if (oid) expandedNodes.push(oid);
            }
        });
        
        // Get selected node
        const selectedNode = document.querySelector('.tree-node-content.bg-primary, .search-result-item.bg-primary');
        let selectedOid = null;
        if (selectedNode) {
            const parentNode = selectedNode.closest('.tree-node, .search-result-item');
            if (parentNode) {
                selectedOid = parentNode.getAttribute('data-oid') || 
                            parentNode.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
            }
        }
        
        const state = {
            currentView: this.currentView,
            currentModule: this.currentModule,
            currentTypeFilter: this.currentTypeFilter,
            searchQuery: document.getElementById('browser-search-input')?.value || '',
            isSearchActive: this.isSearchActive,
            expandedNodes: expandedNodes,
            selectedOid: selectedOid
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
            
            // Store expanded nodes and selected OID for later restoration
            this.pendingExpandedNodes = state.expandedNodes || [];
            this.pendingSelectedOid = state.selectedOid;
            
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
        for (const oid of this.pendingExpandedNodes) {
            await this.expandNodeByOid(oid);
        }
        
        // After all expansions, restore selected node
        if (this.pendingSelectedOid) {
            await this.restoreSelectedNode();
        }
        
        // Clear pending state
        this.pendingExpandedNodes = [];
        this.pendingSelectedOid = null;
    },

    expandNodeByOid: async function(oid) {
        const nodeEl = document.querySelector(`.tree-node[data-oid="${oid}"]`);
        if (!nodeEl) {
            console.warn(`Node not found for OID: ${oid}`);
            return;
        }
        
        const icon = nodeEl.querySelector(':scope > .tree-node-content > .tree-expand-icon');
        const children = nodeEl.querySelector(':scope > .tree-children');
        
        if (!icon || !children) {
            return;
        }
        
        // Load children if not loaded
        if (children.innerHTML.trim() === '') {
            try {
                const module = this.currentModule || '';
                const res = await fetch(`/api/mibs/browse/tree/oid?root_oid=${oid}&depth=1&module=${module}`);
                const data = await res.json();
                
                if (data.children && data.children.length > 0) {
                    this.cacheNodesRecursive(data.children);
                    children.innerHTML = data.children.map(child => 
                        this.buildTreeNodeHtml(child, 0)
                    ).join('');
                }
            } catch (e) {
                console.error(`Failed to load children for ${oid}:`, e);
            }
        }
        
        // Expand
        icon.classList.remove('fa-chevron-right');
        icon.classList.add('fa-chevron-down');
        children.style.display = 'block';
    },

    restoreSelectedNode: async function() {
        if (!this.pendingSelectedOid) {
            return;
        }
        
        // Wait a bit for DOM to settle
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Try to find the node in the tree
        let nodeEl = document.querySelector(`.tree-node[data-oid="${this.pendingSelectedOid}"]`);
        
        if (!nodeEl) {
            // Node might be in search results
            nodeEl = document.querySelector(`.search-result-item[data-oid="${this.pendingSelectedOid}"]`);
        }
        
        if (nodeEl) {
            // Highlight the node
            const contentEl = nodeEl.querySelector('.tree-node-content') || nodeEl;
            if (contentEl) {
                contentEl.classList.add('bg-primary', 'text-white');
                
                // Scroll into view
                contentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            
            // Load details
            try {
                await this.loadNodeDetails(this.pendingSelectedOid);
            } catch (e) {
                console.error('Failed to restore node details:', e);
                const panel = document.getElementById('browser-details-panel');
                if (panel) {
                    panel.innerHTML = `
                        <div class="text-center text-muted p-5">
                            <i class="fas fa-exclamation-triangle fa-3x mb-3 text-warning"></i>
                            <p>Could not restore previous selection</p>
                            <p class="small">The node may have been removed or filtered out</p>
                            <button type="button" class="btn btn-sm btn-outline-primary mt-2" onclick="BrowserModule.clearSelection()">
                                <i class="fas fa-times"></i> Clear Selection
                            </button>
                        </div>
                    `;
                }
            }
        } else {
            // Node not found — clear silently, no console.warn needed
            this.pendingSelectedOid = null;
        }
    },

    clearSelection: function() {
        document.querySelectorAll('.tree-node-content, .search-result-item').forEach(el => {
            el.classList.remove('bg-primary', 'text-white', 'active');
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
            btnModule.classList.remove('btn-outline-primary');
            btnModule.classList.add('btn-primary');
            btnOid.classList.remove('btn-primary');
            btnOid.classList.add('btn-outline-secondary');
        } else {
            btnOid.classList.remove('btn-outline-secondary');
            btnOid.classList.add('btn-primary');
            btnModule.classList.remove('btn-primary');
            btnModule.classList.add('btn-outline-primary');
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
    
    switchView: function(view) {
        this.currentView = view;
        this.setButtonStates();
        this.saveState();
        
        const filtersSection = document.getElementById('filters-section');
        const searchSection = document.getElementById('search-section');
        
        if (view === 'oid') {
            // BUG FIX: was style.display = 'none' — use classList for consistency
            filtersSection.classList.add('d-none');
            searchSection.classList.add('d-none');
            
            // Clear filters
            this.currentModule = null;
            this.currentTypeFilter = null;
            document.getElementById('browser-module-filter').value = '';
            document.getElementById('browser-type-filter').value = '';
            document.getElementById('browser-search-input').value = '';
            document.getElementById('btn-clear-search').classList.add('d-none');
            this.isSearchActive = false;
        } else {
            // BUG FIX: was style.display = 'block'
            filtersSection.classList.remove('d-none');
            searchSection.classList.remove('d-none');
        }
        
        // Update title
        const title = document.getElementById('browser-tree-title');
        if (title) {
            title.textContent = view === 'module' ? 'MIB Tree (By Module)' : 'OID Hierarchy (Standard Tree)';
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
    
    search: async function() {
        const query = document.getElementById('browser-search-input').value.trim();
        const container = document.getElementById('browser-tree-container');
        const countBadge = document.getElementById('browser-tree-count');
        const esc = TrishulUtils.escapeHtml;
        
        if (query.length < 2) {
            return;
        }
        
        this.isSearchActive = true;
        container.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm"></div></div>';
        
        try {
            const module = this.currentModule || '';
            const typeFilter = this.currentTypeFilter || '';
            const res = await fetch(`/api/mibs/browse/search?query=${encodeURIComponent(query)}&module=${module}&type_filter=${typeFilter}&limit=100`);
            const data = await res.json();
            this.currentSearchResults = data.results || [];
            this.cacheNodesRecursive(this.currentSearchResults);
            
            countBadge.textContent = data.count;
            
            if (data.results.length === 0) {
                container.innerHTML = `
                    <div class="text-center text-muted p-5">
                        <i class="fas fa-search fa-3x mb-3"></i>
                        <p>No results found for "<strong>${esc(query)}</strong>"</p>
                        <p class="small">Try different keywords or clear filters</p>
                    </div>
                `;
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
                <div class="list-group-item list-group-item-action p-2 search-result-item" 
                     onclick="BrowserModule.selectNodeFromElement(this)"
                     data-oid="${esc(node.oid)}"
                     style="cursor: pointer;">
                    <div class="d-flex justify-content-between align-items-start">
                        <div class="flex-grow-1">
                            <div class="fw-bold small">
                                <i class="fas ${icon} ${iconColor} me-1"></i>
                                ${esc(node.name)}
                            </div>
                            <code class="text-muted" style="font-size: 0.7rem;">${esc(node.oid)}</code>
                            <span class="badge bg-secondary ms-2" style="font-size: 0.65rem;">${esc(node.module)}</span>
                        </div>
                    </div>
                    ${node.description ? `
                        <div class="text-muted mt-1" style="font-size: 0.75rem; max-height: 40px; overflow: hidden; text-overflow: ellipsis;">
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
        
        container.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm"></div></div>';
        
        try {
            let data;
            
            if (this.currentView === 'module') {
                const module = this.currentModule || '';
                const url = module ? `/api/mibs/browse/tree/module?module=${module}` : '/api/mibs/browse/tree/module';
                const res = await fetch(url);
                
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }
                
                data = await res.json();
                
                if (!data.modules || data.modules.length === 0) {
                    container.innerHTML = `
                        <div class="text-center text-muted p-5">
                            <i class="fas fa-inbox fa-3x mb-3"></i>
                            <p>No MIBs loaded</p>
                            <p class="small">
                                <a href="#mibs" class="btn btn-sm btn-primary">
                                    <i class="fas fa-upload"></i> Upload MIB Files
                                </a>
                            </p>
                        </div>
                    `;
                    countBadge.textContent = '0';
                    return;
                }
                
                this.cacheNodesRecursive(data.modules);
                this.renderModuleTree(data.modules, container);
                countBadge.textContent = data.count;
                
                setTimeout(() => {
                    this.restoreExpandedNodes();
                }, 100);
                
            } else {
                const module = this.currentModule || '';
                const url = module 
                    ? `/api/mibs/browse/tree/oid?root_oid=1.3.6.1&depth=2&module=${module}`
                    : '/api/mibs/browse/tree/oid?root_oid=1.3.6.1&depth=2';
                const res = await fetch(url);
                
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
            container.innerHTML = '<div class="text-center text-muted p-3 small">No modules found</div>';
            return;
        }
        
        const esc = TrishulUtils.escapeHtml;
        let html = '';
        
        modules.forEach(module => {
            let children = module.children || [];
            
            if (this.currentTypeFilter) {
                children = this.filterNodesByType(children, this.currentTypeFilter);
            }
            
            const hasChildren = children.length > 0;
            
            if (this.currentTypeFilter && !hasChildren) {
                return;
            }
            
            html += `
                <div class="tree-node tree-module" data-oid="${esc(module.oid)}">
                    <div class="d-flex align-items-center py-2 px-3 tree-node-content border-bottom">
                        ${hasChildren ? `
                            <i class="fas fa-chevron-right fa-xs me-2 tree-expand-icon" 
                            onclick="event.stopPropagation(); BrowserModule.toggleNode(this.dataset.oid)"
                            data-oid="${esc(module.oid)}"></i>
                        ` : '<span style="width: 18px;"></span>'}
                        <i class="fas fa-book text-primary me-2"></i>
                        <span class="tree-node-name fw-bold">${esc(module.name)}</span>
                        <span class="badge bg-light text-dark ms-auto" style="font-size: 0.7rem;">${children.length} ${this.currentTypeFilter ? this.getTypeLabel(this.currentTypeFilter) : 'objects'}</span>
                    </div>
                    ${hasChildren ? `
                        <div class="tree-children" style="display: none; padding-left: 20px;">
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
    
    renderOidTree: function(data, container) {
        const esc = TrishulUtils.escapeHtml;
        const html = `
            <div class="tree-node" data-oid="${esc(data.root.oid)}">
                <div class="d-flex align-items-center py-2 px-3 tree-node-content border-bottom" 
                     onclick="BrowserModule.selectNode(this.parentElement.dataset.oid)">
                    ${data.children.length > 0 ? `
                        <i class="fas fa-chevron-right fa-xs me-2 tree-expand-icon" 
                           onclick="event.stopPropagation(); BrowserModule.toggleNode(this.dataset.oid)"
                           data-oid="${esc(data.root.oid)}"></i>
                    ` : '<span style="width: 18px;"></span>'}
                    <i class="fas fa-cube text-secondary me-2"></i>
                    <span class="tree-node-name fw-bold">${esc(data.root.name)}</span>
                    <code class="ms-auto text-muted small">${esc(data.root.oid)}</code>
                </div>
                <div class="tree-children" style="display: none; padding-left: 20px;">
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
            <div class="tree-node" data-oid="${esc(node.oid)}" style="padding-left: ${indent}px;">
                <div class="d-flex align-items-center py-1 px-2 tree-node-content" 
                     onclick="BrowserModule.selectNode(this.parentElement.dataset.oid)">
                    ${hasChildren ? `
                        <i class="fas fa-chevron-right fa-xs me-2 tree-expand-icon" 
                           onclick="event.stopPropagation(); BrowserModule.toggleNode(this.dataset.oid)"
                           data-oid="${esc(node.oid)}"></i>
                    ` : '<span style="width: 18px;"></span>'}
                    <i class="fas ${icon} ${iconColor} me-2" style="font-size: 0.85rem;"></i>
                    <span class="tree-node-name small">${esc(node.name)}</span>
                    <code class="ms-auto text-muted" style="font-size: 0.65rem;">${esc(node.oid.split('.').slice(-2).join('.'))}</code>
                </div>
                ${hasChildren ? '<div class="tree-children" style="display: none;"></div>' : ''}
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
            
            if (icon && children && children.style.display === 'block') {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-right');
                children.style.display = 'none';
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
            const oid = node.getAttribute('data-oid');
            const icon = node.querySelector(':scope > .tree-node-content > .tree-expand-icon');
            const children = node.querySelector(':scope > .tree-children');
            
            if (icon && children) {
                if (children.innerHTML.trim() === '') {
                    try {
                        const module = this.currentModule || '';
                        const res = await fetch(`/api/mibs/browse/tree/oid?root_oid=${oid}&depth=1&module=${module}`);
                        const data = await res.json();
                        
                        if (data.children && data.children.length > 0) {
                            this.cacheNodesRecursive(data.children);
                            children.innerHTML = data.children.map(child => 
                                this.buildTreeNodeHtml(child, 0)
                            ).join('');
                        }
                    } catch (e) {
                        console.error('Failed to load children:', e);
                    }
                }
                
                icon.classList.remove('fa-chevron-right');
                icon.classList.add('fa-chevron-down');
                children.style.display = 'block';
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
                const module = this.currentModule || '';
                const res = await fetch(`/api/mibs/browse/tree/oid?root_oid=${oid}&depth=1&module=${module}`);
                const data = await res.json();
                
                if (data.children && data.children.length > 0) {
                    this.cacheNodesRecursive(data.children);
                    children.innerHTML = data.children.map(child => 
                        this.buildTreeNodeHtml(child, 0)
                    ).join('');
                }
            } catch (e) {
                console.error(`Failed to load children for ${oid}:`, e);
                return;
            }
        }
        
        icon.classList.remove('fa-chevron-right');
        icon.classList.add('fa-chevron-down');
        children.style.display = 'block';
        
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
            'Module': 'text-primary',
            'MibTable': 'text-purple',
            'MibTableColumn': 'text-success',
            'MibScalar': 'text-info',
            'NotificationType': 'text-warning',
            'ObjectGroup': 'text-secondary'
        };
        return colors[type] || 'text-muted';
    },
    
    toggleNode: async function(oid) {
        const nodeEl = document.querySelector(`.tree-node[data-oid="${oid}"]`);
        if (!nodeEl) return;
        
        const childrenEl = nodeEl.querySelector('.tree-children');
        const icon = nodeEl.querySelector('.tree-expand-icon');
        
        if (!childrenEl) return;
        
        if (childrenEl.style.display === 'none') {
            icon.classList.remove('fa-chevron-right');
            icon.classList.add('fa-chevron-down');
            
            if (childrenEl.innerHTML === '') {
                try {
                    const module = this.currentModule || '';
                    const res = await fetch(`/api/mibs/browse/tree/oid?root_oid=${oid}&depth=1&module=${module}`);
                    const data = await res.json();
                    
                    if (data.children.length > 0) {
                        this.cacheNodesRecursive(data.children);
                        childrenEl.innerHTML = data.children.map(child => 
                            this.buildTreeNodeHtml(child, 0)
                        ).join('');
                    } else {
                        childrenEl.innerHTML = '<div class="text-muted small px-2 py-1">No children</div>';
                    }
                } catch (e) {
                    console.error('Failed to load children:', e);
                    childrenEl.innerHTML = '<div class="text-danger small px-2 py-1">Failed to load</div>';
                }
            }
            
            childrenEl.style.display = 'block';
        } else {
            icon.classList.remove('fa-chevron-down');
            icon.classList.add('fa-chevron-right');
            childrenEl.style.display = 'none';
        }
    },
    
    selectNode: async function(oid) {
        document.querySelectorAll('.tree-node-content, .search-result-item').forEach(el => {
            el.classList.remove('bg-primary', 'text-white', 'active');
        });
        
        const nodeEl = document.querySelector(`.tree-node[data-oid="${oid}"] > .tree-node-content`) ||
                    document.querySelector(`.search-result-item[data-oid="${oid}"]`);
        if (nodeEl) {
            nodeEl.classList.add('bg-primary', 'text-white');
        }
        
        await this.loadNodeDetails(oid);
        
        this.saveState();
    },
    
    loadNodeDetails: async function(oid) {
        const panel = document.getElementById('browser-details-panel');
        panel.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm"></div></div>';
        
        try {
            const res = await fetch(`/api/mibs/browse/node/${encodeURIComponent(oid)}`);
            
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
                    <button type="button" class="btn btn-sm btn-outline-primary" onclick="BrowserModule.clearSelection()">
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
                                    <a href="#" onclick="return BrowserModule.selectNodeFromLink(this)" data-oid="${esc(b.oid)}">
                                        ${esc(b.name)}
                                    </a>
                                `}
                            </li>
                        `).join('')}
                    </ol>
                </nav>
            ` : ''}
            
            <!-- Compact Key-Value Pairs -->
            <table class="table table-sm table-borderless mb-3" style="font-size: 0.85rem;">
                <tbody>
                    <tr>
                        <td class="text-muted fw-bold" style="width: 30%;">Name</td>
                        <td><code>${esc(node.name)}</code></td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">Full Name</td>
                        <td>
                            <div class="d-flex align-items-center">
                                <code class="flex-grow-1 text-truncate" title="${esc(node.full_name)}">${esc(node.full_name)}</code>
                                <button type="button" class="btn btn-xs btn-outline-secondary ms-2" 
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
                            <div class="d-flex align-items-center">
                                <code class="flex-grow-1 text-truncate" title="${esc(node.oid)}">${esc(node.oid)}</code>
                                <button type="button" class="btn btn-xs btn-outline-secondary ms-2" 
                                        onclick="BrowserModule.copyValue(this.dataset.copy)"
                                        data-copy="${esc(node.oid)}">
                                    <i class="fas fa-copy"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">Module</td>
                        <td><span class="badge bg-secondary">${esc(node.module)}</span></td>
                    </tr>
                    <tr>
                        <td class="text-muted fw-bold">Type</td>
                        <td><span class="badge bg-info">${esc(node.type)}</span></td>
                    </tr>
                    ${node.syntax ? `
                        <tr>
                            <td class="text-muted fw-bold">Syntax</td>
                            <td><code class="small">${esc(node.syntax)}</code></td>
                        </tr>
                    ` : ''}
                    ${node.access ? `
                        <tr>
                            <td class="text-muted fw-bold">Access</td>
                            <td><span class="badge bg-warning text-dark">${esc(node.access)}</span></td>
                        </tr>
                    ` : ''}
                    ${node.status ? `
                        <tr>
                            <td class="text-muted fw-bold">Status</td>
                            <td><span class="badge ${node.status === 'current' ? 'bg-success' : 'bg-secondary'}">${esc(node.status)}</span></td>
                        </tr>
                    ` : ''}
                </tbody>
            </table>
            
            ${node.description ? `
                <div class="mb-3">
                    <label class="fw-bold small text-muted d-block mb-1">Description</label>
                    <div class="small text-muted p-2 bg-light rounded" style="max-height: 120px; overflow-y: auto; font-size: 0.75rem;">
                        ${esc(node.description)}
                    </div>
                </div>
            ` : ''}
            
            ${isNotification && trapObjects.length > 0 ? `
                <div class="mb-3">
                    <label class="fw-bold small text-muted d-block mb-1">VarBinds (${trapObjects.length})</label>
                    <div class="list-group list-group-flush small" style="max-height: 150px; overflow-y: auto;">
                        ${trapObjects.map(obj => `
                            <div class="list-group-item px-2 py-1 border-0 bg-light mb-1 rounded">
                                <code class="small">${esc(obj.name)}</code>
                                <div class="text-muted" style="font-size: 0.65rem;">${esc(obj.full_name)}</div>
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
                    <button type="button" class="btn btn-sm btn-primary" onclick="BrowserModule.useInWalker(this.dataset.fullName)" data-full-name="${esc(node.full_name)}">
                        <i class="fas fa-walking"></i> Walk this OID
                    </button>
                ` : ''}
                ${isNotification ? `
                    <button type="button" class="btn btn-sm btn-success" onclick="BrowserModule.useInTrapSenderFromElement(this)" data-trap="${esc(trapPayload)}">
                        <i class="fas fa-paper-plane"></i> Send this Trap
                    </button>
                ` : ''}
            </div>
        `;
    },

    selectNodeFromElement: function(el) {
        this.selectNode(el?.dataset?.oid);
    },

    selectNodeFromLink: function(link) {
        this.selectNode(link?.dataset?.oid);
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
            const cached = this.nodeCache[oid] || {};
            rows.push({
                view: this.currentView,
                oid: oid,
                name: cached.name || '',
                full_name: cached.full_name || '',
                module: cached.module || '',
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

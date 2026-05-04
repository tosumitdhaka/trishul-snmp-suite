window.MibsModule = {
    currentTrapData: null,
    uploadModal: null,
    trapDetailsModal: null,
    allTraps: [],
    currentStatus: null,

    init: function() {
        this.uploadModal = new bootstrap.Modal(document.getElementById('uploadModal'));
        this.trapDetailsModal = new bootstrap.Modal(document.getElementById('trapDetailsModal'));

        this.loadStatus();
        this.loadTraps();

        document.getElementById('trap-search').addEventListener('input', (e) => {
            this.filterTraps(e.target.value);
        });

        // Auto-validate whenever user selects files via the file picker
        document.getElementById('mib-upload-input').addEventListener('change', () => {
            this.validateFiles();
        });

        this.initDropzone();
    },

    initDropzone: function() {
        const dropzone = document.getElementById('mib-dropzone');
        const overlay  = document.getElementById('drop-overlay');
        const fileInput = document.getElementById('mib-upload-input');

        if (!dropzone || !overlay || !fileInput) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, e => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        let dragCounter = 0;

        dropzone.addEventListener('dragenter', () => {
            dragCounter++;
            overlay.classList.remove('d-none');
            overlay.classList.add('d-flex');
        });

        dropzone.addEventListener('dragleave', () => {
            dragCounter--;
            if (dragCounter === 0) {
                overlay.classList.add('d-none');
                overlay.classList.remove('d-flex');
            }
        });

        dropzone.addEventListener('drop', (e) => {
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

    loadStatus: async function() {
        try {
            const res  = await fetch('/api/mibs/status');
            const data = await res.json();

            this.currentStatus = data;

            document.getElementById('mib-count-loaded').textContent = data.loaded;
            document.getElementById('mib-count-failed').textContent = data.failed;

            const loadedTraps = data.mibs.reduce((sum, mib) => sum + mib.traps, 0);
            document.getElementById('mib-count-traps').textContent = loadedTraps;

            this.renderMibList(data.mibs);

            const failedCard = document.getElementById('failed-mibs-card');
            if (data.errors.length > 0) {
                this.renderFailedMibs(data.errors);
                failedCard.classList.remove('d-none');
            } else {
                failedCard.classList.add('d-none');
            }
        } catch (e) {
            console.error('Failed to load MIB status', e);
        }
    },

    renderMibList: function(mibs) {
        const list = document.getElementById('mib-list');
        const esc = TrishulUtils.escapeHtml;

        if (mibs.length === 0) {
            list.innerHTML = '<li class="list-group-item text-center text-muted">No MIBs loaded</li>';
            return;
        }

        list.innerHTML = mibs.map(mib => `
            <li class="list-group-item d-flex justify-content-between align-items-center py-2">
                <div class="flex-grow-1">
                    <div class="d-flex align-items-center">
                        <i class="fas fa-book text-success me-2"></i>
                        <strong>${esc(mib.name)}</strong>
                        <span class="badge bg-success ms-2">✓</span>
                    </div>
                    <small class="text-muted d-block mt-1">
                        ${Number(mib.objects || 0)} objects · ${Number(mib.traps || 0)} traps
                        ${mib.imports.length > 0 ? `· Imports: ${mib.imports.slice(0, 3).map(esc).join(', ')}${mib.imports.length > 3 ? '...' : ''}` : ''}
                    </small>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger" onclick="MibsModule.deleteMib(this.dataset.filename)" data-filename="${esc(mib.file)}">
                    <i class="fas fa-trash"></i>
                </button>
            </li>
        `).join('');
    },

    renderFailedMibs: function(errors) {
        const list = document.getElementById('failed-mib-list');
        const esc = TrishulUtils.escapeHtml;

        list.innerHTML = errors.map(mib => `
            <li class="list-group-item">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="flex-grow-1">
                        <div class="d-flex align-items-center">
                            <i class="fas fa-exclamation-circle text-danger me-2"></i>
                            <strong class="text-danger">${esc(mib.name)}</strong>
                        </div>
                        <div class="small text-muted mt-1 font-monospace" style="max-width: 500px; overflow-wrap: break-word;">
                            ${esc(mib.error || 'Unknown error')}
                        </div>
                        ${mib.status === 'missing_deps' ? `
                            <div class="mt-2">
                                <span class="badge bg-warning text-dark">Missing dependencies</span>
                                ${mib.missing_deps && mib.missing_deps.length > 0 ? `
                                    <div class="small mt-1">${mib.missing_deps.map(esc).join(', ')}</div>
                                ` : ''}
                                <button type="button" class="btn btn-xs btn-outline-primary ms-2" onclick="MibsModule.fetchDependenciesFromElement(this)" data-deps="${esc(TrishulUtils.encodeDataAttr(mib.missing_deps || []))}">
                                    <i class="fas fa-cloud-download-alt"></i> Fetch
                                </button>
                                <button type="button" class="btn btn-xs btn-outline-info ms-2" onclick="MibsModule.showDependencyHelp()">
                                    <i class="fas fa-question-circle"></i> Help
                                </button>
                            </div>
                        ` : ''}
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-danger" onclick="MibsModule.deleteMib(this.dataset.filename)" data-filename="${esc(mib.file)}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </li>
        `).join('');
    },

    loadTraps: async function() {
        try {
            const res  = await fetch('/api/mibs/traps');
            const data = await res.json();

            this.allTraps = data.traps || [];

            const totalBadge = document.getElementById('trap-total-count');
            if (totalBadge) totalBadge.textContent = this.allTraps.length;

            this.renderTraps(this.allTraps);
        } catch (e) {
            console.error('Failed to load traps', e);
        }
    },

    renderTraps: function(traps) {
        const tbody = document.getElementById('trap-table-body');
        const esc = TrishulUtils.escapeHtml;

        if (traps.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-3">No traps found</td></tr>';
            return;
        }

        const loadedModules  = new Set();
        if (this.currentStatus && this.currentStatus.mibs) {
            this.currentStatus.mibs.forEach(mib => loadedModules.add(mib.name));
        }

        const knownSystemMibs = ['SNMPv2-MIB', 'SNMPv2-SMI', 'RMON-MIB', 'SNMP-FRAMEWORK-MIB'];

        tbody.innerHTML = traps.map(trap => {
            const isSystemMib = knownSystemMibs.includes(trap.module) && !loadedModules.has(trap.module);
            const payload = esc(TrishulUtils.encodeDataAttr(trap));

            return `
            <tr ${isSystemMib ? 'class="table-secondary"' : ''}>
                <td title="${esc(trap.name)}">
                    <div class="d-flex align-items-center">
                        <i class="fas fa-bell ${isSystemMib ? 'text-secondary' : 'text-warning'} me-2"></i>
                        <strong class="text-truncate">${esc(trap.name)}</strong>
                        ${isSystemMib ? '<span class="badge bg-secondary ms-2" style="font-size: 0.6rem;">System</span>' : ''}
                    </div>
                </td>
                <td title="${esc(trap.oid)}">
                    <code class="small text-muted text-truncate d-block" style="font-size: 0.7rem;">${esc(trap.oid)}</code>
                </td>
                <td class="text-center">
                    <span class="badge ${isSystemMib ? 'bg-secondary' : 'bg-primary'}" style="font-size: 0.7rem;">${esc(trap.module)}</span>
                </td>
                <td class="text-center">
                    <span class="badge bg-info" style="font-size: 0.7rem;">${Number((trap.objects || []).length)}</span>
                </td>
                <td class="text-center">
                    <div class="btn-group btn-group-sm" role="group">
                        <button type="button" class="btn btn-outline-primary btn-sm py-0 px-2"
                                onclick="MibsModule.handleTrapAction(this)"
                                data-action="details"
                                data-trap="${payload}"
                                title="View Details">
                            <i class="fas fa-info-circle"></i>
                        </button>
                        <button type="button" class="btn btn-success btn-sm py-0 px-2"
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

    showTrapDetails: function(trap) {
        this.currentTrapData = trap;

        const title = document.getElementById('trap-detail-title');
        const body  = document.getElementById('trap-detail-body');
        const esc = TrishulUtils.escapeHtml;

        title.textContent = trap.full_name;
        const copyOid = esc(trap.oid || '');

        body.innerHTML = `
            <div class="mb-3">
                <label class="fw-bold">Name:</label>
                <div><code>${esc(trap.name)}</code></div>
            </div>
            <div class="mb-3">
                <label class="fw-bold">Full Name:</label>
                <div><code>${esc(trap.full_name)}</code></div>
            </div>
            <div class="mb-3">
                <label class="fw-bold">OID:</label>
                <div>
                    <code>${esc(trap.oid)}</code>
                    <button type="button" class="btn btn-xs btn-outline-secondary ms-2"
                            onclick="MibsModule.copyValue(this.dataset.copy)"
                            data-copy="${copyOid}">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>
            </div>
            <div class="mb-3">
                <label class="fw-bold">Module:</label>
                <div><span class="badge bg-secondary">${esc(trap.module)}</span></div>
            </div>
            <div class="mb-3">
                <label class="fw-bold">Description:</label>
                <div class="text-muted">${esc(trap.description || 'No description available')}</div>
            </div>
            <div class="mb-3">
                <label class="fw-bold">Associated Objects (VarBinds):</label>
                ${(trap.objects || []).length > 0 ? `
                    <ul class="list-group mt-2">
                        ${(trap.objects || []).map(obj => `
                            <li class="list-group-item d-flex justify-content-between align-items-center">
                                <div>
                                    <code>${esc(obj.name)}</code>
                                    <div class="small text-muted">${esc(obj.full_name)}</div>
                                </div>
                                <code class="text-muted small">${esc(obj.oid)}</code>
                            </li>
                        `).join('')}
                    </ul>
                ` : '<div class="text-muted">No associated objects defined</div>'}
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
        document.getElementById('mib-upload-input').value = '';
        document.getElementById('upload-validation-results').classList.add('d-none');
        document.getElementById('dependency-alert').classList.add('d-none');
        document.getElementById('validating-indicator').classList.add('d-none');
        document.getElementById('btn-upload').disabled = true;
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

        indicator.classList.remove('d-none');
        resultsDiv.classList.add('d-none');
        depAlert.classList.add('d-none');
        document.getElementById('btn-upload').disabled = true;

        try {
            const formData = new FormData();
            for (let file of input.files) formData.append('files', file);

            const res  = await fetch('/api/mibs/validate-batch', { method: 'POST', body: formData });
            const data = await res.json();
            const esc = TrishulUtils.escapeHtml;

            validationList.innerHTML = data.files.map(r => {
                const hasLocalMissing = r.missing_deps.length > 0;
                const statusClass  = r.valid ? 'border-success' : 'border-danger';
                const statusBadge  = r.valid
                    ? '<span class="badge bg-success">✓ Valid</span>'
                    : '<span class="badge bg-danger">✗ Invalid</span>';

                return `
                    <div class="card mb-2 ${statusClass}">
                        <div class="card-body p-2">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <strong>${esc(r.filename)}</strong>
                                    <span class="text-muted small ms-2">(${esc(r.mib_name)})</span>
                                </div>
                                ${statusBadge}
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
                        </div>
                    </div>`;
            }).join('');

            resultsDiv.classList.remove('d-none');

            const fetchBtn = document.getElementById('btn-fetch-dependencies');
            if (data.global_missing_deps.length > 0) {
                depList.innerHTML = `
                    <p class="mb-2">The following dependencies are not available:</p>
                    <ul class="mb-2">
                        ${data.global_missing_deps.map(dep => `<li><code>${esc(dep)}</code></li>`).join('')}
                    </ul>
                    <p class="mb-0 small">
                        <strong>Options:</strong><br>
                        • Fetch them from the approved remote source list<br>
                        • Upload them manually in a separate batch first<br>
                        • Continue anyway (affected MIBs will fail to load)
                    </p>`;
                if (fetchBtn) {
                    fetchBtn.disabled = false;
                    fetchBtn.dataset.deps = TrishulUtils.encodeDataAttr(data.global_missing_deps);
                }
                depAlert.classList.remove('d-none');
            } else {
                if (fetchBtn) {
                    fetchBtn.disabled = true;
                    fetchBtn.dataset.deps = '';
                }
                depAlert.classList.add('d-none');
            }

            const uploadBtn = document.getElementById('btn-upload');
            uploadBtn.disabled = !data.can_upload;
            uploadBtn.innerHTML = data.can_upload
                ? '<i class="fas fa-upload"></i> Upload &amp; Reload'
                : '<i class="fas fa-ban"></i> Cannot Upload (Fix Errors)';

        } catch (e) {
            console.error('Validation error:', e);
            alert('Validation failed: ' + e.message);
        } finally {
            indicator.classList.add('d-none');
        }
    },

    uploadFiles: async function() {
        const input = document.getElementById('mib-upload-input');
        const btn   = document.getElementById('btn-upload');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
        btn.disabled  = true;

        try {
            const formData = new FormData();
            for (let file of input.files) formData.append('files', file);

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
            const failed = data.results.filter(r => r.status === 'failed').length;
            const errors = data.results.filter(r => r.status === 'error').length;

            let message = `Upload Complete!\n\n✓ Successfully loaded: ${loaded}\n`;
            if (failed > 0) message += `⚠ Failed to load: ${failed}\n`;
            if (errors > 0) message += `✗ Upload errors: ${errors}\n`;
            if (data.dependency_fetch && data.dependency_fetch.enabled) {
                const downloadedDeps = (data.dependency_fetch.downloaded || []).length;
                const cachedDeps = (data.dependency_fetch.cached || []).length;
                const failedDeps = (data.dependency_fetch.failed || []).length;
                message += `\nDependency fetch: ${downloadedDeps} downloaded`;
                if (cachedDeps > 0) message += `, ${cachedDeps} cached`;
                if (failedDeps > 0) message += `, ${failedDeps} failed`;
                message += '\n';
            }

            const problemFiles = data.results.filter(r => r.status === 'failed' || r.status === 'error');
            if (problemFiles.length > 0) {
                message += `\nDetails:\n`;
                problemFiles.forEach(r => { message += `• ${r.filename}: ${r.error || 'Unknown error'}\n`; });
            }

            alert(message);
            await this.loadStatus();
            await this.loadTraps();
            this.uploadModal.hide();

        } catch (e) {
            console.error('Upload error:', e);
            alert('Upload failed:\n\n' + e.message);
        } finally {
            btn.innerHTML = originalText;
            btn.disabled  = false;
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
            await this.loadStatus();
            await this.loadTraps();
            const downloadedDeps = data.dependency_fetch ? (data.dependency_fetch.downloaded || []).length : 0;
            const cachedDeps = data.dependency_fetch ? (data.dependency_fetch.cached || []).length : 0;
            let message = `Reloaded: ${data.loaded} loaded, ${data.failed} failed`;
            if (data.dependency_fetch && data.dependency_fetch.enabled) {
                message += ` · deps ${downloadedDeps} downloaded`;
                if (cachedDeps > 0) message += `, ${cachedDeps} cached`;
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
        if (!confirm(`Delete ${filename}?\n\nThis will remove the MIB file and reload all MIBs.`)) return;

        try {
            const res = await fetch(`/api/mibs/${filename}`, { method: 'DELETE' });
            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.detail || 'Delete failed');
            }
            TrishulUtils.showNotification(`Deleted ${filename}`, 'success');
            await this.reloadMibs();
        } catch (e) {
            console.error('Delete failed:', e);
            alert(`Delete failed: ${e.message}`);
        }
    },

    showDependencyHelp: function() {
        alert(
            'How to resolve missing dependencies:\n\n' +
            '1. Use "Fetch Missing Dependencies" to download from the approved source list configured in Settings\n' +
            '2. Or upload the required MIBs manually using this dialog\n' +
            '3. Reload after the dependencies are available\n\n' +
            'Validation never performs remote fetches. Auto-fetch, if enabled, only runs during upload/reload.'
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
            await this.loadStatus();
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

window.DashboardModule = {
    _listeners: [],
    _cache: null,

    init: function () {
        this.destroy();
        this._registerListeners();
        // Re-apply cached values immediately so spinners don't flash on page switch.
        if (this._cache) {
            if (this._cache.sim && this._cache.trap) this._applyStatus(this._cache.sim, this._cache.trap);
            if (this._cache.mibs) this._applyMibs(this._cache.mibs);
            if (this._cache.stats) this._applyStats(this._cache.stats);
        }
        // Re-seed live runtime state on page entry. MIB summary is already
        // broadcast over WS and cached locally, so only fetch it when empty.
        this._loadAllViaRest({ includeMibs: !(this._cache && this._cache.mibs) });
    },

    destroy: function () {
        this._listeners.forEach(function (pair) {
            window.removeEventListener(pair[0], pair[1]);
        });
        this._listeners = [];
    },

    _on: function (type, fn) {
        window.addEventListener(type, fn);
        this._listeners.push([type, fn]);
    },

    _registerListeners: function () {
        var self = this;

        // Full state on connect
        this._on('trishul:ws:full_state', function (e) {
            self._applyStatus(e.detail.simulator, e.detail.traps);
            if (e.detail.mibs)  self._applyMibs(e.detail.mibs);
            if (e.detail.stats) self._applyStats(e.detail.stats);
        });

        // Lightweight status on lifecycle change (start/stop)
        this._on('trishul:ws:status', function (e) {
            self._applyStatus(e.detail.simulator, e.detail.traps);
        });

        // MIB mutation broadcast
        this._on('trishul:ws:mibs', function (e) {
            if (e.detail.mibs) self._applyMibs(e.detail.mibs);
        });

        // Stats broadcast — sent after any stats write
        this._on('trishul:ws:stats', function (e) {
            const stats = e.detail.stats || e.detail.data;
            if (stats) self._applyStats(stats);
        });

        // Re-seed everything via REST after every WS reconnect
        // (full_state arrives moments later but REST is faster for status)
        this._on('trishul:ws:open', function () {
            self._loadAllViaRest({ includeMibs: !(self._cache && self._cache.mibs) });
        });
    },

    _applyStatus: function (sim, trap) {
        if (!this._cache) this._cache = {};
        this._cache.sim = sim; this._cache.trap = trap;
        var simEl = document.getElementById('stat-simulator');
        var recEl = document.getElementById('stat-receiver');

        if (simEl) {
            TrishulUtils.setStatusTextState(
                simEl,
                sim && sim.running ? 'online' : 'idle',
                sim && sim.running ? 'Online' : 'Offline',
                'mb-0'
            );
        }
        if (recEl) {
            TrishulUtils.setStatusTextState(
                recEl,
                trap && trap.running ? 'online' : 'idle',
                trap && trap.running ? 'Online' : 'Offline',
                'mb-0'
            );
        }
    },

    _applyMibs: function (mibs) {
        if (!this._cache) this._cache = {};
        this._cache.mibs = mibs;
        var mibEl  = document.getElementById('stat-mibs');
        var trapEl = document.getElementById('stat-traps');
        var srcEl  = document.getElementById('act-mibs-uploaded');
        if (mibEl)  { mibEl.textContent  = mibs.loaded         != null ? mibs.loaded         : 0; mibEl.className  = 'mb-0'; }
        if (trapEl) { trapEl.textContent = mibs.traps_available != null ? mibs.traps_available : 0; trapEl.className = 'mb-0'; }
        if (srcEl && mibs.source_files != null) { srcEl.textContent = mibs.source_files; }
    },

    _applyStats: function (stats) {
        if (!stats) return;
        if (!this._cache) this._cache = {};
        this._cache.stats = stats;
        var sim    = stats.simulator || {};
        var traps  = stats.traps     || {};
        var walker = stats.walker    || {};
        var mibs   = stats.mibs      || {};
        var uploadedSourceCount = mibs.upload_count;
        if (uploadedSourceCount == null && this._cache && this._cache.mibs) {
            uploadedSourceCount = this._cache.mibs.source_files;
        }

        function set(id, val) {
            var el = document.getElementById(id);
            if (el) el.textContent = (val != null) ? val : '\u2014';
        }

        set('act-snmp-requests', sim.snmp_requests_served);
        set('act-oids-loaded',   sim.oids_loaded);
        set('act-traps-recv',    traps.traps_received_total);
        set('act-traps-sent',    traps.traps_sent_total);
        set('act-walks',         walker.walks_executed);
        set('act-oids-returned', walker.oids_returned);
        set('act-mibs-uploaded', uploadedSourceCount);
        set('act-mibs-reloaded', mibs.reload_count);
    },

    resetStats: async function () {
        const confirmed = await TrishulUtils.confirmDialog({
            title: 'Reset all activity counters?',
            message: 'This cannot be undone.',
            confirmLabel: 'Reset',
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            var res = await fetch('/api/stats/', { method: 'DELETE' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            await this._loadStatsViaRest();
            TrishulUtils.showNotification('Activity stats reset', 'success');
        } catch (e) {
            TrishulUtils.showNotification('Reset failed: ' + e.message, 'error');
        }
    },

    // ---------------------------------------------------------------------------
    // REST helpers
    // ---------------------------------------------------------------------------

    // Full REST seed — calls the focused helpers in parallel.
    _loadAllViaRest: function (options) {
        options = options || {};
        this._loadStatusViaRest();
        this._loadStatsViaRest();
        if (options.includeMibs) {
            this._loadMibsViaRest();
        }
    },

    // Simulator + trap-receiver running state
    _loadStatusViaRest: async function () {
        try {
            var results = await Promise.all([
                fetch('/api/simulator/status').catch(function () { return null; }),
                fetch('/api/traps/status').catch(function ()     { return null; })
            ]);
            var simRes  = results[0];
            var trapRes = results[1];
            if (simRes && simRes.ok && trapRes && trapRes.ok) {
                this._applyStatus(await simRes.json(), await trapRes.json());
            }
        } catch (e) {}
    },

    // MIB loaded + traps-available counts
    _loadMibsViaRest: async function () {
        try {
            var res = await fetch('/api/mibs/status');
            if (!res.ok) return;
            var d = await res.json();
            var trapsAvail = (d.mibs || []).reduce(function (s, m) { return s + (m.traps || 0); }, 0);
            var sourceFiles = (d.source_groups || []).reduce(function (s, group) {
                return s + (Number(group && group.file_count) || 0);
            }, 0);
            this._applyMibs({
                loaded: d.loaded || 0,
                traps_available: trapsAvail,
                source_files: sourceFiles
            });
        } catch (e) {}
    },

    // All activity counters
    _loadStatsViaRest: async function () {
        try {
            var res = await fetch('/api/stats/');
            if (!res.ok) return;
            this._applyStats(await res.json());
        } catch (e) {}
    },

    showError: function (elementId, text) {
        var el = document.getElementById(elementId);
        if (el) {
            TrishulUtils.setStatusTextState(el, 'error', text, 'mb-0');
        }
    }
};

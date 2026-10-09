/* Fast workspace navigation. No framework or external dependency required. */
(function () {
    'use strict';

    const PAGES = Object.freeze([
        { id: 'dashboard', title: 'Dashboard', description: 'Runtime health, counters, and shortcuts', keywords: 'home overview status metrics activity', icon: 'fa-gauge-high' },
        { id: 'simulator', title: 'SNMP Simulator', description: 'Manage a responder and custom OID values', keywords: 'agent server start stop logs simulation', icon: 'fa-server' },
        { id: 'walker', title: 'Walk & Parse', description: 'Walk a device, inspect OIDs, and export results', keywords: 'snmpwalk getbulk query parse discover', icon: 'fa-route' },
        { id: 'traps', title: 'Traps', description: 'Send traps and informs, monitor received events', keywords: 'notifications receiver sender replay alerts', icon: 'fa-bell' },
        { id: 'browser', title: 'MIB Browser', description: 'Explore MIB modules, OIDs, and constraints', keywords: 'oid tree catalog resolve search schema', icon: 'fa-sitemap' },
        { id: 'mibs', title: 'MIB Manager', description: 'Manage MIB sources, bundles, and trap definitions', keywords: 'upload reload import dependency catalog sources', icon: 'fa-database' },
        { id: 'settings', title: 'Settings', description: 'Update credentials and application defaults', keywords: 'configuration account password preferences theme', icon: 'fa-gear' }
    ]);

    function findPages(query) {
        const terms = String(query || '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!terms.length) return PAGES.slice();
        return PAGES.map((page, index) => {
            const title = page.title.toLocaleLowerCase();
            const haystack = (page.title + ' ' + page.description + ' ' + page.keywords).toLocaleLowerCase();
            if (!terms.every(term => haystack.includes(term))) return null;
            const score = title.startsWith(terms.join(' ')) ? 0
                : terms.every(term => title.includes(term)) ? 1 : 2;
            return { page, index, score };
        }).filter(Boolean).sort((a, b) => a.score - b.score || a.index - b.index).map(result => result.page);
    }

    // Search is independently testable without a browser DOM.
    if (typeof window !== 'undefined') window.TrishulCommandPalette = { findPages };
    if (typeof document === 'undefined') return;

    let dialog;
    let input;
    let results;
    let live;
    let trigger;
    let pages = [];
    let selectedIndex = 0;
    let priorFocus = null;
    let navigating = false;

    function isSignedIn() {
        const wrapper = document.getElementById('wrapper');
        return Boolean(wrapper && !wrapper.classList.contains('d-none')
            && sessionStorage.getItem('snmp_token'));
    }

    function selectResult(index) {
        if (!pages.length) return;
        selectedIndex = (index + pages.length) % pages.length;
        Array.from(results.querySelectorAll('[role="option"]')).forEach((option, optionIndex) => {
            const active = optionIndex === selectedIndex;
            option.setAttribute('aria-selected', String(active));
            if (active) {
                input.setAttribute('aria-activedescendant', option.id);
                option.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    function goTo(page) {
        navigating = true;
        dialog.close();
        // The route is a known static value, never derived from user input.
        window.location.hash = '#' + page.id;
        trigger.focus();
    }

    function render(query) {
        pages = findPages(query);
        selectedIndex = 0;
        results.replaceChildren();
        input.removeAttribute('aria-activedescendant');
        live.textContent = pages.length + (pages.length === 1 ? ' page found' : ' pages found');

        if (!pages.length) {
            const empty = document.createElement('p');
            empty.className = 'app-command-empty';
            empty.textContent = 'No matching workspace. Try “traps”, “OID”, or “settings”.';
            results.appendChild(empty);
            return;
        }

        pages.forEach((page, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'app-command-option';
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === 0));
            option.id = 'app-command-option-' + page.id;

            const icon = document.createElement('span');
            icon.className = 'app-command-icon';
            icon.setAttribute('aria-hidden', 'true');
            const glyph = document.createElement('i');
            glyph.className = 'fas ' + page.icon;
            icon.appendChild(glyph);

            const copy = document.createElement('span');
            copy.className = 'app-command-copy';
            const title = document.createElement('span');
            title.className = 'app-command-name';
            title.textContent = page.title;
            const description = document.createElement('span');
            description.className = 'app-command-description';
            description.textContent = page.description;
            copy.append(title, description);

            const end = document.createElement('span');
            end.className = 'app-command-end';
            const current = window.location.hash === '#' + page.id
                || (!window.location.hash && page.id === 'dashboard');
            end.textContent = current ? 'Current' : '↗';
            if (current) end.classList.add('is-current');
            end.setAttribute('aria-hidden', 'true');

            option.append(icon, copy, end);
            option.addEventListener('mouseenter', () => {
                selectedIndex = index;
                Array.from(results.children).forEach((item, i) => {
                    item.setAttribute('aria-selected', String(i === index));
                });
                input.setAttribute('aria-activedescendant', option.id);
            });
            option.addEventListener('click', () => goTo(page));
            results.appendChild(option);
        });
        input.setAttribute('aria-activedescendant', results.firstElementChild.id);
    }

    function openPalette() {
        if (!isSignedIn() || !dialog || dialog.open) return;
        if (typeof closeMobileSidebar === 'function' && document.body.classList.contains('sb-sidenav-toggled')
            && window.matchMedia('(max-width: 768px)').matches) {
            closeMobileSidebar({ restoreFocus: false });
        }
        priorFocus = document.activeElement;
        // The mobile drawer becomes hidden when opening the palette.
        // Never restore focus to its now-invisible links.
        if (priorFocus?.closest?.('#sidebar-wrapper')) priorFocus = trigger;
        navigating = false;
        input.value = '';
        render('');
        dialog.showModal();
        input.focus();
    }

    function init() {
        dialog = document.getElementById('command-palette');
        input = document.getElementById('command-search');
        results = document.getElementById('command-results');
        live = document.getElementById('command-live');
        trigger = document.getElementById('command-palette-trigger');
        if (!dialog || !input || !results || !live || !trigger) return;

        trigger.addEventListener('click', openPalette);
        dialog.querySelector('[data-command-close]').addEventListener('click', () => dialog.close());
        dialog.addEventListener('click', event => {
            if (event.target === dialog) dialog.close();
        });
        dialog.addEventListener('close', () => {
            input.value = '';
            results.replaceChildren();
            input.removeAttribute('aria-activedescendant');
            if (navigating) {
                trigger.focus();
            } else if (priorFocus && priorFocus.isConnected) {
                priorFocus.focus();
            } else {
                trigger.focus();
            }
            priorFocus = null;
            navigating = false;
        });
        input.addEventListener('input', () => render(input.value));
        dialog.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' && pages.length) {
                event.preventDefault();
                selectResult(selectedIndex + 1);
                input.focus();
            } else if (event.key === 'ArrowUp' && pages.length) {
                event.preventDefault();
                selectResult(selectedIndex - 1);
                input.focus();
            } else if (event.key === 'Enter' && document.activeElement === input && pages.length) {
                event.preventDefault();
                goTo(pages[selectedIndex]);
            }
            // Escape and Tab are handled by the native modal dialog.
        });
        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey
                && event.key.toLowerCase() === 'k' && isSignedIn()) {
                event.preventDefault();
                if (dialog.open) {
                    input.focus();
                    input.select();
                } else {
                    openPalette();
                }
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
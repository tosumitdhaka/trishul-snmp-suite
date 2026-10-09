import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../js/modules/command-palette.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window }, { filename: 'command-palette.js' });
const findPages = window.TrishulCommandPalette.findPages;
const ids = query => Array.from(findPages(query), page => page.id);

test('provides all seven workspaces in navigation order', () => {
    assert.deepEqual(ids(''), ['dashboard', 'simulator', 'walker', 'traps', 'browser', 'mibs', 'settings']);
});

test('matches titles, synonyms and multi-word queries', () => {
    assert.equal(ids('trap')[0], 'traps');
    assert.equal(ids('notifications')[0], 'traps');
    assert.equal(ids('MIB SOURCES')[0], 'mibs');
    assert.ok(ids('oid').includes('browser'));
    assert.deepEqual(ids('nonexistent-workspace'), []);
});

test('ranks title matches ahead of keyword-only matches', () => {
    assert.equal(ids('settings')[0], 'settings');
    assert.deepEqual(ids('mib').slice(0, 2), ['browser', 'mibs']);
});

test('provides a keyboard-accessible dialog and native dashboard links', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const html = readFileSync(root + 'index.html', 'utf8');
    const dashboard = readFileSync(root + 'dashboard.html', 'utf8');
    assert.match(html, /<dialog id="command-palette"/);
    assert.match(html, /aria-controls="command-results"/);
    assert.match(html, /js\/modules\/command-palette\.js/);
    assert.equal((dashboard.match(/<a href="#(?:simulator|walker|traps|browser|mibs|settings)" class="card tool-card/g) || []).length, 6);
    assert.doesNotMatch(dashboard, /role="button" tabindex="0"/);
});

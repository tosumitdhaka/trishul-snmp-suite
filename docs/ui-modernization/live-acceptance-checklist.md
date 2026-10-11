# Modern UI — local live acceptance checklist

**Review target:** draft [PR #43](https://github.com/tosumitdhaka/trishul-snmp-suite/pull/43), stacked on PR #42.  
**Purpose:** final manual gate for the React preview before any migration decision. The legacy frontend at `/` and the modern Vite preview at `/next/` are **not** swapped or deployed by this branch.

## 0. Run on disposable local backend data

From repo root, on the hardening branch:

```bash
git fetch origin
git switch feat/modern-ui-gui-hardening
git pull --ff-only
./install-trishul-snmp-suite.sh up-local
curl -fsS http://127.0.0.1:8980/api/health
```

In another terminal (Node 22.12+):

```bash
cd frontend-next
npm ci
npm run typecheck && npm run lint && npm test && npm run build
npm run dev
```

Open legacy `http://127.0.0.1:8980/` and React preview `http://127.0.0.1:5173/next/`. Use **the same disposable FastAPI instance and MIB set**. Both UIs can mutate state; do **not** run state-changing comparisons against production. Each browser tab may need its own login. Do not paste credentials, community strings or token-bearing WebSocket URLs into screenshots or bug reports.

## 1. Fast visual pass (both UIs, same data)

For every one of the seven workspaces: capture empty, populated and error/empty states when practical; inspect at widths **390, 768, 1024 and 1440 px** in **light and dark**, with desktop sidebar expanded and collapsed. Confirm panel titles, labels, controls, empty states, focus, overlays and notification toasts do not overlap or disappear. Use the browser at **200% real zoom** and navigate using **keyboard only** (Tab, Shift+Tab, Enter/Space, Escape). For at least one workflow, use a screen reader if available. Verify the responsive layout, not just page-level horizontal overflow.

**Manager-specific:** at narrow widths, rows should show selectable labeled cards including source, group, status, counts and accessible compact sorting. At wide widths, expect all sortable table columns and separate export/bundle panels; no broken status labels. Open Add/upload (both methods), Reload/dependencies and confirmation dialogs at small widths.

**Traps-specific:** at phone width the received-event history should show fully labeled mobile cards. Expand an event with keyboard; ensure event details, varbinds and action buttons are visible, and pagination/export scope remain readable.

## 2. Operational parity scenarios

Record **Pass / Fail / Blocked** for each; compare actual requests/results and user-visible outcomes, not identical pixel layouts.

| ID | Workspace and procedure | Acceptance |
| --- | --- | --- |
| LV-01 | Dashboard: refresh, start and stop local Simulator/receiver from their pages, then revisit Dashboard in both UIs. | All eight stats, service states, bundle and realtime state reflect backend; offline WS is separate from backend health. |
| LV-02 | Simulator: configure a disposable port/community, start, perform GET/WALK, restart and stop; edit the config while status polling occurs. | Port/community draft is not overwritten; log stream, pause/search/export/clear and failure outcomes are truthful. |
| LV-03 | Walker: execute numeric and symbolic OID walks, raw and parsed modes; group/sort/filter a large result (2,400+ rows plus a late-added column), export TSV/JSON, cancel one long walk. | No silent truncation or lost late columns. Client cancel does not falsely claim backend cancel. Community and prior raw results do not persist across reload/logout. |
| LV-04 | Traps: start receiver, send TRAP and acknowledged INFORM to controlled loopback target; test success, timeout/negative ACK, receiver resolve-MIB, searchable history, decode, replay/delete and CSV. | Correct Inform outcome; valid varbinds; complete details with masked community; CSV explicitly exports the current filtered **server page**, not all history. |
| LV-05 | MIB Browser: browse by module and numeric OID, expand deep children, search by name/OID, filter object type, inspect resolved detail, export, and navigate from Manager/Walker. | Same relevant nodes and metadata as legacy, no stale bundle artifacts after a compile/activate, keyboard expansion available. |
| LV-06 | MIB Manager: upload a small .mib/.txt/.my sample via native selector **and drag/drop**, validate, intentionally test a missing dependency, partial compile and reload; inspect failed-source details. | Correct validation outcome, no false success; missing dependency and compile errors shown, bundle history stays consistent. |
| LV-07 | MIB Manager: select active modules and uploaded sources; search All/Module/Imports/Path; filter group/status, sort every module column, switch to Notifications and sort name/OID/module/objects. | All matches/selection counts correspond to actual data, including large lists and long paths; only uploaded managed paths are deletable/downloadable. |
| LV-08 | MIB Manager: export JSON and CSV for catalog/summary/modules/objects/notifications, with and without source-group scope and selection. Diff two bundles, activate candidate, then rollback. | Download content, filename and scope match legacy API contract; confirmed state transition/rollback; appropriate confirmation for destructive action. |
| LV-09 | Settings: change harmless test preferences, save/discard, export/reset test stats, rotate a **throwaway test account** password, check logout/relogin/expired session and browser reload. | No draft loss before save; correct server-backed settings; stale sessions invalidated; previous user's sensitive data not visible. |
| LV-10 | Error/edge pass: backend temporarily offline, invalid port, invalid MIB, long response, empty histories, double-click pending mutation. | Error messages are accessible, readable and neither claim success nor duplicate writes. |

## 3. Release-gate worksheet

- [ ] All automated frontend checks green at **current PR head** (not only an earlier commit).
- [ ] Modern synthetic screenshot suite and legacy baseline both green; manifests show 0 browser errors.
- [ ] Actual legacy/modern live data and workflow parity reviewed (LV-01…LV-10).
- [ ] Manager mobile desktop layouts visually approved, including validation and long failed-source details.
- [ ] No clipping at 200% zoom; keyboard, focus order, Escape, modal focus and one screen reader pass.
- [ ] Long MIB names, 75+ source rows, 2,400+ Walker rows and many received traps tested.
- [ ] Walk privacy and cross-account session isolation verified.
- [ ] `npm audit` advisories reviewed with severity, affected package and remediation before any release sign-off.
- [ ] User approves migration/cutover **separately**; this draft PR does not authorize production mounts, Docker changes or merging to main.

Keep `feat/modern-ui-gui-hardening` **draft** if any gating item fails or is untested. For feedback, record ID, browser, viewport, theme, backend fixture (redact secrets), expected vs actual, and a cropped screenshot.

Stop React with Ctrl+C, then from repo root use `./install-trishul-snmp-suite.sh down` to stop disposable local services.

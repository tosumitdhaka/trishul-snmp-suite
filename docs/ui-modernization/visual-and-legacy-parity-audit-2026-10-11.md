# Modern UI visual and legacy feature-parity audit — 2026-10-11

**Review target:** `feat/modern-ui-gui-hardening` (draft PR #43); legacy source in `frontend/` on the same branch.  
**Release boundary:** review only; the backend, legacy frontend and production route remain unchanged.  
**Evidence:** [CI run 38129002135](https://github.com/tosumitdhaka/trishul-snmp-suite/actions/runs/38129002135), [84 Chromium fixture screenshots](https://github.com/tosumitdhaka/trishul-snmp-suite/actions/runs/38129002135/artifacts/11698201182), `frontend-next/e2e/screenshot-smoke.mjs`, and source comparison with `frontend/*.html` + `frontend/js/modules/*.js`.

## Scope and limits

Reviewed all **84 default-state modern screenshots**: seven pages × two themes × 390, 768, 1024 and 1440 CSS px, plus collapsed/expanded desktop-sidebar captures for widths >= 1024. Chromium 141.0.7390.37; fixture responses only. The screenshot manifest shows zero page exceptions and zero **document-level** horizontal overflow cases. This does **not** establish layout quality: inner scrolling containers, truncated labels and overly narrow table cells can pass that test. No legacy UI browser capture against the *same* fixture, opened dialogs, populated large-data state, 200% zoom, screen-reader pass, real SNMP operations or cross-browser comparison has been completed. The parity statements below are **source-level**, not runtime sign-off.

## Visual findings (ordered by remediation priority)

| ID | Severity | Workspace / evidence | Observed issue | Proposed acceptance |
| --- | --- | --- | --- | --- |
| UI-01 | **P1** | Manager, light/dark 390 | Six-column inventory is squeezed into a ~300px internal viewport, splitting module/source text and hiding later columns; no visible affordance signals scrollable hidden data. | Use mobile source-summary cards with exposed status, source group and action details, or a tested accessible horizontal-table pattern with a scroll cue; retain sortable full table at wide widths. Test long MIB names, errors and 75+ rows. |
| UI-02 | **P1** | Manager, 768/1024 expanded desktop sidebar | Filter row breaks unevenly (search + group on one line, Status orphaned), with abundant gaps; actions and title share a cramped panel header. `xl:` responds to viewport rather than available catalog-panel width. | Size all filters to the **panel container**, align labels and controls at consistent baseline, and place management actions on a separate predictable action row when narrow. |
| UI-03 | **P2** | Manager, 390 | Add/upload and Reload/dependencies actions split across successive right-aligned rows; inventory mode and refresh separate again, delaying actual data. | Stable main actions row or stacked equal-width buttons at narrow width, stable inventory tabs with adjacent refresh. |
| UI-04 | **P2** | Browser, 390/768/1024 | Default no-selection view reserves a very tall empty tree pane and separate very tall empty inspector, obscuring useful navigation. | Compact empty-state minimum heights on phones; expand only when data is present, with no jump when selecting a node. |
| UI-05 | **P2** | Shared shell, 768/1024 expanded sidebar | Route titles/descriptions and “Jump to…” are clipped/wrapped while the full connectivity indicator and multiple icon actions consume header width. | Container/available-width responsive header priorities: retain title in readable single- or two-line form, provide accessible icon-only search when narrow, collapse secondary description, prevent overlapping. |
| UI-06 | **P2** | Simulator, 390/1024 | Runtime action buttons and log toolbar wrap onto several irregular lines; standalone icon-only destructive action is visually disconnected from log filters. | Primary action first; separate navigation/actions; consistent trailing tools and discoverable labels/tooltips. |
| UI-07 | **P2** | Traps, 390/1024 | Long stacked sender/receiver/history workflow; history toolbar wraps destructive action to another line and table columns require internal scrolling. | Use a predictable toolbar and table/card strategy, explicitly visible current-page CSV scope, test long notifications and varbind payloads. |
| UI-08 | **P3** | Walker, 390 | Six input fields, options and execution controls form a very long single-column setup before results; no evidence of content collision. | Align compatible fields responsively, preserve proper labels, prioritize Execute and results. Test actual long grouped output. |
| UI-09 | **P3** | Dashboard, 390 | All service cards and six launcher cards create long vertical navigation; content legible. | Reduce repetition and prioritize service health / activity above shortcuts. |
| UI-10 | **P3** | Settings, 390/1024 | Core cards are legible and controls not visibly clipped in the default fixtures; small helper text remains to inspect at 200% zoom. | Recheck focused/invalid forms and security dialogs in both themes, not only default state. |

**Important:** UI-01 is a usability failure despite **zero document overflow** in the fixture manifest. Manager modal/validation/large inventory was not screenshotted by the current fixture.

## Source-level parity against shipped legacy frontend

Baseline: `docs/ui-modernization/legacy-feature-inventory.md` and live source paths listed below. **Implemented/present** means comparable controls and API wiring are evident in source, not that device/network behavior matches.

| Workspace | Parity finding | Evidence / mismatch requiring decision |
| --- | --- | --- |
| Dashboard | **Core controls present (not runtime verified).** | New view shows service health, all eight activity metrics and six workspace links, comparable to `frontend/dashboard.html` and `frontend/js/modules/dashboard.js`. |
| Simulator | **Core controls present; live fidelity not verified.** | Start/stop/restart, port/community, JSON overrides and log search/filter/pause/export visible; compare realtime log accumulation and failed backend outcomes on live stack. |
| Walk & Parse | **Intentional behavior difference; not exact parity.** | Legacy `frontend/js/modules/walker.js` stores up to 20 walk records including results in localStorage and permits restoring them. New Walker keeps only memory-only recent configurations and does not restore old values. This is a privacy-hardening decision, not an accidental omission; define any safe persisted-history alternative before claiming exact parity. |
| Traps | **Core controls present; detailed data fidelity not verified.** | Both provide trap/inform send, receiver, offline decode, pagination, replay/delete and CSV. Legacy `exportTrapsCsv` exports the active filtered page; new “Export current page” intentionally makes that scope explicit. Check richer varbind constraint UI and long record detail parity. |
| MIB Browser | **Core explorer present; specialized behavior pending.** | Module/OID mode, lazy tree, query/filter, inspector and cross-workspace links exist. Deep search, selected/expanded state and legacy ETag caching/recompile hints require live cross-check. |
| **MIB Manager** | **Confirmed UI capability gaps; parity NOT achieved.** | Legacy `frontend/mibs.html` offers five export content types (`catalog`, `summary`, `modules`, `objects`, `notifications`); React `MibsPage.tsx` export selector only exposes `catalog` and `notifications`. Legacy inventory search offers explicit `All/Module/Imports/Path` scope; React has free-text, source-group and status filters but no corresponding scope selector. Legacy trap catalog has sortable Name/OID/Module/Objects columns and a dedicated panel; React Notifications tab shows name/OID/actions and sorts by notification name only. Legacy has panel drag-and-drop upload; React uses a file-picker modal. Bundle activate/diff, batch uploads, validates, deletion and source downloads are wired in modern code but not live-verified. |
| Settings | **Core controls present (not runtime verified).** | Credentials, app preferences, export/reset statistics and About are present; credential/session rotation and persisted settings need real backend sessions and error-state testing. |

### Decisions before calling parity complete

1. **Manager export types:** restore `summary`, `modules`, `objects` selections with backend-contract tests, or document a deliberate deprecation with user acceptance.
2. **Manager filtering:** restore scope-aware module/import/path search and trap catalog metadata/sorting, or explicitly replace them with equivalent discoverable functionality. Do not equate source-group/status filters with import/path filtering.
3. **Manager upload:** decide whether drag/drop parity is expected; retain accessible input fallback and batch validation/error/partial compile details.
4. **Walker history:** preserve privacy fix; explicitly accept reduced persisted functionality or design a privacy-safe opt-in restore mechanism. Do not copy the old raw-result localStorage behavior.
5. Verify live SNMP start/stop/walk/send/receive/inform/replay, MIB validation/upload/fetch/diff/rollback/export and settings/session security against **both** frontends on the same disposable backend.

## Recommended next test upgrade

Extend `frontend-next/e2e/screenshot-smoke.mjs` beyond initial load to capture: Manager **both tabs**, 75+ inventory entries including long paths, 3+ bundles, failed/dependency rows, upload/maintenance modals, selected and invalid states; Browser selected deep tree and details; Walker real-size grouped output; Traps populated long history and varbind editor; Simulator running and long logs; Settings errors/dialogs. Add element-level assertions for clipped text, inner scroll cues, overlapping controls, and keyboard tab order. Capture legacy and React pages with identical backend data before any release-gate parity decision.

**Status:** visual audit complete for the captured modern default states; **full legacy parity unverified and the Manager differences above are confirmed from source.** This is a review deliverable only, not production sign-off.

# Modern UI — Manager-first responsive and source-parity pass

**Date:** 2026-10-11  
**Branch:** `feat/modern-ui-gui-hardening` · draft PR #43, based on the PR #42 review branch.  
**Boundary:** React preview, tests, preview-only CI and documentation. The legacy `frontend/`, FastAPI/backend contracts, Docker and production mount remain untouched.

This is the implementation follow-up to [visual and legacy feature audit](visual-and-legacy-parity-audit-2026-10-11.md). The source-level gaps and fixture screenshot findings below are not equivalent to **live** SNMP/backend/assistive-tech sign-off.

## Visual remediation

| Audit item | Implementation | Required final check |
|---|---|---|
| UI-01 Manager narrow inventory | One semantic table, mobile/panel-width card reflow using existing cell data; labels for every column, accessible scroll region and compact sorting. No duplicate data state or selection model. | 75+ rows, long MIB paths, status badges, 200% zoom and screen reader |
| UI-02 uneven Manager filters | Search, source group, explicit search scope and status placed in a grid responsive to **catalog panel width**; reliable field labels. | Widths 390/768/1024/1440, expanded/collapsed sidebar |
| UI-03 wrapped Manager actions | Primary source actions moved out of dense card header, one predictable inventory tabs row, compact visual tab labels at narrow widths and stable Refresh. | Touch and keyboard in both modes |
| UI-04 empty Browser panels | Phone viewport tree min-height reduced; distinct inspector empty class. | Tree selection, deep nesting and zoom |
| UI-06 Simulator toolbar | Responsive search-first log toolbar on phones. | Long running logs, filters/pause and keyboard |
| UI-07 Traps history toolbar | Responsive search-first controls on phones; existing current-page CSV scope remains explicit. | Paginated rows, narrow devices and long event detail |

Other visual findings remain **partial or deferred**, including responsive global shell density, full validation/dialog state review and 200% zoom.

## Legacy Manager capability restoration

| Baseline `frontend/mibs.html` capability | React preview implementation | Coverage |
|---|---|---|
| Catalog export content `catalog`, `summary`, `modules`, `objects`, `notifications` | All five choices restored, same existing `POST /api/mibs/export` contract. Independent export-source-group selector avoids inadvertent coupling to inventory filter. | React component request test and backend `mibs_service.export_catalog_file` source contract |
| Search scope `All`, `Module`, `Imports`, `Path` | Scope-aware `filterSortCatalog` against module names, imports/missing dependencies, path fields and broad search. | Model and component tests |
| Notification catalog name/OID/module/objects sorting/columns | Restored module/object count columns and sortable field headers. Compact-card sort control retains sorting access at narrow widths. | Model and component tests |
| Drag-and-drop source files | Drop target added inside Add/upload modal; `.mib`, `.txt`, `.my` accepted; accessible native file input remains. | Component drag/drop test; native browser drag still needs manual check |

The upload interaction remains in a modal instead of an always-active legacy panel; this is a **placement change**, not a removed capability. MIB validation, partial compile, export file contents and backend error variants still need live parity checks.

## Screenshot/verification infrastructure

- Modern Playwright Chromium captures seven pages in light/dark at 390/768/1024/1440 px and desktop sidebar states, **plus** Manager notification catalog, add, upload and maintenance dialogs at 390, 1024 and 1440 in both themes. The shared synthetic fixture now includes failed and missing-dependency sources, long paths, three notification definitions and three bundles.
- `frontend-next/e2e/fixture-data.mjs` contains the shared synthetic REST responses; the optional `legacy-parity-smoke.mjs` captures all seven legacy pages with that same fixture. The legacy baseline is best-effort because it relies on external Bootstrap/Font Awesome CDNs. Visual equivalence is not claimed solely from screenshots.
- GitHub Actions commands from `frontend-next/`: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; CI browser job records screenshot and error manifests. Consult the **latest** workflow run before asserting green status.
- A synthetic-browser screenshot is **not** evidence of SNMP UDP traffic, backend mutation semantics, real MIB uploads, actual CSV content, screen-reader accessibility or real session rotation.

## Final pre-live responsiveness follow-up

- Trap received-event history now reflows into **labeled, expandable mobile cards** at phone widths, preserving keyboard-operable details, source, time, notification and pagination. Component tests assert labeled data and expansion. The browser fixture captures expanded event details in light/dark at 390/1024 px.
- Manager export choices and panel filter geometry now have browser assertions; the screenshot job **fails** on browser exceptions, document horizontal overflow, colliding filter controls or missing legacy export choices. The legacy baseline requires exactly 56 captured pages without browser exceptions (it is no longer an optional CI step).
- Source status labels display `Missing deps` rather than splitting `missing_deps` across narrow cells. Confirm, Settings and Trap catalog dialogs are constrained by viewport height.
- Modern coverage is **112 screenshots** (84 responsive defaults, 24 Manager detail/dialog states, 4 expanded Traps), paired with **56 legacy synthetic captures**. The source-level comparison is still **not** network/device parity. See [live acceptance checklist](live-acceptance-checklist.md) for the ten local operation scenarios.

## Remaining acceptance gates

1. Capture and inspect **paired legacy and modern screenshots** on a disposable **real FastAPI stack**, same installed MIB corpus and account, light/dark with representative empty, loaded, failed and large states.
2. Run the same workflows in both UIs: simulator start/restart and SNMP walk, Trap/Inform send/receive/replay/decode, MIB file validate/upload/partial-compile/reload, remote dependency fetch, source delete, catalog downloads, bundle diff/activate/rollback, Settings auth/save/export/reset.
3. Check Manager 75+ selected sources, search scope, sorting/pagination, actual downloaded export formats and filenames, and long compiler-failure detail.
4. Keyboard-only, touch/coarse pointer, 200% zoom, at least one screen reader, large-data performance, cross-browser screenshots, and session privacy boundary.
5. Maintain the deliberate privacy protection: React Walker does **not** restore legacy persisted raw-result history; exact persistence parity is not appropriate without an explicitly privacy-safe design.

**Release status:** preview only, draft PR; full parity and production readiness NOT certified.

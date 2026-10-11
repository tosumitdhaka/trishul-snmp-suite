# Modern GUI Fixer — remediation and validation ledger

**Date:** 2026-10-11 · **Scope:** draft modern preview `frontend-next/` and `docs/ui-modernization/` only.  
**Baseline:** `feat/modern-ui-catalog-and-action-consistency` at `7f19f4dda6c22a7230c00225ab47f509e225b14f` (PR #42).  
**Implementation:** `feat/modern-ui-gui-hardening` (draft PR #43).  
**Release boundary:** No changes to `main`, `frontend/`, backend, Docker, production route, or SNMP semantics. No release or deployment.

## Evidence language
- **Fixed:** targeted source correction committed; automation/browser validation remains a separate gate unless explicitly recorded below.
- **Verified not reproducible:** reproduced targeted test conditions and found no defect (none claimed here).
- **Deferred:** proposed refinement or verification intentionally left for another change.
- **Blocked:** a required browser/device/real-backend exercise not supported in this execution environment.
- **Source-verified baseline:** F01–F10 are taken from the attached remediation brief's code inspection; V/W are *design recommendations*, X are *hypotheses*, not runtime-confirmed failures.

## Functional and trust findings

| ID | Priority | Status | Remediation / available evidence | Remaining gate |
|---|---|---|---|---|
| F01 | P1 | **Fixed** | Former `trishul_next_walk_history` localStorage key removed at app startup, auth teardown and Walker mount; memory-only recent configurations omit result bodies and communities; token transition drops result/history. `walk-table.test.ts`. | Browser probe for secret sentinel after walk, reload, logout, alternate account and disabled storage. |
| F02 | P1 | **Fixed** | `walk-table.ts` collects **all** server-returned rows/fields; on-screen grouped preview uses 100-row pages; TSV is explicitly **all filtered rows**, full discovered schema. Test constructs 2,401 rows, late column after #100. | Large real-response performance/export check, TSV spreadsheet handling, non-tabular payloads. |
| F03 | P1 | **Fixed** | Simulator port/community touched flags preserve drafts through any polled/refreshed status; reset to server and unsaved cue added. `draft-sync.test.ts`. | Browser poll/reconnect/start/restart/live status check. |
| F04 | P1 | **Fixed** | Traps port/community drafts preserved across polls; resolve-MIB checkbox guarded by pending/optimistic override until matching server status; resets and rollback. `draft-sync.test.ts`. | Concurrent stale-poll/mutation race and error rollback with live backend. |
| F05 | P1/P2 | **Fixed** | HTTP completion decoupled from domain response for Inform nonzero status, MIB `failed`/compile outcomes and simulator warnings; one shared outcome notification. Synchronous ref guard prevents rapid repeat submit. `operator-outcome.test.ts`. | Validate all endpoint payload variants (including mixed MIB outcomes) against backend. |
| F06 | P2 | **Fixed** | WebSocket simulator log `entry` now updates bounded 200-entry query cache; duplicates removed; paused display freezes a snapshot; polling retained. `simulator-logs.test.ts`. | WS reconnect, polling race, pause/clear and scroll-position browser exercise. |
| F07 | P2 | **Fixed** | Received-trap button and CSV filename explicitly say **current page**, show filtered count and local search scope; formula-leading spreadsheet strings escaped. | Export >50 real stored traps and verify column correctness. No all-history export promised. |
| F08 | P2 | **Fixed** (semantics) | Invalid ARIA tree pattern replaced by native nested lists plus keyboard-focusable selection/expand buttons; region retains readable label. | Deep lazy tree, search, both modes, keyboard-only and screen reader browser verification. |
| F09 | P2 | **Fixed** | Client AbortController cancellation reports neutral **info** (backend may keep working), not success. | Manual cancel/restart of long device walk. |
| F10 | P2 | **Fixed** | Error toast 12 s, warning 8 s, info 5 s, success 2.7 s; long messages expandable in toast and remain in notification drawer. Duration regression test. | Keyboard/touch, long server error, screen reader announcements. |

## Visual recommendations — not baseline screenshot-confirmed

| ID | Status | What changed / what remains |
|---|---|---|
| V01 | **Deferred** | Route heading hierarchy not yet visually reviewed in browser. |
| V02 | **Deferred** | Comprehensive typographic and 200%-zoom audit needed; some core tables still use `text-xs`. |
| V03 | **Deferred** | Distinct task panel patterns need browser comparison across seven workspaces. |
| V04 | **Fixed** | Removed decorative success/warning cycling from Dashboard navigation and activity cells. |
| V05 | **Fixed** | Role-specific `--on-danger-hover` tokens for light/dark; pure CSS contrast regression test. Browser hover/focus still required. |
| V06 | **Blocked** | Full light/dark dialog, tooltip, table, popover and theme-flash screenshot audit not performed. |
| V07 | **Fixed** | Manager 2:1 split now requires sufficient workspace container width rather than viewport alone. Validate real widths. |
| V08 | **Fixed** (partial) | Coarse-pointer targets for tree toggle and notifications increased to 44px equivalent; full touch target audit pending. |
| V09 | **Deferred** | Unified motion tokens/transitions to be evaluated alongside actual animation screenshots; reduced motion still needs test. |
| V10 | **Fixed** (partial) | Simulator paused snapshot retained through background WS changes. Trap existing pause/selection behavior still needs manual check. |
| V11 | **Deferred** | Full copy/selection audit for long OIDs and diagnostic values at phone width pending. |
| V12 | **Deferred** | Wider component-token consolidation left out of trust/behavior changes. |

## Workspace recommendations

| ID | Workspace | Status | Notes |
|---|---|---|---|
| W01 | Dashboard | **Fixed** (partial) | Removed decorative status-hue cycling. Full above-fold hierarchy pending. |
| W02 | Simulator | **Fixed** (partial) | Editable draft state, live logs, pause; additional visual review pending. |
| W03 | Walk & Parse | **Fixed** (partial) | Truthful full TSV vs 100-row visible page, memory-only configurations; layout review pending. |
| W04 | Traps | **Fixed** (partial) | Drafts, Inform outcomes, CSV labeling; receiver/sender layout polish pending. |
| W05 | MIB Browser | **Fixed** (partial) | Native list semantics; sizing and inspector proportion pending. |
| W06 | MIB Manager | **Fixed** (partial) | Width-aware combined catalog layout; selection/filter/live audit pending. |
| W07 | Settings | **Deferred** | Existing features retained; security grouping and restart cues need visual review. |

## Architecture / quality / release gates

| ID | Status | Evidence / reason |
|---|---|---|
| Q01 | **Deferred** | Incremental pure helpers extracted; large page decomposition only where directly relevant. |
| Q02 | **Deferred** | Full generated OpenAPI types and contract drift CI need dedicated backend-schema verification. |
| Q03 | **Fixed** (synthetic browser evidence only) | Chromium/Playwright screenshot workflow captures 108 modern states (84 seven-route/theme/width/sidebar plus 24 Manager interaction states) and 56 matched legacy default-state captures. CI artifact confirms 164 PNG files and two manifests; keyboard-only, screen reader, 200% zoom and live backend parity remain unverified. |
| Q04 | **Fixed** (boundary preserved) | No preview route or production wiring modifications; verify branch diff and legacy route separately. |
| Q05 | **Blocked** | Real disposable backend, SNMP device, UDP trap/inform and MIB live fixture parity not exercised. |

## Unconfirmed hypotheses (not reported as proven bugs)

| ID | Status | Next experiment |
|---|---|---|
| X01 | **Deferred** | Browser-specific `Blob` download/revoke timing for large files on Chrome, Firefox, Safari. |
| X02 | **Deferred** | Verify MIB source-group vs module export filter values with contract tests. |
| X03 | **Fixed** (defensive) | Synchronous ref mutation lock added, even though rapid-click race was not reproduced. |
| X04 | **Fixed** (defensive) | Formula-leading cells escaped in new Walker TSV and Trap CSV; verify MIB Browser CSV separately. |
| X05 | **Deferred** | Managed source permissions, 75+ selections, shadow/status inventory parity. |
| X06 | **Deferred** | Browser 100-result cap, tree scope, dependencies and CSV labeling audit. |

## Automated verification

From `frontend-next/`:
```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```
A scoped read-only GitHub Actions workflow, `.github/workflows/modern-ui-preview-checks.yml`, was committed to execute these commands. **Do not mark these commands passed until a completed workflow run proves it.** Focused test sources: `walk-table.test.ts`, `draft-sync.test.ts`, `operator-outcome.test.ts`, `simulator-logs.test.ts`, `ToastViewport.test.ts`, `styles.contrast.test.ts`.

## Manual/browser validation — outstanding (not tested)

Record **browser and version**, signed operator/date, backend/SNMP fixture, screen dimensions, expected/observed result, issue links and screenshot artifacts. Never treat unit/component fixtures as live interop.

- [ ] Test light and dark workspaces at **390, 768, 1024 and 1440 px**, including expanded/collapsed desktop sidebar; capture before/after pairs for all seven.
- [ ] Repeat critical flows at **200% zoom**, keyboard only, reduced motion and at least one screen reader (tree search/nesting, dialogs, notifications, destructive confirmation).
- [ ] Confirm former raw Walker sentinel no longer appears anywhere in localStorage after walk/reload/logout; one operator cannot see another's results.
- [ ] Export 2,401+ walk rows with late-appearing columns and verify row/field counts match intended filter; cancel a delayed walk.
- [ ] Keep simulator and receiver draft edits across two or more polls and a WS reconnect; reset to server; test mutation success/error and concurrent resolve-MIB toggle.
- [ ] Send acknowledged SNMP Inform returning an error status and partial MIB fetch; ensure **one accurate** outcome notification each.
- [ ] Stream simulator logs through WS, disconnect/reconnect and poll, pause while observing older events, clear server logs; no duplicate/jump.
- [ ] Store over 50 traps; ensure CSV exports only visibly declared current page/filter scope; replay/delete with confirmation.
- [ ] Exercise live simulator start/stop, walks, trap send/receive/decode, MIB upload/fetch/compile/activate/rollback, settings authentication/rotation.
- [ ] Contrast check of normal/hover/focus/disabled buttons, drawers and overlays in both themes.

**Synthetic screenshots supplied:** [164-image legacy + React artifact](https://github.com/tosumitdhaka/trishul-snmp-suite/actions/runs/38138486869/artifacts/11702048157) (108 modern, 56 legacy; manifest records 0 Chromium exceptions and 0 document-level overflow cases for modern). Both related workflow jobs passed on 2026-10-11. This does **not** prove zero intra-panel clipping or live workflow parity.  
**Live backend/SNMP checks performed:** none — real backend/device fixture not available here.  
**Production readiness:** NOT CLAIMED. Draft preview only.

## Manager-first second-pass follow-up (2026-10-11)

The [detailed implementation ledger](manager-responsive-parity-pass.md) fixes visual issues UI-01/02/03 and part of UI-04/06/07 with testable panel-width layouts. Legacy MIB Manager source parity improved for export content options, search scopes, notification columns/sorting, and file drop. Shared synthetic legacy/modern screenshot fixture and optional legacy capture are now CI exercised. **Full parity still depends on a disposable real-backend comparison, large fixture data, 200% zoom and assistive technology; no production readiness asserted.**

# Modern UI Refinement Review — 19 operator findings

**Preview branch:** `feat/modern-ui-review-refinements-19`, based on draft PR #38.  
**Status:** implementation for combined UI review, **not** backend/visual parity certification. No production or legacy change.

| # | Page | Implementation / acceptance |
| --- | --- | --- |
| 1 | Simulator & Traps | Pause auto refresh is a labeled checkbox. Simulator stops polling its logs; Traps freezes displayed history on pause. |
| 2 | Shared actions | Icon-only Refresh/Download/Clear buttons where unambiguous, with keyboard focus, tooltip, and accessible label; format buttons retain JSON/TSV/CSV identifiers. |
| 3 | Destructive actions | Shared red danger style for clear/delete/reset actions, existing confirmations preserved for backend destructive mutations. |
| 4 | Simulator | Beautify JSON performs local parse/indentation only, reports invalid JSON, marks formatted changes unsaved; Save still controls POST. |
| 5 | Walker | Raw view is initial and post-walk default. JSON layout offers backend-supported `grouped` with category/labels; grouped table presents metric category/module headings while preserving raw/parsed tabs. Grouping only shown for metadata actually returned by backend. |
| 6 | Browser | NotificationType nodes have only Use in Traps; other nodes have Use in Walker. |
| 7 | Traps | Explicit toggle label/help explains MIB resolution: switch applies via POST immediately, no receiver restart; history and status invalidated; errors restore prior value. |
| 8 | Traps | Type a notification name/OID to see a bounded catalog match list, choose to prefill definition. |
| 9 | Traps | Show resolved symbolic names as primary fields for received varbinds; numeric OIDs remain available underneath and unknown ones remain numeric. |
| 10 | Dashboard | Subtle state-dependent border/icon fills and activity/launcher accents in light/dark, avoiding bright arbitrary tiles. |
| 11 | Traps | Browse notification catalog opens an in-page accessible dialog, not MIB Browser; search/filter list and choose a definition. |
| 12 | Traps | Event row can be clicked to expand/collapse inline; keyboard-accessible chevron expands too. Replay/delete actions and masking remain. |
| 13 | Browser | Table indexes shown in declared sequence, numerically marked; only when available. |
| 14 | Browser | Search icon/clear button share the same position inside the search field; only one appears. |
| 15 | Manager | Removed redundant top-level Browser/Sender shortcuts; reduced four status chips to a compact strip. |
| 16 | Manager | Inventory occupies full available width; Validate/Upload and Reload/Dependencies have independent responsive full-width cards, no narrow side overflow. |
| 17 | Manager | Better source/group/status filtering, sorting, status badges, source details, bulk selection and local pagination (75 rows/page). |
| 18 | Manager | Reorganized inventory-first layout, separate tool region, retained validation/upload/bundle/diff/export/reload/fetch/activation operations. |
| 19 | Settings | Current/new/confirm password inputs each have independent show/hide eye control inside field; default is masked, values never logged. |

## Manual acceptance gates

- [ ] Simulator: with server running and stopped, check pause checkbox stops polling, JSON format handles valid and invalid data without saving automatically, compact panels stay usable at 390/1024/1440px.
- [ ] Walker: raw text first; grouped MIB metric_category rows; flat and raw backend responses; parsed JSON; export; history load. Grouped JSON requires MIB resolution.
- [ ] Browser: NotificationType-only Trap action, scalar/table Walker action, table index order, focused clear/search icon, tree keyboard.
- [ ] Traps: notification typing before and after catalog loads; modal arrow/tab/Escape; choose adds varbinds; live MIB resolution changes and handles failed POST; expandable history keyboard; resolved values plus raw numeric metadata; confirmations.
- [ ] Dashboard and Manager: dark/light contrast, 200% zoom, narrow tools are not clipped, inventory pagination/selection/status and compilation error details, producer/bundle labels.
- [ ] Settings: eyes toggle independently, password unchanged, submit and logout behavior.
- [ ] API contract and real devices: SNMP walk send/receive and legacy parity remain open. CI mocked tests are not a live-system sign-off.

**Release safety:** Draft-only stacked branch, no merge or deployment, legacy UI remains default.

# Legacy UI Feature-Parity Inventory — Source Audit

**Status:** Source-level baseline, **not** final approval.  
**Reviewed:** 2026-10-09 · legacy sources on `main` / planning baseline.  
**Source of truth:** `frontend/*.html`, `frontend/js/modules/*.js`, `backend/app/api/routes/*`, `docs/workspaces.md`.  
**Parent documents:** [Migration plan](migration-plan.md) · [Architecture](architecture.md).

This inventory records **existing implemented controls and integration surfaces** so a React rewrite cannot silently lose less-visible behavior. It is based on static source inspection, **not** an end-to-end browser run. Exact parity requires browser tests with real MIB sets, UDP workflows, long tables, offline/expired-session cases and screenshots.

## Global shell and cross-cutting behavior

| Capability | Legacy source | New UI acceptance |
| --- | --- | --- |
| Seven routes; dashboard default | `frontend/index.html`, `frontend/js/app.js` | All routes addressable; direct navigation and return links work |
| Account login/validation/logout | `frontend/js/app.js` | Same server session, tab-scoped token, REST 401 and WS 4001 handling |
| HTTP auth | `frontend/js/app.js` | `X-Auth-Token` only on same-origin API calls; no credential logging |
| Live socket | `frontend/js/modules/ws-client.js` | `full_state`, `status`, `stats`, `mibs`, `trap`, `simulator_log`, ping/pong, exponential reconnect |
| Light/dark and mobile sidebar | `frontend/index.html`, `frontend/css/style.css` | Equal-mode contrast, mobile focus trap, scroll, reduced motion |
| Module teardown/navigation | `frontend/js/app.js` and module `destroy` methods | Dispose listeners/timers and cancel requests on route changes |
| Safe dialogs, toasts, errors | `frontend/js/modules/utils.js` | Accessible focus and destructive confirmations; honest error messages |
| Cross-workspace OID actions | Browser/Traps/Walker modules | Preserve symbolic/numeric OIDs; never copy secrets across workspaces |

## Dashboard — Stage 2 must reach full parity

| Legacy control/value | Actual data source | Acceptance |
| --- | --- | --- |
| MIBs loaded | `GET /api/mibs/status`, `full_state.mibs.loaded` | Live/rest counts agree; never show fabricated zero for failures |
| Trap types available | `/api/mibs/status` module `mibs[].traps` aggregated, or `full_state.mibs.traps_available` | Normalize the **two different payload shapes** |
| Simulator on/off | `GET /api/simulator/status` + WS `status.simulator` | Show Running, Stopped, or Unavailable distinctly |
| Trap receiver on/off | `GET /api/traps/status` + WS `status.traps` | Show Running, Stopped, or Unavailable distinctly |
| SNMP requests served | `GET /api/stats/` → `simulator.snmp_requests_served` | Show number or unavailable |
| OIDs loaded | `/api/stats/` → `simulator.oids_loaded` | Number or unavailable |
| Traps received / sent | `/api/stats/` → `traps.traps_received_total` / `traps_sent_total` | Numbers or unavailable |
| Walks executed / OIDs returned | `/api/stats/` → `walker.walks_executed` / `oids_returned` | Numbers or unavailable |
| MIB sources / reloads | `/api/stats/` → `mibs.upload_count` / `reload_count`; sources also in `source_groups[].file_count` | REST and live counts consistent |
| Six shortcuts | `#simulator`, `#walker`, `#traps`, `#browser`, `#mibs`, `#settings` | Six native links. Preserve legacy fallback while placeholders remain |
| Stats reset | Code exists but **button intentionally commented out** in `dashboard.html` | Do **not** expose reset on new dashboard until designed and reviewed |

Note: The initial Stage 1 modern dashboard is a read-only connectivity preview with only four activity counters. It is **not** parity-complete. A new Stage 2 slice should restore all eight activity counters, trap types, source count, six shortcuts and explicit degraded states.

## Simulator

| Group | Controls/behaviors to reproduce |
| --- | --- |
| Lifecycle | Status badge, uptime, request count, last activity, start/stop/restart with loading and error paths |
| Configuration | Port, masked community, disabled-while-running semantics, unsaved changes |
| Custom OIDs | Load/edit JSON, format, save, validation errors, invalid payload warnings, typed MIB values and constraints |
| Logs | Follow/pause, search, severity filters/chips, clear, export, local history, batching, live-versus-poll indicator |
| Realtime | Status, stats and simulator-log streams; fallback poll, listener cleanup |
| APIs | `/api/simulator/status`, `/start`, `/stop`, `/restart`, `/data`, `/logs`; `/api/ws` |

## Walk & Parse

| Group | Controls/behaviors to reproduce |
| --- | --- |
| Input | Target and recent targets, port, masked community, OID, timeout/retries, parse and MIB resolution options, structured output layout |
| Execution | Enter-to-run, progress/counter, cancellation, error detail, request timeouts |
| Results | Raw/parsed structured results, table sort, search/filter, copy, TSV, download, empty states |
| Persistence | Recent targets, result history, restore/revisit/delete history, form persistence |
| APIs | `POST /api/walk/execute`; OID resolution and browsing actions |

## Traps

| Group | Controls/behaviors to reproduce |
| --- | --- |
| Sender | Host/port/community, searchable trap library, OID resolution, varbind editor, enum and range/size validation |
| Protocol | Trap and inform send with acknowledgment/error handling, replay stored trap with safe community semantics, offline decode |
| Receiver | Start/stop, port/community, resolve MIBs, uptime, status, new-event indicator |
| History | Search, sort, pause live updates, pagination and counts, inspect, replay, export CSV, clear and row delete confirmation |
| Large data | Server-ranked varbind picker (`/api/mibs/objects?search=…`), bounded events, pagination and WS refresh |
| APIs | `/api/traps/*`, `/api/mibs/traps`, `/api/mibs/objects`, `/api/mibs/resolve`, `/api/ws` |

## MIB Browser

| Group | Controls/behaviors to reproduce |
| --- | --- |
| Explorer | Module versus OID tree, lazy-expand, depth selection, filter by module/type, restore expanded/selected state |
| Search | Ranked/capped server-side query, symbolic/numeric OID, ETag-cached OID index when appropriate |
| Detail | Syntax, enum, range, size, BITS, textual convention constraints, actionable links and copy |
| Cross-workspace | Send selection to Walk & Parse or Traps without dropping OID context |
| State/error | Active bundle invalidation, recompile notice, no-results, loading, large-catalog responsiveness |
| APIs | `/api/mibs/browse/*`, `/api/mibs/status`, `/api/mibs/bundle-summary`, `/api/bundles/*` |

## MIB Manager

| Group | Controls/behaviors to reproduce |
| --- | --- |
| Source inventory | Loaded/failed counts, source groups, file scope/filter/search, shadowed rows and failed-module details |
| Mutations | Dropzone, validation and compile feedback, upload/partial upload, reload, delete one/many with confirmation |
| Bundle lifecycle | List, inspect/diff, activate/rollback, recompile hints, live-change refresh |
| Export | Filtered JSON/CSV catalog, source download, multi-file ZIP, per-source-group export |
| Trap catalog | Search/sort, trap details, route selected notification to sender |
| APIs | `/api/mibs/*`, `/api/bundles/*` and `/api/ws` |

## Settings

| Group | Controls/behaviors to reproduce |
| --- | --- |
| Security | Current password, new username/password and confirmation, strength/validation, session invalidation |
| Application | Autostart simulator/receiver, session timeout bounds, MIB auto-fetch, remote sources and validation |
| State | Unsaved form, save feedback, restart-required indication, error handling |
| Diagnostics | App version/author/about and bundle producer; stats export and destructive reset |
| APIs | `/api/settings/auth`, `/api/settings/app`, `/api/meta`, `/api/stats/`, `/api/mibs/status` |

## Release-blocking integration scenarios

- [ ] Auth: first login, logout, refresh, session expiry (REST 401/WS 4001), independent tabs, same-tab legacy→modern handoff
- [ ] Realtime: full snapshot, incremental updates, reconnect, missed event recovery, offline state, no listener leak
- [ ] Data fidelity: representative MIB corpus with enums, constraints, source groups, bundle switch and large catalog
- [ ] Destructive tasks: confirmation for clear/delete/reset/rollback and recovery from API errors
- [ ] Protocol: local simulator + walker + trap/inform/replay, verified against backend responses and UDP behavior
- [ ] Reliability: long logs/trap history, pagination/search/sort, concurrent views, preserved draft form state
- [ ] Accessibility: keyboard, dialog focus, touch, light/dark/zoom and screen-reader checks

## Unmeasured baseline — still required before release gate

**Not measured in this source audit:** 1440/1024/390 screenshots in both themes; JS/CSS transfer sizes; navigation/page timings; large MIB search latency; 1,000+ trap render/pagination timings; WS recovery time and memory/CPU; real UDP task completion. Record these with the same dataset and device/browser profile in both UIs. **No performance, visual or full parity sign-off is implied by this document.**

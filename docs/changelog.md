# Changelog

All notable changes to Trishul SNMP Suite will be documented in this file.

This file intentionally retains historical `1.x` release entries. Those
sections are release history, not the operator source of truth for the shipped
`2.0.3` UI or runtime behavior.

The current stable release line is `2.0.3`. The entries below `2.0.3` are
historical releases retained for release history.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.3] - 2026-09-30

### Added
- **Accessibility / Landmarks** - Skip link, primary navigation landmark, per-view `h1` headings, and semantic table captions across the operator UI.
- **Walk & Parse / Results** - Walk output renders as a structured `OID` / `Type` / `Value` table instead of a raw text dump; search, copy, and export operate on the same data.
- **Tables / Sorting** - Received traps and the trap library are sortable (time/source, name/OID) with keyboard-operable headers and `aria-sort`; the trap library renders a summary footer past 500 rows.
- **Search / Clear** - All toolbar searches gained a conditional clear button that empties, refocuses, and re-filters.
- **Motion** - `prefers-reduced-motion` is respected across animations and transitions.

### Changed
- **Branding** - The sidebar heading and login use a two-tier `Trishul` / `SNMP Suite` lockup; the main page header shows only the page title.
- **Dialogs** - Native `confirm()` popups are replaced with an in-house, dark-mode-aware confirmation dialog for logout, MIB deletion, history clearing, stats reset, and credential updates.
- **Security UX** - SNMP community inputs are masked as password fields.
- **Theming** - Light mode uses light card headers (the navy gradient remains the dark-mode variant); placeholders, warning/success badges, selected tree nodes, and empty states meet AA contrast in both themes.

### Fixed
- **Accessibility** - Visible keyboard focus indicators on all buttons and inputs; programmatic labels for every form control including JS-rendered rows; labelled modals; `role="alert"` error regions; live-region announcements for walk progress, trap arrivals, and simulator log summaries; accessible names for icon-only controls and the WebSocket status dot.
- **Usability** - Mobile sidebar drawer closes via backdrop and Escape with focus management; port inputs are bounded to `1-65535`; the walker community field label reads `Community`.
- **Auth Flow** - Credential updates read the backend's `reauth_required` response and log out immediately, without a redundant second confirmation dialog or a fixed timer.
- **Realtime** - The WebSocket stats broadcast now uses the `stats` payload key, matching the initial full-state message; the dashboard accepts both shapes.

## [2.0.2] - 2026-05-26

### Added
- **MIB Source Download** - `POST /api/mibs/download` now returns one stored source file directly or a zip archive for multiple selected managed MIB files.

### Changed
- **MIB Manager / Source Filtering** - The source inventory filter now uses `Source Group` plus a scoped search selector for `All`, `Module`, `Imports`, or `Path`.
- **MIB Manager / Selected Actions** - The source toolbar now supports selected-module exports in JSON or CSV using the current export content type, raw `MIB` download for stored source files, and compact labeled `Select` / `Clear` actions.
- **Catalog Export Shape** - Notification exports keep the nested notification-centric JSON view while CSV stays flattened per member; redundant flattened `*_full_name` and member `source_*` columns were removed from notification export payloads.
- **Branding** - The sidebar branding now uses the full `Trishul SNMP Suite` name.

### Fixed
- **MIB Manager / Export Selection** - Selected row exports now skip non-loaded rows cleanly instead of producing misleading module-based output for pending or failed sources.
- **MIB Manager / Raw Downloads** - Single-row and bulk source downloads now work directly from the current source inventory without requiring a catalog export workaround.
- **Docs** - The API reference and MIB Manager guide now document scoped source filtering, selected-module exports, and raw source download behavior.

### Migration Notes
- No schema or data migration is required from `2.0.1`.
- Existing `2.0.1` deployments can be restarted in place with the current installer to pick up the `2.0.2` backend and frontend assets.

---

## [2.0.1] - 2026-05-25

### Changed
- **Installer / Ports** - `APP_PORT` is now the canonical app port with default `8980`; `BACKEND_PORT` is an optional compatibility alias to the same merged app, the installer reuses current deployed host ports when no override is passed, and `BACKEND_PORT=none` removes the alias on the next restart.
- **Logging / Observability** - Container deployments now log to `stdout`/`stderr` by default with Docker-managed rotation; Alembic, uvicorn, and app logs use the same timestamped format; startup and shutdown lifecycle logs stay visible; routine HTTP request noise is pushed below `INFO`; simulator and trap runtime events are logged as meaningful operator signals.
- **MIB Status Model** - `/api/mibs/status` now separates deduplicated `active_modules` from per-source `source_inventory`; compatibility fields `mibs` and `errors` remain as the active and failed aliases for the v1 API.
- **MIB Exports** - Source-group scoped exports now use source-group membership over the single active runtime bundle, while `All modules` and active-bundle exports stay deduplicated.
- **Docs / Validation** - README and operator docs now reflect the `2.0.1` installer port model, release-validation commands, and the shipped API behavior.

### Fixed
- **MIB Manager** - Duplicate modules across source groups are no longer treated as failed by default; group filtering and failed-MIB views now distinguish `active`, `shadowed`, `invalid`, and true compile failures correctly.
- **Compiler Attribution** - Compile metadata now persists selected source paths and result rows so per-file status, invalid-parse detection, and failure attribution stay stable after reloads and page changes.
- **MIB Browser** - Search keeps the active type filter, and filtered module or type views auto-expand one level so the result is immediately visible.
- **Traps** - Trap history preserves event-time OID resolution, header resolve status stays in sync, enum varbind options load again, and live received-event updates continue even when the WebSocket path is degraded.
- **Exports / Stats** - Exported filenames now reflect the exported bundle or notification scope, and stats export no longer includes the full runtime OID catalog by default.

### Migration Notes
- No new operator data migration is required for deployments already on `2.0.0`; the `2.0.1` line keeps the same SQLite-plus-bundles runtime model.
- If you were using the compatibility alias, redeploy without explicit port overrides to keep the current host mapping, or set `BACKEND_PORT=none` to remove the alias on the next restart.

## [2.0.0] - 2026-05-21

### Added
- **Backend Platform** - FastAPI application with Alembic-managed SQLite schema, durable session storage, durable notification history, and in-process SNMP runtime.
- **In-Process SNMP Runtime** - Replaced subprocess-based pysnmp workers with a fully in-process async runtime via `trishul-snmp`: responder, manager (GET/GETNEXT/GETBULK/walk/bulkwalk), notification listener, trap/inform send, and offline payload decode. No subprocesses, no UDP loopback IPC, no shell-outs.
- **Simulation Rules** - Counter, random, timestamp, and uptime simulation rules for the responder.
- **Bundle Pipeline** - MIB compilation via `trishul-smi` with versioned bundle storage, activation, compile history, and in-memory `MibBundle` for all catalog and browser queries. No SQLite catalog index tables.
- **MIB Source Management** - Upload source groups, source group precedence, duplicate shadowing detection, partial compile, and dependency auto-fetch.
- **Flat Service Architecture** - All API routes call service modules directly. No bridge or adapter classes between routes and services.
- **Release UI** - Page-based operator shell: `Dashboard`, `Simulator`, `Walk & Parse`, `Traps`, `MIB Browser`, `MIB Manager`, `Settings`.
- **Notification History** - Durable received and sent notification events persisted in SQLite for trap workflows, stats, and operational diagnostics.
- **Backend Test Layout** - File-scoped unit, contract, integration, and live test suites with an explicit backend coverage gate for the shipped runtime.

### Changed
- **Architecture** - Single FastAPI application, single SQLite database, single in-process SNMP runtime. Replaced the v1.x subprocess worker model (pysnmp + separate simulator and trap receiver processes communicating via UDP loopback and file-based stats).
- **API** - One unified `/api/...` surface. The separate secondary route families for simulator, catalog, bundles, runtime, profiles, and history have been eliminated.
- **Stats** - Stats counters now stored in the SQLite `app_settings` table rather than a file-backed stats store with cross-process file locking.
- **Page Data Flow** - Dashboard and MIB Manager now reuse persisted stats and source inventory state instead of reprocessing MIB inventory on every page switch.
- **Frontend Build** - The shipped image builds `frontend/` into `frontend/dist` at container build time.
- **Documentation** - Core docs rewritten to reflect the flat service architecture, actual API surface, and real test file inventory.

### Fixed
- **Bootstrap** - Release-shell packaging ships the built frontend artifact in the runtime image.
- **Packaging** - `alembic.ini` is shipped in the runtime image so startup migrations succeed in the container.
- **Dashboard / MIB Manager** - MIB counters and source stats no longer hang in loading state after page switches; the dashboard source card now renders correctly from the active stats snapshot.
- **MIB Browser** - Search requests now preserve the selected type filter in the UI flow.
- **MIB Manager** - Upload and validation status stay in sync, source-group filtering returns the correct in-group totals, and per-row failed-MIB delete actions update modal state cleanly.
- **Compiler / Sources** - Vendor `SNMPv2-SMI.mib` naming conflicts no longer break bundle compilation.
- **Settings / Runtime Stats** - Reset stats now clears the in-memory simulator request counter as well as persisted counters.
- **Traps** - Varbind enum dropdowns load correctly again in the trap send flow.

### Removed
- **Subprocess Workers** - `workers/snmp_simulator.py` and `workers/trap_receiver.py` eliminated; all SNMP runs in-process.
- **Operator Shell Bridge** - `backend/app/services/operator_shell.py` and the shell bridge layer eliminated; routes call flat services directly.
- **Catalog Index Tables** - `BundleObject` and `BundleNotification` SQLite tables removed; catalog and browser queries use the in-memory `MibBundle`.
- **Profiles** - Saved connection and simulator profile services removed; scheduled for `2.1.0`.
- **Secondary Runtime/Bundle/Catalog/Profile Routes** - The extra runtime, bundle, catalog, profile, session, and system route families were removed; functionality is now exposed through the main `/api/...` surface.
- **Secondary History Routes** - The separate history route family was removed; if history workflows return to the UI they should be exposed through the main `/api/...` surface.

### Migration Notes
- Existing credentials and uploaded MIB files carry forward into the `2.0.0` runtime.
- There are no catalog index tables in `2.0.0`. MIB status and browser queries use the compiled bundle loaded in memory.

## [1.4.1] - 2026-05-06

### Fixed
- **Navigation Shell** - Updated the sidebar branding to `Trishul SNMP Suite`, kept the navbar dashboard title generic, and removed the duplicated app icon from the top bar.
- **MIB Browser** - Restored click behavior on module rows and cleaned up the search clear-button state so the browser tree controls behave consistently.
- **Navbar Menu** - Raised the user dropdown above page cards and sticky table headers so the account menu no longer renders behind content.

---

## [1.4.0] - 2026-05-06

### Added
- **Runtime** - Added a single root `Dockerfile` that packages the FastAPI backend and static frontend assets into one image.
- **Installer** - Added `install-trishul-snmp-suite.sh` as the canonical deployment and local-build entrypoint for the merged runtime.
- **Migration** - Added automatic migration from legacy `trishul-snmp-data` into `trishul-snmp-suite-data`, while preserving the old volume for rollback.
- **Docs** - Added a dedicated migration guide for operators moving from the legacy split runtime.

### Changed
- **Branding** - Renamed the product to `Trishul SNMP Suite` and aligned runtime metadata with version `1.4.0`.
- **Runtime** - FastAPI now serves `/`, module partials, static assets, `/api/*`, `/api/ws`, and `/docs` directly from one container.
- **Deployment** - Docker Compose and GHCR publishing now target a single image: `ghcr.io/<owner>/trishul-snmp-suite`.
- **Installer** - The now-removed `install-trishul-snmp.sh` acted as a compatibility wrapper around the new suite installer in the `1.4.x` line.

### Removed
- **Nginx Frontend Layer** - Removed the dedicated frontend image and Nginx proxy from the default deployment path.

---

## [1.3.0] - 2026-05-04

### Security
- **MIB Manager** - Hardened validation temp-file handling so uploaded filenames cannot escape the validation directory.
- **Frontend** - Centralized escaping helpers and removed stored XSS paths across trap, MIB, browser, simulator log, and saved walk-history rendering.
- **WebSocket** - Active connections now honor logout and session timeout, not just the initial handshake.

### Added
- **MIB Manager** - Trusted remote dependency fetch with an ordered source list, manual fetch action, and optional auto-fetch during upload or reload.
- **MIB Browser** - Current-view export for both search results and filtered tree views in JSON and CSV.
- **Deployment Script** - At that point in the `1.3.x` line, `install-trishul-snmp.sh` supported local image builds via `build-local`, `up-local`, `restart-local`, or `TRISHUL_IMAGE_SOURCE=local`.
- **Tests** - Smoke and regression coverage for login, lifecycle flows, trap send/receive, walk execution, MIB upload/reload, auth cutoff, startup failure handling, and concurrent stats writes.
- **Docs** - Repo-local development setup, release process, GitHub workflow, and PR template guidance.

### Changed
- **Docker Compose** - Removed hard `linux/arm64` pins so amd64 and arm64 hosts use the matching image by default.
- **MIB Fetching** - Validation stays read-only; remote fetch is restricted to configured approved sources and only runs manually or during upload/reload when enabled.
- **Release Planning** - Roadmap and tracker docs now reflect `1.3.0` as the hardening, workflow, and targeted feature release.

### Fixed
- **Stats** - File locking prevents lost updates between API requests and worker-style writers.
- **Simulator / Trap Receiver** - Start endpoints now wait for real readiness and return actionable bind or startup failures.
- **Traps** - Switched to the current pysnmp varbind API to remove the deprecation warning in the test suite.

---

## [1.2.5] - 2026-02-22

### Added
- **MIB Manager** - Drag-and-drop MIB file upload onto the MIB Library card
- **MIB Manager** - Auto-validation on file selection; validation runs immediately on file pick or drag-and-drop without clicking Validate
- **UI** - Dark mode toggle in navbar; preference persisted to `localStorage`, survives page refresh

### Changed
- **MIB Manager** - Removed manual "Validate" button from upload modal; Upload & Reload button auto-enables after validation passes

### Fixed
- **MIB Manager** - Race condition in drag-and-drop handler: dropped files were cleared by `showUploadModal()` before `validateFiles()` ran; fixed by re-assigning via `DataTransfer` after modal reset

---

## [1.2.4] - 2026-02-22

### Added
- **WebSocket** - `ws-client.js` browser client with auto-reconnect, token auth via `?token=` query param, and a navbar live-connection dot indicator.
- **UI / Utils** - `TrishulUtils.formatRelativeTime`, `formatUptime` helpers (epoch-safe, 1970 guard); consolidated `showNotification` replacing all per-module toast implementations.
- **Dashboard** - 8-counter Activity Stats row: SNMP Requests, OIDs Loaded, Traps Received, Traps Sent, Walks Executed, OIDs Returned, MIBs Uploaded, Times Reloaded — all WS-driven, zero polling.
- **Settings / App Behaviour** - New card: Auto-Start toggles (Simulator + Trap Receiver) and Session Timeout field, persisted to `data/configs/app_settings.json`; yellow “Restart required” badge on save.
- **Settings / Stats Management** - New card: Export Stats (downloads `trishul-stats-YYYY-MM-DD.json`) and Reset Stats (confirm dialog).
- **Settings / About** - New read-only card showing app name, version, author, and description from `/api/meta`.
- **Backend** - `GET /api/settings/app` and `POST /api/settings/app` endpoints; `AppSettingsUpdate` Pydantic model with `ge`/`le` validation on session timeout (60–86400 s).
- **Core/Config** - `APP_SETTINGS_FILE` path constant; `_apply_app_settings()` loads `app_settings.json` overrides at startup (`SESSION_TIMEOUT`, `AUTO_START_*`).

### Changed
- **Dashboard, Simulator, Traps** - All real-time data switched from HTTP polling to WebSocket push (`full_state` snapshot on connect + incremental events).
- **Docker** - Backend healthcheck interval 10 s → 30 s; `app.js` periodic meta poll removed (data sourced from WS `full_state` on connect).
- **Traps page** - Receiver table “Port” column replaced with “Uptime” column.
- **Settings page** - Restructured to 2 × 2 card grid (Auth + App Behaviour top row; Stats Management + About bottom row).

### Fixed
- **WebSocket** - Backend crash on client connect caused by missing `_enrich_sim_status` call; resolved by adding helper to simulator service.
- **Traps** - `_broadcast_stats` now fires after trap send (was before), fixing Traps Sent counter undercount on the dashboard.
- **Dashboard** - Service status cards showed loading spinner indefinitely on page switch; fixed by triggering status refresh on page activation.
- **Dashboard** - Service status icon used wrong colour class (purple → secondary).
- **Utils** - `formatRelativeTime` returned “56 years ago” for epoch `0` / `null`; added explicit guard returning `—`.
- **Browser** - State restore on page switch conflicted with live WS updates; resolved sequencing.

---

## [1.2.3] - 2026-02-18

### Added
- **WebSocket** - Server-push backend: `/api/ws` (token auth), `full_state` snapshot on connect, ping/pong keepalive.
- **WebSocket** - UDP loopback IPC (`127.0.0.1:WS_INTERNAL_PORT`, default `19876`) so worker trap events can be pushed without Redis/shared memory.
- **Core/Config** - `WS_INTERNAL_PORT`, `AUTO_START_SIMULATOR`, `AUTO_START_TRAP_RECEIVER` settings; `APP_AUTHOR` / `APP_DESCRIPTION` now read from env.
- **Stats** - Global file-backed stats store + `/api/stats/` endpoints (aggregate + per-module + reset).

### Changed
- **Simulator API** - Lifecycle endpoints broadcast status/stats events to WS clients after state changes.
- **Trap Manager / Trap Receiver** - Manager start/stop broadcasts status; receiver sends a UDP datagram to main process on each received trap.
- **Main** - Lifespan starts UDP listener before auto-starting services; graceful stop on shutdown.
- **Docker Compose** - Backend healthcheck + frontend `depends_on: service_healthy`; removed deprecated `version:` key; inject `AUTO_START_*` env vars.
- **Nginx** - Added `/api/ws` location block (WS upgrade + long read timeout); added proxy_redirect, gzip, real-IP forwarding headers, and increased proxy timeouts.

### Fixed
- **Docker** - Healthcheck now uses Python `urllib` instead of `curl` (not present in `python:3.10-slim`), fixing "backend unhealthy" startup blocking.
- **Simulator** - Restart-chain stats: indirect restarts now increment `restart_count` via shared helper.
- **Traps** - Receiver status uses configured port (not hardcoded `1162`); `clear_traps()` uses context manager; `SnmpEngine` singleton avoids repeated engine init.
- **Walker** - Validate inputs before walk; preserve `HTTPException` messages; label-only walk returns correct `mode`.
- **MIB Manager** - Filename sanitization on upload/save.
- **Core/Auth** - Settings metadata read from settings instance; password hashing + legacy plaintext migration; session timeout enforced; logout token handling; avoid stdlib `logging` shadowing; CORS origins via `ALLOWED_ORIGINS`.
- **API** - Removed unused/dead `files.py` router (never registered; referenced missing service module).

### Performance
- **WebSocket** - Enables eliminating periodic HTTP polling once the frontend is switched to WS (frontend polling not changed in this backend branch).

---

## [1.2.2] - 2026-02-18

### Added
- **Walk & Parse** - Added a clearer empty-state placeholder for "Current Result" when no results are present.

### Fixed
- **Walker** - Implemented missing "Clear results" handler and fixed delete-history click causing unintended navigation.
- **Traps** - Fixed trap detail modal "Copy" breaking due to JSON quotes in inline handlers; ensured row action buttons don't submit forms unintentionally (added `type="button"`).
- **Browser** - Fixed search clear icon visibility/state issues and standardized visibility toggling using class-based approach.
- **MIB Manager / Settings / UI** - Standardized dynamic show/hide behavior to use `classList` (`d-none`) instead of inline `style.display` where it was causing visibility bugs.

### Changed
- **UI/UX Consistency** - Unified card headers (dark theme, consistent height/alignment), standardized button sizing, and made card borders more visible across pages.


## [1.2.1] - 2026-02-11

### Added
- **Simulator** - Runtime metrics (uptime, SNMP request count, relative last activity).
- **Simulator** - Activity log persistence + search/filter/export, plus improved feedback (log + toast style messaging).
- **Simulator** - JSON validation + unsaved changes indicator / warning.

### Changed
- **Simulator** - Improved state management and UX while running (config lock/disable patterns).

### Fixed
- **Simulator** - More robust error handling for start/stop/restart/status flows.


## [1.2.0] - 2026-02-09

### Added
- **MIB Browser** - Interactive tree explorer with dual view modes (by module/OID hierarchy)
- **Tree Navigation** - Expandable OID hierarchy with configurable depth (1-5 levels, default: 3)
- **Real-time Search** - Find OIDs by name, numeric OID, or description with 500ms debounce
- **Smart Filtering** - Filter by module and object type (scalars, tables, columns, notifications)
- **Details Panel** - Compact metadata display with breadcrumb navigation
- **Seamless Integration** - Jump to Walker/Trap Sender with pre-filled data
- **State Persistence** - Remembers filters, search, expanded nodes, and selected OID across page switches
- **System MIB Detection** - Visual distinction between loaded MIBs (blue) and built-in MIBs (gray)
- **Trap Library Enhancement** - Shows all 24 traps (19 from loaded MIBs + 5 from system MIBs)
- **Dashboard Card** - Added MIB Browser card with purple theme
- **Depth Control** - Dropdown selector for expansion depth with expand/collapse buttons
- **Copy Buttons** - One-click copy for OID and full name in details panel
- **Loading Indicators** - Spinner and notifications for expand/collapse operations

### Fixed
- **Trap Count Consistency** - Dashboard, MIB Manager, and Browser now show consistent trap counts
- **MIB Delete Function** - Fixed error handling when deleting MIB files
- **State Restoration** - Fixed search clear icon visibility after page switch
- **Expanded State** - Tree expansion state now properly restored after navigation
- **Selected Node** - Details panel correctly loads after page switch
- **System MIB Badge** - SNMPv2-MIB and RMON-MIB correctly marked as system only when not loaded

### Changed
- **UI/UX Consistency** - Unified styling across all components
- **Trap Manager** - Renamed "Available Traps" to "Trap Library" for clarity
- **Dashboard Polling** - Reduced from 5s to 10s for better performance
- **Backend Caching** - Added 60-second cache for trap list API calls
- **Component Overview** - Updated README with compact overview of all 6 components

### Performance
- **Backend Caching** - Trap list cached for 60 seconds (reduces repeated queries)
- **Lazy Loading** - Tree nodes load children on-demand
- **Efficient Rendering** - Only visible nodes rendered in tree
- **Debounced Search** - 500ms delay prevents excessive API calls

---

## [1.1.7] - 2026-01-15

### Changed
- Rebranded to Trishul-SNMP
- Improved documentation and contributing guidelines

---

## [1.1.6] - 2025-12-20

### Added
- Docker volume support for data persistence
- Backup/restore functionality
- Smart GHCR authentication (public/private images)

---

## [1.1.5] - 2025-11-10

### Added
- One-command installer script
- Customizable backend and frontend ports
- Host network mode for dynamic SNMP ports

### Changed
- Improved UI
- Updated app icon

---

## [1.1.4] - 2025-10-05

### Changed
- Updated UI visuals and fixes

---

## [1.1.3] - 2025-09-15

### Added
- Enhanced trap management with real-time display
- JSON/CSV export for walk results

### Changed
- Improved error handling and logging

---

## [1.1.2] - 2025-08-20

### Added
- MIB browser with trap enumeration

### Fixed
- Trap sender fixes
- SNMP walker fixes

---

## [1.1.1] - 2025-07-10

### Fixed
- SNMP walk simulator fixes

---

## [1.0.0] - 2025-06-01

### Added
- Initial release
- SNMP simulator with custom OIDs
- Walk & parse functionality
- Trap sender and receiver
- MIB manager with validation
- Session-based authentication
- Docker deployment
- Bootstrap 5 UI

---

## Legend

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Vulnerability fixes
- **Performance** - Performance improvements

---

[1.4.1]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.7...v1.2.0
[1.1.7]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.0.0...v1.1.1
[1.0.0]: https://github.com/tosumitdhaka/trishul-snmp-suite/releases/tag/v1.0.0

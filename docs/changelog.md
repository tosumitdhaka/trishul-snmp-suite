# Changelog

All notable changes to Trishul SNMP Suite will be documented in this file.

This file intentionally retains historical `1.x` release entries. Those
sections are release history, not the operator source of truth for the shipped
`2.2.4` UI or runtime behavior.

The current stable release line is `2.2.4`. The entries below `2.2.4` are
historical releases retained for release history.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.2.4] - 2026-10-09

`PATCH-224-001`: simulator default generation validated against the local vendor MIB corpus.

### Fixed
- **Index-column defaults** retain their declared SNMP type and constraints. Row values `1` and `2` are used only when allowed, fixing startup and custom-data saves for `CIENA-CES-MPLS-MIB::cienaCesMplsPwVifIndex` (`Unsigned32 (32769..2147483647)`). String, BITS, and enum columns containing “index” in their name also retain their type and valid default.
- **Textual-convention defaults** follow imported alias chains to their SNMP wire types, preserving Counter64, unsigned, string, OID, IP, and Opaque values. Numeric types take precedence over object-name hints.

### Validation
- Offline local corpus: 429 compiled modules, 104,429 generated objects across three random seeds; no runtime parse or size/range validation failures. Five source modules with unavailable dependencies are explicitly excluded from this result.
- Compared with `v2.2.3`, which reproduces the reported CIENA failure for both generated rows.
- Live UDP startup, GET, custom updates to both `sysName` and the CIENA index, and persistence across restart.
- Backend release tests, coverage thresholds, migrations, startup smoke, frontend build, and live runtime tests.

### Added
- `scripts/validate_simulator_corpus.py`: repeatable validation of a compiled corpus, optional baseline comparison, JSON evidence, and live simulator checks using isolated temporary runtime data.

### Migration
- Pull or rebuild `2.2.4` and restart the suite. Existing data, bundles, and custom overrides remain compatible; no database migration is required.

---

## [2.2.3] - 2026-10-09

`PATCH-223-001`: simulator patch for bundles containing valid empty byte values.

### Fixed
- **Simulator startup and custom-data updates** accept empty hex/base64 OCTET STRING values, including physical-address defaults with `SIZE (0 | 6)`, instead of failing with `value must be a non-empty string`. Both operations validate the complete bundle defaults, so the failure could also block edits to unrelated OIDs.
- **Notification replay** preserves empty encoded OCTET STRING and Opaque values.
- **Runtime validation errors** identify the target OID when a value cannot be parsed. MIB size constraints still reject empty values when a nonzero size is required.

### Validation
- Backend tests and the release coverage gate.
- Live UDP simulator startup, custom-value updates, reads, and persistence across restart using a compiled bundle with empty physical-address and BITS defaults.

### Migration
- Rebuild or pull the `2.2.3` image and restart the suite. Existing data volumes, bundles, and custom overrides are retained; no database migration is required.

---

## [2.2.2] - 2026-10-06

Scale-and-integrity patch: closes the issues reported against large production
bundles (533 modules, ~109k objects, 3,246 notifications) plus the traps-page
integration and layout defects confirmed on the live lab.

### Fixed
- **Varbind picker** no longer downloads the full MIB catalog on open (29 MB / 18 s on large bundles — 25 s to open the picker): it now queries a ranked, capped server-side search per keystroke (minimum two characters), with a legacy fallback for old backends.
- **MIB catalog search** (`/api/mibs/objects`) accepts `search` + `limit`, ranks exact/full-name matches first, and returns an empty list for empty searches.
- **Browser search** now indexes NOTIFICATION-TYPE/TRAP-TYPE nodes: `IF-MIB::linkDown` ranks first instead of being unfindable while unrelated substring matches filled the results.
- **Trap library datalist** reliably populates at catalog scale (per-keystroke, capped) and a selection made while the catalog is still loading now resolves and populates the declared varbinds instead of leaving a single auto row.
- **Default notification varbinds** load automatically when the form opens with a prefilled OID, when the OID changes, and after Reset — guarded so edited forms are never clobbered.
- **Received-traps header buttons** fit on one line at 1280/1440 px with no overlaps (icon-only Refresh/Download/Clear, proper sizes); Pause carries a real pressed state with a Resume label swap.
- **Row action buttons** use the standard icon-button sizing in a widened actions column instead of cramped 32×15 px controls.
- **Received varbind entries** render with clear per-line separation in the table cell; the trap-name badge is a real button with a focus ring and keyboard activation.
- **Clicking a received trap row** opens the detail modal.

---

## [2.2.1] - 2026-10-06

Production patch: closes every issue confirmed against live 2.2.0 deployments
(the full QA round — Playwright-driven functional verification of all pages
plus backend root-cause analysis of the reported failures).

### Fixed
- **Simulator start** no longer fails on MIBs that declare byte-sized `PhysAddress`/`MacAddress` objects (e.g. `ALCATEL-IEEE8021-PAE-MIB::alxDot1xNotifyMacAddress`): generated defaults now serve raw octets through the hex encoding channel, satisfying SMI SIZE constraints (a 17-character colon-form MAC was previously rejected as `value length 17 is outside the declared size 6..6`).
- **Trap sender** accepts symbolic OID varbind values (e.g. `IF-MIB::linkDown`) instead of rejecting them with "requires at least two arcs"; integer varbinds accept enum labels (e.g. `up`) by resolving them against the node's declared enumerations; empty OID values are rejected explicitly.
- **Walks with a numeric OID root** resolve the table name for metric grouping instead of grouping under the raw OID string.
- **TimeTicks metric values** carry the raw wire integer — the grouped/export payload previously disagreed with the raw lines by a fractional seconds form.
- **Simulated counters** can no longer draw negative values when the declared range reaches zero (e.g. `ifNumber` serving `-533828582`).
- **Dashboard walk statistics** (walks executed, OIDs returned, SNMP requests) now update live over WebSocket instead of only on page re-entry.
- **MIB browser node detail** resolves TEXTUAL-CONVENTION constraints, so TC-typed objects (e.g. `ifIndex` → `InterfaceIndex` range 1..2147483647) render range/size badges.
- **Walker results table** fixed a column misalignment on every parsed walk — a ghost empty cell was emitted before each value cell, shifting the Type and Value columns.
- **Walker form** inputs (host, port, community, OID) and the result filter survive page reloads; the browser→walker OID handoff still takes precedence.
- **MIB browser tree** highlights the clicked row instead of the module header when a module shares its OID with its first child.
- **Trap detail/replay/decode modals** receive focus on open, so Escape closes them immediately.

---

## [2.2.0] - 2026-10-05

Closes the full 151-finding end-to-end review (backend-to-frontend, code-to-UI/UX) — registry and dispositions in `docs/e2e_review_findings.md`.

### Added
- **Bundle Lifecycle** - Bundle sets can be listed, inspected, diffed, and rolled back from the MIB Manager; diffs use a content-hash fast path, and activation broadcasts to live sessions so other tabs re-sync immediately.
- **Trap Sender** - SNMP inform sending with acknowledgement; replay of any received trap (the recorded community is applied server-side unless overridden); offline payload decoding; Counter64 varbinds; CSV export of received traps.
- **Receiver** - Paginated trap history with per-trap delete, full dated timestamps, and a pause control for live updates while inspecting.
- **Walker** - Timeout and retry controls, walk cancellation, sortable result columns, Enter-to-run (plain and Ctrl/Cmd+Enter), and copy-as-table TSV export.
- **MIB Browser** - Constraint badges (range, size, enum, bits) in the detail panel; inline recompile notices for pre-enum/units bundles; ETag-cached OID index with 304 responses; always-visible detail actions via a sticky bar.
- **Simulator** - BITS-typed object defaults (octet string); log follow/pause toggle with level-count chips; live/polling source indicator reflecting the actual data path.
- **Settings** - About card showing the active bundle and producer version; server-derived restart-required badge that persists across navigation; per-line remote-source validation and inline session-timeout validation.
- **MIB Manager** - Sortable trap catalog (Module/Objects columns); humanized revision dates with a Latest badge; failed-run surfacing widened to a 100-run window.

### Changed
- **Security / Redaction** - SNMP community strings are masked in trap list payloads (REST and live WS push) and CSV exports; the replay route applies the recorded value server-side when the override is blank.
- **Performance** - MIB status reads each stored file once per cache generation; compiles serialize on a process-wide lock without holding DB sessions; the trap table re-renders only when data actually changes and polling stops while the WebSocket is healthy; a lightweight bundle-summary route replaces full status scans on browser entry.
- **Walker Classification** - Metric detection uses whole-word matching over camelCase-tokenized names, fixing misclassification of identifiers like `ifWidth` and `ifVideoBitRate`.
- **Walker Progress** - The progress bar runs indeterminate while walking and only announces real outcomes.
- **Trap Badges** - Tones derive from a whole-token severity vocabulary, with danger and warning outranking success tokens.
- **Settings / Sessions** - Credential updates broadcast a re-auth event and close live WebSocket sessions (4001); other clients react immediately instead of failing on the next request.
- **Simulator Status Errors** - Consecutive identical backend-down errors collapse to a single activity-log entry.

### Fixed
- Grouped-mode walks no longer emit garbage metric rows when symbolic resolution fails (instance keys decode from the table's declared index columns, with a documented heuristic fallback).
- An invalid custom-data value can no longer kill the simulator responder on first query; stale entries warn-and-skip on start with surfaced warnings, and saves reject them explicitly.
- The simulator responder no longer leaks when restarted on a different address.
- A zero-match filter no longer exports the full dataset.
- A failed receiver restart no longer tears down the running listener.
- Reset Stats no longer resurrects deleted traps from the client cache.
- Settings saves validate everything before persisting (no partial persistence on validation errors).
- Ctrl/Cmd+Enter can no longer start a second concurrent walk.
- The Resolve-MIBs toggle re-renders trap history immediately (previously deferred until the next poll).

---

## [2.1.0] - 2026-10-05

### Added
- **MIB Schema / Enums** - Enum labels, units, and constraints from the trishul-smi `0.5.x` JSON IR are surfaced end-to-end: walks render the raw value with a muted `label(value)` enrichment and units suffix on single-line rows; trap history and detail render an enum badge (with full-text tooltip) and units suffix; the MIB browser detail panel gains Enumerations tables (sorted, count-badged, sticky headers) and a Units badge.
- **Bundles / Reproducibility** - MIB compiles are reproducible (byte-identical artifacts) and bundle sets carry a `content_hash` identity; a producer-aware banner in `MIB Manager` recommends recompiling bundles that predate enum/units support — and the banner's action actually recompiles old-producer bundles, with bundle-scoped dismissal, payload-driven copy, and a busy state.
- **Traps / Validation** - Range and size constraints from the MIB schema are enforced server-side before PDU encode and surfaced in the trap varbind picker as hints with pre-submit validation; the picker defaults each object to its MIB-declared varbind type (Integer, Counter, Gauge, TimeTicks, OID, IpAddress) and offers enum dropdowns out of the box.
- **Walker / Index Awareness** - Walk grouping decodes instance keys from the table's declared index columns (integer and octet-string), fixing grouping for string-indexed tables; heuristic fallback retained for unresolved roots; grouped mode carries the same enum/units enrichment as flat mode.
- **MIB Browser / OID Search** - Instant client-side OID-prefix search backed by a new `GET /api/bundles/{id}/oid-index` sidecar endpoint; the fast path revalidates on bundle changes, honors active module/type filters (falling back to server search), shows correct node-type icons, and displays loading feedback while the index downloads.
- **MIB Manager / Provenance** - Module revision-history cards (revisions, organization, contact info) from `module_metadata`; expanded cards survive list re-renders.

### Changed
- **Dependencies** - `trishul-smi==0.5.3` and `trishul-snmp==0.6.2` pinned; orphaned pysnmp-family packages removed from the suite environment; `requests` moved to dev-only requirements.
- **Enums / Consolidation** - A single shared helper (`mib_metadata`) now interprets constraints as enumerations, replacing four scattered implementations; the trap picker consumes backend-provided `enum_values` only; the varbind-type mapping is canonicalized in the same helper for the picker, trap catalog, and browser paths.
- **Exports** - Walk and trap exports carry raw values with separate `enum_label`/`units` fields.
- **Simulator** - Default values are drawn inside declared ranges and sizes (TC-level constraints included); invalid custom data is rejected at save time and warn-and-skipped at startup — with skipped entries surfaced as an inline warning panel on the simulator page.

### Fixed
- Walker grouping for string-indexed tables (previously a name-split heuristic that mis-decoded non-integer instance keys).
- Simulator no longer accepts out-of-constraint values silently.

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

[2.2.4]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v2.2.3...v2.2.4
[2.2.3]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v2.2.2...v2.2.3
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

# Seven-workspace modern frontend — integrated implementation review

**Status:** Implementation preview (not parity-certified)  
**Branch:** `feat/modern-ui-all-workspaces` (based on Stage 3 Settings)  
**Scope:** `frontend-next/` only, plus documentation. No backend, Docker, production-route or legacy UI modifications.

## What is now wired

All seven React routes exist and use the shipped FastAPI 2.2.x API. No new server endpoints were invented.

| Workspace | Read APIs | Write/export APIs |
| --- | --- | --- |
| Dashboard | `/api/meta`, `/api/stats/`, `/api/simulator/status`, `/api/traps/status`, `/api/mibs/status`, `/api/ws` | None |
| Simulator | `/api/simulator/status`, `/api/simulator/data`, `/api/simulator/logs` | `/api/simulator/start`, `stop`, `restart`, `data`, `DELETE logs` |
| Walker | `/api/walk/execute` | POST walk with AbortController; export table/JSON client-side |
| Traps | `/api/traps/status`, `/api/traps/?limit=&offset=`, `/api/mibs/traps`, `/api/mibs/objects` | start/stop listener, resolve MIBs, send/send-inform, replay, offline decode, event delete/clear |
| MIB Browser | `/api/mibs/browse/modules`, `search`, `tree`, `tree/oid`, `node/{oid}` | None; cross-workspace OID handoff |
| MIB Manager | `/api/mibs/status`, `traps`, `/api/bundles`, `diff` | validate-batch, upload, reload, fetch-dependencies, delete-batch, source download/catalog export, bundle activate |
| Settings | `/api/settings/app`, `/api/meta`, `/api/mibs/status`, `/api/stats/` | app save, auth rotation, stats delete/export |

No secrets are deliberately included in local walk history or notification CSV export. Community inputs are masked; authentication uses the existing `X-Auth-Token` API contract. All actions share the same authenticated backend and existing React shell.

## Important implementation limitations (for combined review)

- **No live backend/browser integration evidence yet.** Typecheck, lint, mocked unit/component tests and build do not establish full parity. Verify on a disposable stack before operating real network devices.
- **Walker cancellation is local HTTP abort**, not server-side SNMP cancellation. The backend endpoint does not expose a cancellation endpoint; the in-flight backend walk may complete.
- **Simulator log pause suspends polling**, but the new UI currently displays a bounded backend log view rather than the legacy in-browser accumulation/follow behavior.
- **Traps:** received history is server-paginated; the text filter and CSV currently apply to the loaded page, not a server-side full-history query. The varbind editor relies on backend type/enum/range validation rather than duplicating the entire MIB constraint form presentation.
- **MIB Browser:** lazy tree expansion is capped in UI nesting depth; large-catalog speed and handling of specialized filters need measurement.
- **MIB Manager:** validation reports, compile output, and bundle diff are inspectable as structured JSON while richer contextual tables remain a refinement. Partial compile may require explicit target selection that is not available in this first preview; use full compile for general uploads. Validate supported export type/format combinations against the running backend.
- **Cross-workspace:** OID handoff exists Browser → Walker/Traps; fine-grained selection context, hot event replay, export metadata and some legacy per-user preferences still need comparison with the full legacy feature inventory.
- **WebSocket:** Vite proxy `ECONNABORTED` diagnosis from Stage 2 is pending operator testing. The direct loopback mode remains available.
- **Security:** operations such as credential rotation, deleting events, reloading catalogs and activating bundles can affect every active operator. Confirmation dialogs exist for destructive actions; avoid testing on production data.
- **Stage 4:** WCAG 2.2 AA, Playwright smoke evidence at 1440/1024/390 in both themes, real UDP traffic, OpenAPI contract generation, dependency audit and performance benchmarks are not yet completed.

## Single-review smoke checklist

- [ ] Start FastAPI on 8980 and `cd frontend-next && npm ci && npm run dev`. Login, reload nested `/next/<workspace>`, theme/keyboard/mobile drawer and hamburger icon.
- [ ] Dashboard: backend and WS distinguish disconnected/paused/stopped; eight stats counters and six launcher links.
- [ ] Simulator: start on a safe port, receive a test SNMP request, inspect activity and uptime, stop/restart; save/restore valid and rejected override JSON; log search/pause/clear.
- [ ] Walker: reachable target/port/community/OID; parsed vs raw; cancellation, timeout and retries; result table/search/sort/TSV/JSON, recent history without community leakage.
- [ ] Traps: start listener, send trap and inform, MIB varbind catalog, decode hex/base64 sample, inspect paginated received events, replay/delete/clear after confirmation, CSV and masked communities.
- [ ] MIB Browser: search names/OIDs, choose module and expand descendants lazily, inspect constraints/enums, copy OID and jump to Walker/Traps.
- [ ] MIB Manager: source group shadowing/error views; validate files, upload/reload, dependency fetch, bundle diff/rollback/activate, source ZIP/catalog export and confirmed delete.
- [ ] Settings: load failure/save protection, timeout/URL validation, credential rotation (all-session invalidation), stats export/reset and About.
- [ ] Keyboard-only, 200% zoom, focus traps, responsive overflow and light/dark contrast across all workspaces.
- [ ] Review backend log/WS console on full navigation; run existing backend pytest suite and real SNMP round trips.

**Release boundary:** Draft PR only, legacy `/` stays default. No automatic merge or preview mount in Docker.

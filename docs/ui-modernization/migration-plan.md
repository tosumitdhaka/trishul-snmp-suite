# Modern Operator UI — Migration and Validation Plan

**Status:** Draft for review — planning only
**Date:** 2026-10-09
**Decision source:** [Architecture](architecture.md) · [Design system](design-system.md)
**Non-negotiable:** Legacy `frontend/` stays functional and remains the default until an explicit release decision.

## Outcomes and success criteria

Ship a React/TypeScript operator console that improves discoverability, visual hierarchy, consistency, reliability and maintainability **without changing SNMP behavior** or surprising existing operators.

Success requires:
1. All seven workspaces reach feature parity for supported server capabilities and existing operator workflows.
2. Both light and dark modes pass accessibility and interaction checks.
3. No regression in authentication, WebSocket reactivity, MIB catalog performance, or destructive-operation safeguards.
4. New and old UIs coexist against the same backend; the default `/` interface remains unchanged through preview.
5. Release cutover is reversible by deployment rollback, without data migration.

No implementation starts merely because this document exists. Approve the architecture, inventory, quality gates and first implementation PR scope before moving to Stage 1.

## Delivery workflow and isolation

- **Documentation PR (this work):** `docs/modern-ui-architecture-plan`, docs only, branch from `main`. Review and merge independently.
- **Modern frontend work:** create narrow feature branches (for example, `feat/modern-ui-foundation` and `feat/modern-ui-dashboard`) after plan approval; do not use `main` or mutate legacy source in the foundation PR.
- **Legacy improvements:** continue independently in `frontend/` as required; PR #29 (command palette) is a separate, existing legacy enhancement and not a prerequisite for the modern stack.
- **Integration changes:** backend preview mount, Docker and CI adjustments must be small, separately reviewable, and gated. Do not modify default routing while enabling preview.
- **Evidence:** attach before/after screenshots in both themes, an endpoint/behavior checklist, automated-test results and any measured performance comparisons to each feature PR.
- **Project sources:** optional summary copies only; repository docs under `docs/ui-modernization/` are canonical.

## Stage 0 — Baseline and design approval (no runtime changes)

**Deliverables**
- Review and approve [architecture](architecture.md), [migration plan](migration-plan.md), and [design system](design-system.md).
- Inventory all controls and behaviors in the seven existing UI screens, including disabled states, errors, uploads/downloads, retention, reconnect, and pagination.
- Capture approved reference screenshots at desktop (1440px), tablet/laptop (1024px), and narrow mobile (390px) for light/dark.
- Confirm stable REST endpoints, WebSocket events, state persistence, and per-workspace acceptance scenarios.
- Record existing performance baselines: initial shell JS/CSS transfer, page load, MIB search on a large catalog, trap history rendering, and WebSocket recovery.
- Label issues/risks and designate severity classifications (release blockers versus polish).

**Exit gate:** reference feature inventory signed off; no unassigned high-risk API behavior or navigation gaps.

## Stage 1 — Parallel foundation

**Implementation scope**
- Bootstrap `frontend-next/` with React, strict TypeScript, Vite, routing, Tailwind, shadcn/ui/Radix, Lucide, linting, Vitest + Testing Library, and Playwright.
- Build API client with `X-Auth-Token`, session validation, sensible request timeouts and aborts, error normalization and typed responses.
- Build one WebSocket provider with reconnect/backoff, ping/pong, 4001 reauthentication and typed event dispatch; mock the API/WS in component tests.
- Add global error boundary, protected route shell, semantic status feedback, theme switch and command palette as shared primitives.
- Prepare isolated production output `frontend-next/dist`; new package files do not replace the legacy build.
- Integrate a test-only preview path at `/next/` after explicit review: mount before the root catch-all, restrict SPA fallback, verify no `/api` shadowing. Prefer exclusion from production images until preview authorization.

**Exit gate:** login/logout, refresh, direct routes, reload and 401/4001 handling work; backend regression tests pass; existing `/` UI unchanged; test suite and production build pass.

## Stage 2 — Shell, design primitives and dashboard

**Implementation scope**
- Reusable responsive shell: nav, page title, health/status strip, account actions, toast/confirmation/dialog standards, shortcut/command palette.
- Design-system tokens and UI components tested in both themes; main navigation works via keyboard and touch.
- Dashboard reads real `/api/meta`, `/api/stats/`, `/api/simulator/status`, `/api/traps/status`, `/api/mibs/status` and `/api/ws` events.
- Distinguish backend availability, simulator state, trap receiver state and WebSocket health. Make summary tiles meaningful instead of ornamental.
- Show loading, empty, degraded and offline states without showing stale counters as current.

**Exit gate:** dashboard parity and visual review in both modes and responsive widths; event updates, reconnect and page revisit validated; no critical a11y findings.

## Stage 3 — Workspace migration slices

Migrate one workspace at a time. Each slice should include UI, typed adapters, unit/component tests, realistic browser scenarios, keyboard/a11y, both themes and API/WS behavior before the next slice begins.

| Slice / recommended order | Core parity scenarios | Existing backend surface |
|---|---|---|
| **Settings** | Session/credentials rotation, app defaults, validation, reset/export confirmation, logged-out behavior | `/api/settings/*`, `/api/stats/`, `/api/meta` |
| **Simulator** | Start/stop/restart, status/log follow and pause, custom OID values, validation, reconnect, offline behavior | `/api/simulator/*`, `/api/ws` |
| **Walk & Parse** | Host/port/community, timeout/retry, run/cancel, parse/raw, table grouping, sorting, OID search, TSV/export, empty/error state | `/api/walk/execute`, `/api/mibs/resolve` |
| **Traps** | Listener lifecycle, trap/inform send, varbind edit, replay, decode, received-event pagination, filter/pause, clear/delete, CSV | `/api/traps/*`, MIB catalog endpoints, `/api/ws` |
| **MIB Browser** | Module/OID tree, ranked remote search, selection/detail, enum/range/size/bits, copy, cross-workspace jump, large catalog | `/api/mibs/browse/*`, `/api/mibs/resolve` |
| **MIB Manager** | Bundle/status inspection, source group and shadowing, validate/upload/reload, dependency fetch, diff/rollback, export/download/delete, errors | `/api/mibs/*` and bundle routes |

Dashboard is delivered in Stage 2; these six slices complete all seven workspaces.

**Rules**
- Compare the new UI with the current shipped legacy functionality, not merely the high-level docs; recent release features are easy to miss.
- Do not reintroduce client-side full-catalog fetch where the backend provides ranked capped search.
- For writes and destructive operations, compare actual result, returned errors, confirmation and invalidation behavior, not just button presence.
- Check values and units displayed by schema-aware MIB detail, decoded traps and parsed walks.
- Handle large result sets and logs without freezing UI; measure before adding virtual scrolling.
- A slice may ship behind preview without authorizing default-route cutover.

## Stage 4 — Integration and hardening

**Required automated checks**
- `tsc --noEmit`, lint and formatting validation
- Unit and component tests: validation, rendering, error states, auth, reconnect, table behavior
- API contract test using the current FastAPI OpenAPI output (fail on unexpected shape changes)
- WebSocket contract fixtures: `full_state`, `status`, `stats`, `mibs`, `trap`, `simulator_log`, ping/pong, expiry/reconnect
- Playwright smoke journeys across all seven workspaces, desktop/mobile and light/dark
- Existing backend `pytest` suite and targeted HTTP/WS integration tests when mounting new static routes
- Production build, container build, and real serving tests for `/`, `/next/`, `/api/*` and nested preview URLs
- Manual live-SNMP validation for stateful/UDP workflows in a controlled test setup; avoid mutations against production devices

**Nonfunctional release gates**
- Zero open P0/P1 regressions, data-loss issues, auth leaks or inaccessible critical actions.
- Keyboard-only task completion, focus visibility, form labeling and dialog semantics verified for all critical flows; WCAG 2.2 AA target in both themes.
- No significant unexplained performance regression against recorded Stage 0 baselines; if introduced, document remediation before cutover.
- No catastrophic slowdown with a realistic large MIB bundle, long trap history or sustained streaming log updates.
- Safe logout, refresh, expired-token recovery, offline handling, two-tab behavior, and return navigation to the legacy UI.
- Dependency licenses/audit and asset-loading behavior reviewed; no externally hosted critical scripts required.
- Every workspace has reproducible test evidence and has been reviewed on desktop, tablet and mobile.

**Release acceptance checklist**
- [ ] All dashboard and six workspace acceptance scenarios passed
- [ ] Both modes, responsiveness and accessibility validated
- [ ] Data fidelity, request/result semantics, uploads/downloads and destructive flows validated
- [ ] Auth, session expiry, WebSocket and reconnect behavior validated
- [ ] Build/test/container CI passed
- [ ] Operator-facing documentation and recovery notes updated
- [ ] Rollback successfully rehearsed
- [ ] Explicit owner/reviewer approval for default route switch

## Stage 5 — Controlled cutover (separate PR and release decision)

1. Capture the last release baseline and confirm all Stage 4 evidence.
2. Package **both** UI distributions and keep the legacy implementation deployable.
3. Switch `/` to modern UI and mount legacy under `/legacy/`; ensure direct legacy URLs, relative assets, hash navigation and auth work.
4. Start with a reversible deployment/config/image flag if supported by the reviewed integration; do not require SQLite migrations.
5. Validate health, login, pages, real-time events and export on the deployed image.
6. Monitor browser errors, startup failure, runtime status and operator feedback.
7. If a blocking regression is found, rollback to a known-good image/configuration that restores legacy `/` without data conversion.

**Cutover is not a feature branch side effect.** It requires a specific go/no-go decision.

## Stage 6 — Legacy retirement (later decision)

Keep `frontend/` and the legacy route for a documented validation window. Retire only after operational sign-off, no blocker reports, rollback retention requirements met, docs updated and a separate removal PR. No deletion is authorized by this plan.

## QA scenario matrix (minimum)

| Topic | Cases |
|---|---|
| Layout | 1440px / 1024px / 390px; narrow tables, browser zoom, long text, overflows |
| Themes | Initial render, persisted setting, toggle, each semantic state and data visualization |
| Keyboard | Tab order, Enter/Space, Escape, focus restoration, search shortcut, dialogs, tree/table controls |
| Sessions | Fresh login, refresh, shared-origin same-tab legacy→preview, independent tab login, expired REST token, WS 4001 |
| Connectivity | Backend offline at startup, WS disconnect, reconnect, stale snapshot, canceled requests, partial API failure |
| Runtime | Simulator start/stop/restart; receiver start/stop; live logs and traps; concurrent legacy/new sessions |
| Data | OID resolution, enum/units/constraints, large MIB catalog, trap pagination, walk sort/filter/export |
| Safety | Validation before writes; confirmed delete/clear/reset; secrets redacted; robust error messaging |
| Delivery | Local Vite proxy, built static preview, production-like container, deep-link refresh, missing assets 404 |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Backend catch-all swallows `/next` requests | Ordered explicit preview mount; HTML-only fallback; route integration tests |
| Legacy UI accidentally modified | Separate `frontend-next/` project and PR diff guard; retain default build path |
| Two UIs cause auth/session confusion | Validate token on bootstrap; standalone login; clear cache on expiry; same-tab compatibility checks |
| Duplicate websocket state and stale cache | Single provider per application; bounded queues; typed event→query invalidations; reconnect tests |
| Large catalogs/logs freeze interface | Backend ranked search, pagination, measured virtualization, cancelation and capped in-memory logs |
| Incomplete feature parity | Signed scenario inventory per workspace; acceptance matrix and deliberate destructive-flow tests |
| Theme drift/accessibility debt | Shared tokens and reviewed primitives; light/dark automated and manual visual checks |
| Release rollback impossible | Keep legacy artifact and old image; test reverse route switch without schema changes |

## Immediate next steps (after this docs PR review)

1. Approve architecture and route/coexistence decisions.
2. Build the detailed feature-parity inventory and baseline screenshots (Stage 0).
3. Open **Stage 1 foundation PR** with only scaffolding, auth, API/WS adapters and test plumbing.
4. Only after foundation gates pass, begin the new shell and dashboard (Stage 2).

**Explicitly out of scope:** backend rewrite, SNMPv3 enablement, new SNMP semantics, SQLite migration, production route cutover, automatic removal of the Bootstrap UI, and an unsolicited redesign of the legacy interface.

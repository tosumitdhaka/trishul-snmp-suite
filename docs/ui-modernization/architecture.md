# Modern Operator UI — Architecture Decision Record

**Status:** Proposed for review (overall direction approved; implementation specifics gated)
**Date:** 2026-10-09
**Scope:** Frontend architecture and coexistence; no backend rewrite
**Related:** [Migration plan](migration-plan.md) · [Design system](design-system.md) · [Current runtime architecture](../architecture_overview.md) · [API reference](../api_reference.md)

## Decision

Develop a second operator frontend in parallel using **React + TypeScript + Vite**, **Tailwind CSS**, **shadcn/ui (Radix-based primitives)**, **React Router**, **TanStack Query**, **TanStack Table**, and **Lucide**. Keep the current Bootstrap/vanilla-JavaScript UI intact and serving operators until the replacement passes documented functional, operational, and accessibility gates.

The existing **FastAPI + SQLite + trishul-smi/trishul-snmp** backend remains authoritative. Both interfaces use the existing `/api/...` REST contracts and `/api/ws` WebSocket protocol. This project does **not** introduce a second API, migrate backend state, or reimplement SNMP logic in the browser.

The preferred visual direction is a **light-first network operations console**, with dark mode held to the same usability and accessibility standard.

## Verified baseline (main branch)

| Existing behavior | Repository source |
|---|---|
| Current release UI sources and static build live in `frontend/`, output `frontend/dist/` | `frontend/build-frontend.mjs` |
| FastAPI includes API routers before mounting the legacy UI at `/` | `backend/app/main.py` |
| FastAPI uses an SPA-style fallback on the root static mount | `backend/app/main.py` |
| Login creates a session token; authenticated REST uses `X-Auth-Token` | `backend/app/api/routes/settings.py`, `frontend/js/app.js` |
| Legacy token is stored in tab-scoped `sessionStorage` as `snmp_token` | `frontend/js/app.js` |
| WebSocket URL is `/api/ws?token=<token>`; client pings and receives typed events | `frontend/js/modules/ws-client.js`, `backend/app/api/routes/ws.py` |
| Existing UI has seven workspaces and hash-based navigation | `frontend/index.html`, `docs/workspaces.md` |
| Docker currently builds and packages exactly one frontend distribution | `Dockerfile` |

`/next/` is a **proposed future preview route**, not a route currently provided by the backend.

## Operating model

```text
                       Trishul SNMP Suite (one origin)
                                  |
                     FastAPI (one application)
                     /api/*       /api/ws
                        |             |
                   shared backend services
                   SNMP runtime / SQLite / bundles
                        ^
                        | current API contracts
                +-------+------------------+
                |                          |
          Legacy UI                   Modern UI
      Bootstrap + vanilla JS     React + TypeScript
      / (current default)        /next/ (preview)
      frontend/dist              frontend-next/dist
                |                          |
          independently built & deployed static bundles
```

**No iframes, no framework interop inside the old UI, no cross-origin production preview server.** Each UI is its own standalone static application consuming the same API.

## Proposed repository boundaries

```text
frontend/                            # legacy; stays unchanged during migration
  index.html
  css/ js/ *.html
  build-frontend.mjs
  dist/                              # existing artifact

frontend-next/                       # NEW, implementation-phase only
  src/
    app/                             # providers, router, boot, error boundary
    components/ui/                   # shadcn primitives, locally owned
    components/shell/                # navigation, status, dialogs, command palette
    features/
      dashboard/
      simulator/
      walker/
      traps/
      mib-browser/
      mib-manager/
      settings/
    lib/
      api/                           # typed HTTP client, error model, OpenAPI types
      realtime/                      # single WebSocket connection + event adapter
      auth/                          # login, session validation, logout
      theme/                         # light/dark/OS preference
    styles/                          # tokens and Tailwind entry
  public/
  tests/
  package.json
  vite.config.ts
  dist/                              # NEW independent build artifact

backend/app/main.py                  # only changes later for preview static mount
Dockerfile                           # only changes later to optionally ship both
docs/ui-modernization/               # architecture, migration and design contract
```

Keep imports within feature boundaries unless intentionally exported from `components/` or `lib/`. No broad stateful singleton or direct network calls from presentational components.

## Coexistence and routing contract

1. **Before preview integration:** legacy stays at `/` with the same HTML, scripts, assets, and hash routes; the new frontend can run separately in local development.
2. **Preview integration proposal:** build `frontend-next/dist` with Vite `base: '/next/'`; mount it at `/next` (with canonical navigation to `/next/`), **before** the catch-all legacy `/` mount. Configure React Router's basename as `/next`.
3. Keep `/api/*`, `/api/ws`, `/docs` and other backend routes matched before either static mount.
4. Preview SPA fallback applies only to **HTML navigation** within `/next/*`; nonexistent JS/CSS/image paths must return a real 404, not `index.html`.
5. Direct navigation, refresh, nested routes, browser back/forward, accessibility landmarks, and asset caching must work from the preview prefix.
6. Deploy the preview **disabled by default or not included in release images** until approved for a controlled preview. How it is enabled is an implementation-stage configuration decision that requires security review.
7. The modern frontend must never alter, override, or import the legacy styles and JavaScript. A broken preview route must not affect `/`.
8. **Cutover (separate decision):** after all gates, serve the new UI at `/` and preserve the complete legacy bundle under `/legacy/` for a rollback window. Confirm that legacy relative asset URLs and hash routing work under that prefix. Reversal must be a configuration/image rollback without database migration.

The existing root SPA catch-all means mount order and fallback behavior require explicit backend integration tests. Never assume static mounts are automatically isolated.

## Application layers

| Layer | Responsibility | Rules |
|---|---|---|
| UI primitives | Inputs, dialogs, menus, tooltips, tables, charts where warranted | Accessible by default; consistent tokens; no business logic |
| Feature components | Screen-specific workflows and validation | Group by workspace; isolate mutation side effects |
| Routing | Navigation, links, route errors, guarded pages | Seven workspaces; URL is shareable; do not invent unsupported routes |
| API client | REST requests, auth header, typed parsing, abort support, error normalization | One client; preserve server field names and semantics |
| TanStack Query | Fetch cache, refetch/invalidation, optimistic updates only where safe | Server state is NOT copied into a general-purpose global store |
| WebSocket adapter | One app-level connection, validated event types, reconnection/backoff and cache updates | Handle `full_state`, `status`, `stats`, `mibs`, `trap`, `simulator_log`; ping/pong and 4001 |
| Local UI state | Filters, selection, drawer state, unsaved edits, theme | Stay feature-local or URL-backed; avoid unnecessary state libraries |
| Auth boundary | Login, session validation, logout, expiry | Same backend semantics; protect private routes; clear private cache on logout |

Prefer **OpenAPI-derived TypeScript contracts**, reviewed and committed or reproducibly generated against the pinned backend schema. Add hand-authored adapters for legacy response quirks rather than scattering `any` throughout components. Do not automatically write schema changes into backend code.

## Authentication and state isolation

- Preserve server-side session and credential rules. For same-tab compatibility with the current UI, the modern frontend may read the existing `sessionStorage` token key (`snmp_token`), validate it through `/api/settings/check`, and fall back to its own login screen when invalid or missing.
- Different tabs do not necessarily share a session token; each UI must support an independent login. Do not assume shared local storage means shared authentication.
- Attach `X-Auth-Token` only to the intended same-origin API requests. Handle REST 401 and WebSocket close code 4001 as session expiry/reauth; cancel queries, disconnect sockets, clear sensitive caches, and navigate to login.
- WebSocket query-string authentication is an **existing backend contract**, not a new security design endorsement. Do not log full WebSocket URLs, tokens, community strings, trap credentials, or SNMP payload secrets. Review a future credential transport change separately.
- Keep theme preference distinct from authentication. Preserve optional `trishul_theme` interoperability without importing legacy CSS.
- Concurrent tabs are permitted; both UIs operate on the same backend objects. Mutations must trigger cache invalidations and/or event-driven refresh. Do not model operational state as independently writable browser state.

## Realtime and data-heavy workspaces

- Build a connection-state model: connecting, live, reconnecting, offline, unauthorized. Use explicit status text and timestamps, never color alone.
- Preserve the current server event taxonomy; treat `full_state` as a reset snapshot and later events as targeted updates. Guard against stale responses during navigation or reconnects.
- Support bounded logs, trap pagination, request cancellation, safe polling fallback, and pause/follow controls where currently present.
- Prefer server-side search for large MIB catalogs; do **not** download an entire catalog just to search. Use virtualized rows/tree rendering only where profiling justifies it.
- Keep unsaved forms stable during incidental live updates; differentiate connectivity loss from an empty dataset.
- Preserve downloads/exports, byte-encoded values, OID symbolic/numeric resolution, constraints/enums, and error details exactly as defined by the backend.

## Security, quality, and operability

- No `dangerouslySetInnerHTML` for untrusted MIB descriptions, trap payloads, logs, or API errors. Escape text by default.
- Follow WCAG 2.2 AA where applicable, including visible focus, dialog focus handling, keyboard navigation, reduced motion and sufficient contrast in **both** themes.
- Prefer native browser controls and Radix primitives for interactive accessibility. Do not use clickable `div`s where links/buttons exist.
- Include loading, empty, partially stale, reconnecting and failed states in every feature; distinguish destructive operations with confirmation and explicit feedback.
- The production build should bundle its critical UI dependencies rather than depending on CDN access.
- Pin package/toolchain versions at scaffolding time; use a lockfile, dependency audit and build reproduction in CI.
- Minimum automated gates: TypeScript check, lint, unit/component tests, API contract tests, production build, browser smoke, backend regression suite on integration changes, and checked light/dark screenshots.

## Tradeoffs and alternatives

| Choice | Why |
|---|---|
| Incremental parallel frontend instead of in-place rewrite | Protects the deployed UI and enables page-by-page parity testing |
| React + TypeScript instead of extending vanilla JS | Component reuse, static contracts, maintainable state and tests across complex workflows |
| Vite instead of a server-rendered React framework | Existing FastAPI already provides APIs and serves static files; no need for a second application server |
| Tailwind + shadcn/ui instead of a second Bootstrap layer | Ownership of accessible primitives and semantic theming without global CSS interference |
| Keep FastAPI REST/WebSocket interfaces | Avoids coupling UI modernization to runtime/protocol migrations |

Costs: two frontend builds temporarily, duplicate presentation code during migration, more CI checks, and potential package bundle growth. These are accepted **temporarily**, with an explicit retirement plan.

## Deferred decisions requiring review

- Preview enablement mechanism (build-time inclusion versus explicit backend setting) and which environments expose `/next/`.
- Final palette/color token approval after design prototypes and contrast evaluation.
- Generated OpenAPI type tooling and API-contract verification method.
- Deployment cutover window and legacy retention period; no date is committed.
- Any eventual auth modernization (cookies / WebSocket authentication) is out of scope for this migration.

**Guardrail:** No automatic cutover, legacy source deletion, backend schema migration, or release-image switch happens merely because the modern dashboard is complete.
